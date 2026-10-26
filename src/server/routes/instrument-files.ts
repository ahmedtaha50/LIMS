// Domain: captured instrument files, staged values, their acceptance and the usage log (roadmap M21). Owned by r2-instrument-integration.
//
//   POST /instrument-files?profileId&fileName   a file handed in by hand (the body is the file, application/octet-stream): the same
//                                               ingestion as the folder agent. 201 {status: Captured|Failed, file, ...}; identical content
//                                               already captured: 409 DUPLICATE_FILE (audited). Analyst and Admin
//   GET  /instrument-files                     the newest files (parse status, readable error, where the file went)
//   GET  /instrument-files/:id                  one file with its staged values
//   GET  /instrument-files/:id/content          the file as received, after re-hashing it (409 and an audit entry when it no longer matches)
//   GET  /instrument-imports?state&sampleId     staged values (default: waiting for acceptance) with the result each would update
//   POST /instrument-imports/:id/accept         a named analyst accepts a value: it is written through saveResult (all result rules apply:
//                                               entry roles, Testing state, calibrated instrument, guards, OOS, result version) with its
//                                               source recorded (result_sources); the source file is attached as raw data
//   POST /instrument-imports/:id/reject         a staged value is not used, with a reason
//   GET  /instruments/:id/usage-log             captures and accepted values of an instrument
//   GET  /samples/:id/result-sources            where the results of a sample came from (file, sha256, who accepted)
//
// A captured value is never a result until accepted; the sample cannot go to review while one names it (transition guard
// unaccepted-imports). Who may call what is in src/server/authz/routeTable.ts.
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { pipeline } from 'stream/promises';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { attachments, instrumentFiles, instrumentImportRows, instrumentProfiles, instrumentUsageLog, instruments, resultSources, results, samples, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { RESULT_ENTRY_ROLES } from '../../lib/constants/results';
import { RESULT_CHANGE_CODES } from '../services/result-hooks/codes';
import { blobDir, detectKind, openBlob, verifyBlob, BlobTooLargeError, maxAttachmentBytes } from '../blobs';
import { INSTRUMENT_FILE_MAX_BYTES, ingestFile } from '../connectors/ingest';
import { type Db, type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { saveResult } from '../services/saveResult';

// ---- request schemas -------------------------------------------------------------------------------------------------------------

const expectedVersion = z.number('expectedVersion must be a number').int().positive('Record version mismatch. Refresh required.');
const reason = z.string('A reason is required.').trim().min(5, 'A clear reason is required (at least 5 characters, ALCOA+).').max(1000);

/** Query of POST /instrument-files. The person, time, hash and size are the server's. */
export const instrumentUploadQuerySchema = z.object({
  profileId: z.string().trim().min(1, 'profileId is required.').max(100),
  fileName: z.string('fileName is required.').trim().min(1, 'fileName is required.').max(255, 'fileName is too long (at most 255 characters).')
    .refine(n => !/[\\/\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..', 'fileName must be a plain file name (no folder, no control character).'),
}).strict();
export const instrumentImportsQuerySchema = z.object({
  state: z.enum(['Pending', 'Accepted', 'Rejected']).default('Pending'),
  sampleId: z.string().trim().min(1).max(100).optional(),
}).strict();
export const importAcceptSchema = z.object({
  expectedVersion,
  /** Needed when the value names no sample, or the analyst chooses another result of the same sample; else the result named by the value. */
  resultId: z.string().trim().min(1).max(100).optional(),
  expectedResultVersion: z.number('expectedResultVersion must be a number').int().positive('Result version mismatch. Refresh required.'),
  reason: reason.optional(),
  reasonCode: z.enum(RESULT_CHANGE_CODES).optional(),
  oosId: z.string().trim().min(1).max(100).optional(),
}).strict();
export const importRejectSchema = z.object({ expectedVersion, reason }).strict();

// ---- helpers -----------------------------------------------------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const presentFile = (f: typeof instrumentFiles.$inferSelect) => ({ ...f, receivedAt: f.receivedAt.toISOString() });
const presentRow = (r: typeof instrumentImportRows.$inferSelect) => ({ ...r, decidedAt: iso(r.decidedAt) });
const requireEntryRole = (user: { role: string }, what: string) => {
  if (!RESULT_ENTRY_ROLES.includes(user.role)) throw new ForbiddenError(`Forbidden: ${what} by ${RESULT_ENTRY_ROLES.join(' or ')}, who enter the results.`);
};

async function integrityFailure(db: Db, userId: string, file: typeof instrumentFiles.$inferSelect, problem: string) {
  await withTransaction(db, tx => writeAudit(tx, userId, 'IntegrityCheckFailed', 'InstrumentFile', file.id, 'sha256', file.sha256, problem,
    `Refused: ${file.fileName} registered with sha256 ${file.sha256}; ${problem}.`));
}

export const instrumentFilesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/instrument-files', requireAuth, validate(instrumentUploadQuerySchema, 'query'), async (req: Request, res) => {
    const user = (req as any).user as { id: string; role: string };
    const q = req.query as unknown as z.infer<typeof instrumentUploadQuerySchema>;
    requireEntryRole(user, 'an instrument file is handed in');
    if (!req.is('application/octet-stream')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file itself as the request body with Content-Type: application/octet-stream.');
    }
    const limit = Math.min(maxAttachmentBytes(), INSTRUMENT_FILE_MAX_BYTES);
    const declared = Number(req.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > limit) throw new BlobTooLargeError(limit);
    const outcome = await ingestFile(db, { profileId: q.profileId, fileName: q.fileName, source: 'upload', content: req, actorId: user.id, finalDisposition: true });
    if (outcome.status === 'Duplicate') {
      throw new AppError(409, 'DUPLICATE_FILE', `${q.fileName} has the same content (sha256 ${outcome.existing.sha256}) as ${outcome.existing.fileName}, already captured as ${outcome.existing.id}. The refusal is recorded in the audit trail.`);
    }
    res.status(201).json(outcome.status === 'Failed'
      ? { status: 'Failed', file: presentFile(outcome.file), message: outcome.message }
      : { status: 'Captured', file: presentFile(outcome.file), rowCount: outcome.rowCount });
  });

  router.get('/instrument-files', requireAuth, async (_req, res) => {
    const rows = await db.select({ f: instrumentFiles, profileName: instrumentProfiles.name, instrumentName: instruments.name })
      .from(instrumentFiles).innerJoin(instrumentProfiles, eq(instrumentProfiles.id, instrumentFiles.profileId))
      .innerJoin(instruments, eq(instruments.id, instrumentFiles.instrumentId)).orderBy(desc(instrumentFiles.receivedAt), desc(instrumentFiles.id)).limit(200);
    const ids = rows.map(r => r.f.id);
    const pending = ids.length ? await db.select({ fileId: instrumentImportRows.fileId, n: sql<number>`count(*)::int` }).from(instrumentImportRows)
      .where(and(inArray(instrumentImportRows.fileId, ids), eq(instrumentImportRows.state, 'Pending'))).groupBy(instrumentImportRows.fileId) : [];
    const pendingOf = new Map(pending.map(p => [p.fileId, p.n]));
    res.json(rows.map(r => ({ ...presentFile(r.f), profileName: r.profileName, instrumentName: r.instrumentName, pendingRows: pendingOf.get(r.f.id) ?? 0 })));
  });

  router.get('/instrument-files/:id', requireAuth, async (req, res) => {
    const [file] = await db.select().from(instrumentFiles).where(eq(instrumentFiles.id, String(req.params.id))).limit(1);
    if (!file) throw new NotFoundError(`Instrument file ${req.params.id} was not found.`);
    const rows = await db.select().from(instrumentImportRows).where(eq(instrumentImportRows.fileId, file.id)).orderBy(instrumentImportRows.lineNo);
    res.json({ file: presentFile(file), rows: rows.map(presentRow) });
  });

  router.get('/instrument-files/:id/content', requireAuth, async (req, res) => {
    const user = (req as any).user as { id: string };
    const [file] = await db.select().from(instrumentFiles).where(eq(instrumentFiles.id, String(req.params.id))).limit(1);
    if (!file) throw new NotFoundError(`Instrument file ${req.params.id} was not found.`);
    const check = await verifyBlob(blobDir(), file.sha256);
    if (!check.ok) {
      const problem = check.problem === 'missing' ? 'the file is missing from the blob store' : `the stored file hashes to ${check.actual}`;
      await integrityFailure(db, user.id, file, problem);
      throw new AppError(409, 'INSTRUMENT_FILE_INTEGRITY_FAILED', `${file.fileName} cannot be released: ${problem}, not to its registered sha256 ${file.sha256}. The event is recorded in the audit trail; restore the file from a backup.`);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(check.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('X-Content-SHA256', file.sha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(openBlob(blobDir(), file.sha256), res);
  });

  router.get('/instrument-imports', requireAuth, validate(instrumentImportsQuerySchema, 'query'), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof instrumentImportsQuerySchema>;
    const where = [eq(instrumentImportRows.state, q.state)];
    if (q.sampleId) where.push(eq(instrumentImportRows.sampleRef, q.sampleId));
    const rows = await db.select({ r: instrumentImportRows, fileName: instrumentFiles.fileName, instrumentId: instrumentFiles.instrumentId, sha256: instrumentFiles.sha256 })
      .from(instrumentImportRows).innerJoin(instrumentFiles, eq(instrumentFiles.id, instrumentImportRows.fileId))
      .where(and(...where)).orderBy(desc(instrumentFiles.receivedAt), instrumentImportRows.lineNo).limit(500);
    // The result each value would update: the result of the named sample with the same parameter.
    const refs = [...new Set(rows.map(r => r.r.sampleRef).filter((s): s is string => !!s))];
    const candidates = refs.length ? await db.select({ id: results.id, sampleId: results.sampleId, parameter: results.parameter, value: results.value, version: results.version, unit: results.unit, state: samples.state })
      .from(results).innerJoin(samples, eq(samples.id, results.sampleId)).where(inArray(results.sampleId, refs)) : [];
    const key = (sampleId: string, parameter: string) => `${sampleId}\u0000${parameter.trim().toLowerCase()}`;
    const byKey = new Map(candidates.map(c => [key(c.sampleId, c.parameter), c]));
    res.json(rows.map(({ r, fileName, instrumentId, sha256 }) => {
      const m = r.sampleRef ? byKey.get(key(r.sampleRef, r.parameter)) : undefined;
      return { ...presentRow(r), fileName, instrumentId, sha256, match: m ? { resultId: m.id, sampleId: m.sampleId, value: m.value, version: m.version, unit: m.unit, sampleState: m.state } : null };
    }));
  });

  router.post('/instrument-imports/:id/accept', requireAuth, validate(importAcceptSchema), async (req, res) => {
    const user = (req as any).user as { id: string; role: string };
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof importAcceptSchema>;
    requireEntryRole(user, 'a captured value is accepted');

    // The file must still be what was captured: the value is only as good as the bytes it was read from.
    const [head] = await db.select({ r: instrumentImportRows, f: instrumentFiles }).from(instrumentImportRows)
      .innerJoin(instrumentFiles, eq(instrumentFiles.id, instrumentImportRows.fileId)).where(eq(instrumentImportRows.id, id)).limit(1);
    if (!head) throw new NotFoundError(`Captured value ${id} was not found.`);
    const check = await verifyBlob(blobDir(), head.f.sha256);
    if (!check.ok) {
      const problem = check.problem === 'missing' ? 'the file is missing from the blob store' : `the stored file hashes to ${check.actual}`;
      await integrityFailure(db, user.id, head.f, problem);
      throw new AppError(409, 'INSTRUMENT_FILE_INTEGRITY_FAILED', `${head.f.fileName} no longer matches its registered sha256: ${problem}. Its values cannot be accepted.`);
    }

    const out = await withTransaction(db, async (tx, afterCommit) => {
      const row = await lockRow(tx, instrumentImportRows, id);
      if (row.state !== 'Pending') throw new AppError(409, 'IMPORT_ALREADY_DECIDED', `This value was already ${row.state.toLowerCase()}.`);
      if (row.version !== b.expectedVersion) throw new ConflictError();
      const [file] = await tx.select().from(instrumentFiles).where(eq(instrumentFiles.id, row.fileId)).limit(1);

      let resultId = b.resultId;
      if (!resultId) {
        if (!row.sampleRef) throw new BadRequestError('This value names no sample: give the resultId it belongs to.');
        const found = await tx.select({ id: results.id }).from(results)
          .where(and(eq(results.sampleId, row.sampleRef), sql`lower(btrim(${results.parameter})) = ${row.parameter.trim().toLowerCase()}`)).limit(2);
        if (found.length === 0) throw new BadRequestError(`Sample ${row.sampleRef} has no result for the parameter "${row.parameter}": give the resultId it belongs to, or reject the value.`);
        if (found.length > 1) throw new BadRequestError(`Sample ${row.sampleRef} has several results named "${row.parameter}": give the resultId.`);
        resultId = found[0].id;
      }
      const [target] = await tx.select().from(results).where(eq(results.id, resultId)).limit(1);
      if (!target) throw new NotFoundError(`Result ${resultId} was not found.`);
      // A value that names a sample is accepted only into that sample: an analyst cannot move a measurement onto another sample.
      if (row.sampleRef && row.sampleRef !== target.sampleId) {
        throw new BadRequestError(`This value was measured for sample ${row.sampleRef}; result ${resultId} belongs to sample ${target.sampleId}.`);
      }
      if (row.unit && target.unit && row.unit.trim().toLowerCase() !== target.unit.trim().toLowerCase()) {
        throw new BadRequestError(`Unit mismatch: the instrument reported ${row.unit}, the result is entered in ${target.unit}. Reject the value or correct the profile mapping.`);
      }

      const saved = await saveResult({
        tx, afterCommit, user, sampleId: target.sampleId, resultId,
        input: {
          value: row.value, expectedVersion: b.expectedResultVersion, instrumentId: file.instrumentId, reasonCode: b.reasonCode, oosId: b.oosId,
          reason: b.reason ?? `Accepted from instrument file ${file.fileName} (sha256 ${file.sha256.slice(0, 12)}), line ${row.lineNo}`,
        },
      });
      const decided = await updateVersioned(tx, instrumentImportRows, id, b.expectedVersion, { state: 'Accepted', resultId, decidedBy: user.id, decidedAt: new Date(), decisionReason: b.reason ?? null });
      await tx.insert(resultSources).values({
        id: `RSR-${randomBytes(6).toString('hex')}`, resultId, resultVersion: saved.version, source: 'instrument', fileId: file.id, importRowId: id,
        sha256: file.sha256, acceptedBy: user.id,
      });
      await tx.insert(instrumentUsageLog).values({
        id: `IUL-${randomBytes(6).toString('hex')}`, instrumentId: file.instrumentId, event: 'ResultAccepted', fileId: file.id, sampleId: target.sampleId, resultId, userId: user.id,
      });
      await writeAudit(tx, user.id, 'Accept', 'InstrumentImportRow', id, 'state', 'Pending', 'Accepted',
        b.reason ?? `Value of ${row.parameter} from ${file.fileName} line ${row.lineNo} accepted as result ${resultId} of sample ${target.sampleId}`);

      // The captured file is the raw data of this result: attach it, so the review checklist finds it (same register, same blob).
      const [already] = await tx.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.resultId, resultId), eq(attachments.sha256, file.sha256))).limit(1);
      if (!already) {
        const media = detectKind(await headOf(file.sha256), file.fileName, file.bytes <= 8192);
        if (media.ok) {
          const att = {
            id: `att-${randomBytes(8).toString('hex')}`, sampleId: target.sampleId, resultId, fileName: file.fileName, mediaType: media.value.mediaType, kind: media.value.kind,
            bytes: file.bytes, sha256: file.sha256, description: `Instrument file ${file.id}`, uploadedBy: user.id, uploadedAt: new Date(),
          };
          await tx.insert(attachments).values(att);
          await writeAudit(tx, user.id, 'Create', 'Attachment', att.id, 'all', '', JSON.stringify({
            sampleId: att.sampleId, resultId, fileName: att.fileName, mediaType: att.mediaType, bytes: att.bytes, sha256: att.sha256,
          }), `Instrument file ${file.fileName} attached as raw data of result ${resultId}`);
        }
      }
      return { row: decided, result: saved };
    });
    res.json({ row: presentRow(out.row), result: out.result });
  });

  router.post('/instrument-imports/:id/reject', requireAuth, validate(importRejectSchema), async (req, res) => {
    const user = (req as any).user as { id: string; role: string };
    const id = String(req.params.id);
    const b = req.body as z.infer<typeof importRejectSchema>;
    requireEntryRole(user, 'a captured value is rejected');
    const row = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, instrumentImportRows, id);
      if (current.state !== 'Pending') throw new AppError(409, 'IMPORT_ALREADY_DECIDED', `This value was already ${current.state.toLowerCase()}.`);
      const updated = await updateVersioned(tx, instrumentImportRows, id, b.expectedVersion, { state: 'Rejected', decidedBy: user.id, decidedAt: new Date(), decisionReason: b.reason });
      await writeAudit(tx, user.id, 'Reject', 'InstrumentImportRow', id, 'state', 'Pending', 'Rejected', b.reason);
      return updated;
    });
    res.json(presentRow(row));
  });

  router.get('/instruments/:id/usage-log', requireAuth, async (req, res) => {
    const instrumentId = String(req.params.id);
    const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
    if (!inst) throw new NotFoundError(`Instrument ${instrumentId} was not found.`);
    const rows = await db.select({ l: instrumentUsageLog, fileName: instrumentFiles.fileName, userName: users.name })
      .from(instrumentUsageLog).leftJoin(instrumentFiles, eq(instrumentFiles.id, instrumentUsageLog.fileId))
      .innerJoin(users, eq(users.id, instrumentUsageLog.userId)).where(eq(instrumentUsageLog.instrumentId, instrumentId))
      .orderBy(desc(instrumentUsageLog.at), desc(instrumentUsageLog.id)).limit(200);
    res.json(rows.map(({ l, fileName, userName }) => ({ ...l, at: l.at.toISOString(), fileName, userName })));
  });

  router.get('/samples/:id/result-sources', requireAuth, async (req, res) => {
    const sampleId = String(req.params.id);
    const [s] = await db.select({ id: samples.id }).from(samples).where(eq(samples.id, sampleId)).limit(1);
    if (!s) throw new NotFoundError(`Sample ${sampleId} was not found.`);
    const rows = await db.select({ src: resultSources, parameter: results.parameter, fileName: instrumentFiles.fileName, acceptedByName: users.name })
      .from(resultSources).innerJoin(results, eq(results.id, resultSources.resultId)).innerJoin(instrumentFiles, eq(instrumentFiles.id, resultSources.fileId))
      .innerJoin(users, eq(users.id, resultSources.acceptedBy)).where(eq(results.sampleId, sampleId)).orderBy(desc(resultSources.acceptedAt));
    res.json(rows.map(({ src, parameter, fileName, acceptedByName }) => ({ ...src, acceptedAt: src.acceptedAt.toISOString(), parameter, fileName, acceptedByName })));
  });

  return router;
};

/** The first bytes of a stored file, for type detection. */
async function headOf(sha256: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of openBlob(blobDir(), sha256) as AsyncIterable<Buffer>) {
    parts.push(chunk); n += chunk.length;
    if (n >= 8192) break;
  }
  return Buffer.concat(parts).subarray(0, 8192);
}
