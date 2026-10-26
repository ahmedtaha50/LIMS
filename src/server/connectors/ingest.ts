// The ingestion core of instrument data capture (roadmap M21): one function turns a file of an approved profile into a register row
// and staged values, whether the file came from a watched folder or from an upload. The caller decides what happens to the source.
//
//   1. the content is streamed into the blob store and hashed (the file as received, never altered; BLOB_DIR/<sha256>);
//   2. a sha256 that is already registered is refused and audited (DuplicateRefused) - the same export cannot be captured twice;
//   3. the instrument must be Active and within calibration: otherwise the file is registered as Failed with that reason (the raw
//      file is kept, no value is staged);
//   4. a dry run parses the file with the profile's parser and mapping; a ParseError makes the file Failed with a readable message;
//   5. in ONE transaction: the file row, the staged values, the usage-log row, the audit entry (and, for a Failed file, the event
//      instrument.import_failed that notifies the analysts).
// Nothing here writes a result: values become results only when a named analyst accepts them (routes/instrument-files.ts).
import { randomBytes } from 'crypto';
import fs from 'fs';
import type { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { instrumentFiles, instrumentImportRows, instrumentProfiles, instrumentUsageLog, instruments } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { calibrationState } from '../../lib/validations/instruments';
import { blobDir, blobPath, maxAttachmentBytes, stageBlob } from '../blobs';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { emitEvent } from '../events/emit';
import { AppError } from '../http/errors';
import { ParseError, parseInstrumentFile } from '../parsers';

/** Instrument exports are small text files; a bigger one is a mistake (or not an export) and is refused before it is read into memory. */
export const INSTRUMENT_FILE_MAX_BYTES = 5 * 1024 * 1024;

type FileRow = typeof instrumentFiles.$inferSelect;

export type IngestOutcome =
  | { status: 'Captured'; file: FileRow; rowCount: number }
  | { status: 'Failed'; file: FileRow; message: string }
  | { status: 'Duplicate'; existing: FileRow };

const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';
const chunks = <T>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

export async function ingestFile(db: Db, input: {
  profileId: string;
  fileName: string;
  source: 'watch' | 'upload';
  content: Readable | AsyncIterable<Buffer>;
  actorId: string;
  /** An upload has no folder to move the file out of, so it is final at once; a watched file stays Pending until it has been moved. */
  finalDisposition: boolean;
  now?: Date;
}): Promise<IngestOutcome> {
  const now = input.now ?? new Date();
  const [profile] = await db.select().from(instrumentProfiles).where(eq(instrumentProfiles.id, input.profileId)).limit(1);
  if (!profile) throw new AppError(404, 'NOT_FOUND', `Capture profile ${input.profileId} was not found.`);
  if (profile.status !== 'Approved') {
    throw new AppError(409, 'PROFILE_NOT_APPROVED', `Capture profile ${profile.name} is ${profile.status}: only an approved profile captures data.`);
  }

  const staged = await stageBlob(input.content, { dir: blobDir(), maxBytes: Math.min(maxAttachmentBytes(), INSTRUMENT_FILE_MAX_BYTES) });
  try {
    if (staged.bytes === 0) throw new AppError(400, 'EMPTY_FILE', `${input.fileName} is empty.`);
    const [existing] = await db.select().from(instrumentFiles).where(eq(instrumentFiles.sha256, staged.sha256)).limit(1);
    if (existing) return await refuseDuplicate(db, input, existing, staged.sha256);
    await staged.commit();
  } catch (e) {
    await staged.discard();
    throw e;
  }

  const [inst] = await db.select().from(instruments).where(eq(instruments.id, profile.instrumentId)).limit(1);
  let failure: string | null = null;
  let parsed: ReturnType<typeof parseInstrumentFile> = [];
  if (!inst) failure = `Instrument ${profile.instrumentId} does not exist.`;
  else if (inst.status !== 'Active') failure = `Instrument ${inst.id} (${inst.name}) is ${inst.status}: its data is not captured.`;
  else if (calibrationState(inst.calibrationDueDate, now).expired) {
    failure = `Instrument ${inst.id} (${inst.name}) is past its calibration due date (${inst.calibrationDueDate}): its data is not captured.`;
  } else {
    try {
      parsed = parseInstrumentFile(profile.parser, profile.mapping, await fs.promises.readFile(blobPath(blobDir(), staged.sha256), 'utf8'));
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      failure = e.message;
    }
  }

  const file = {
    id: `IMF-${randomBytes(6).toString('hex')}`, profileId: profile.id, instrumentId: profile.instrumentId, fileName: input.fileName, source: input.source,
    sha256: staged.sha256, bytes: staged.bytes, parseStatus: failure ? 'Failed' : 'Parsed', parseError: failure, rowCount: parsed.length,
    disposition: input.finalDisposition ? (failure ? 'Error' : 'Processed') : 'Pending', dispositionNote: null as string | null,
    receivedBy: input.actorId, receivedAt: now, version: 1,
  };
  try {
    await withTransaction(db, async (tx, afterCommit) => {
      await tx.insert(instrumentFiles).values(file);
      for (const part of chunks(parsed, 500)) {
        await tx.insert(instrumentImportRows).values(part.map(r => ({
          id: `IMR-${randomBytes(6).toString('hex')}`, fileId: file.id, lineNo: r.line, sampleRef: r.sampleRef, parameter: r.parameter,
          value: r.value, unit: r.unit, raw: r.raw, state: 'Pending', version: 1,
        })));
      }
      if (!failure) {
        await tx.insert(instrumentUsageLog).values({
          id: `IUL-${randomBytes(6).toString('hex')}`, instrumentId: file.instrumentId, event: 'DataCaptured', fileId: file.id, userId: input.actorId, at: now,
        });
      }
      const { receivedAt: _t, ...stated } = file;
      await writeAudit(tx, input.actorId, 'Create', 'InstrumentFile', file.id, 'all', '', JSON.stringify(stated),
        failure ? `Instrument file ${input.fileName} captured but not readable: ${failure}`
          : `Instrument file ${input.fileName} captured from ${inst!.id} (${parsed.length} value(s) staged for acceptance)`);
      if (failure) {
        await emitEvent(tx, {
          type: 'instrument.import_failed', payload: { fileId: file.id, fileName: input.fileName, instrumentId: file.instrumentId, problem: failure },
          entity: 'InstrumentFile', entityId: file.id, actorId: input.actorId,
        }, afterCommit);
      }
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const [other] = await db.select().from(instrumentFiles).where(eq(instrumentFiles.sha256, staged.sha256)).limit(1);
    if (!other) throw e;
    return refuseDuplicate(db, input, other, staged.sha256); // lost a race with the same content captured a moment ago
  }
  return failure ? { status: 'Failed', file: file as FileRow, message: failure } : { status: 'Captured', file: file as FileRow, rowCount: parsed.length };
}

async function refuseDuplicate(db: Db, input: { fileName: string; actorId: string; profileId: string }, existing: FileRow, sha256: string): Promise<IngestOutcome> {
  await withTransaction(db, tx => writeAudit(tx, input.actorId, 'DuplicateRefused', 'InstrumentFile', existing.id, 'sha256', sha256, sha256,
    `Refused ${input.fileName} for profile ${input.profileId}: identical content (sha256 ${sha256}) was already captured as ${existing.id} (${existing.fileName}).`));
  return { status: 'Duplicate', existing };
}

/** Records where a captured file went (Processed or Error), with its audit entry. Idempotent for the same disposition. */
export async function markDisposition(db: Db, fileId: string, actorId: string, disposition: 'Processed' | 'Error', note: string) {
  await withTransaction(db, async (tx) => {
    const row = await lockRow(tx, instrumentFiles, fileId);
    if (row.disposition === disposition) return;
    await updateVersioned(tx, instrumentFiles, fileId, row.version, { disposition, dispositionNote: note });
    await writeAudit(tx, actorId, 'Move', 'InstrumentFile', fileId, 'disposition', row.disposition, disposition, note);
  });
}
