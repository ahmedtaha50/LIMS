/**
 * Automatic opening of a quality record by the event that requires one (roadmap M27), inside the ORIGINATING transaction: the event and
 * its deviation commit or roll back together, so there is never an event without its record or a record without its event.
 *
 *   await autoOpenQmsRecord(tx, { source: 'oos-confirmed', sourceId: oos.id, actorId: user.id, title: `Confirmed OOS ${oos.id}` });
 *
 * One record per (type, source, source id): calling it again for the same event returns the record already open (`created: false`).
 * The record starts in QA Triage (the quality unit classifies it), names its source in `origin` and carries a `source` link to it.
 * The actor is the person whose action caused the event (req.user), or the service principal of the scheduler for a scheduled job
 * (src/server/jobs/principal.ts); never an anonymous 'system'.
 *
 * The callers live in the files that own the events (see docs/changes/r2-qms.md, needs from other tracks).
 */
import { randomBytes } from 'crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { qmsLinks, qmsRecords } from '../../db/schema/qms';
import type { Tx } from '../core/tx';
import { insertRecord } from './engine';
import type { QmsType } from './states';

export const AUTO_OPEN_SOURCES = {
  'oos-confirmed': { type: 'Deviation', sourceType: 'OOS' },
  'em-excursion': { type: 'Deviation', sourceType: 'EnvRecord' },
  'instrument-overdue-use': { type: 'Deviation', sourceType: 'Instrument' },
  'backup-failed': { type: 'Deviation', sourceType: 'BackupRun' },
  'audit-chain-broken': { type: 'Deviation', sourceType: 'AuditTrail' },
  'stability-pull-missed': { type: 'Deviation', sourceType: 'StabilityTimepoint' },
} as const satisfies Record<string, { type: QmsType; sourceType: string }>;

export type AutoOpenSource = keyof typeof AUTO_OPEN_SOURCES;

export interface AutoOpenInput {
  source: AutoOpenSource;
  sourceId: string;
  actorId: string;
  title: string;
  description?: string;
  classification?: 'Minor' | 'Major' | 'Critical';
}

export async function autoOpenQmsRecord(tx: Tx, input: AutoOpenInput): Promise<{ id: string; created: boolean }> {
  const { type, sourceType } = AUTO_OPEN_SOURCES[input.source];
  // Serialises two events for the same source; the partial unique index qms_records_auto_source_uidx is the last line.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`qms-auto:${type}:${sourceType}:${input.sourceId}`}))`);
  const [existing] = await tx.select({ id: qmsRecords.id }).from(qmsRecords)
    .where(and(eq(qmsRecords.type, type), eq(qmsRecords.sourceType, sourceType), eq(qmsRecords.sourceId, input.sourceId), ne(qmsRecords.origin, 'manual'))).limit(1);
  if (existing) return { id: existing.id, created: false };

  const row = await insertRecord(tx, input.actorId,
    { type, title: input.title, description: input.description, classification: input.classification },
    { origin: `auto:${input.source}`, sourceType, sourceId: input.sourceId, state: 'QA Triage', reason: `Opened automatically: ${input.source} ${input.sourceId}` });
  await tx.insert(qmsLinks).values({ id: `QL-${randomBytes(6).toString('hex')}`, recordId: row.id, relation: 'source', targetType: sourceType, targetId: input.sourceId, createdBy: input.actorId });
  return { id: row.id, created: true };
}
