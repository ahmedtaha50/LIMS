// Retention classes, policies and legal hold (roadmap M42, r3-periodic-archive; migration 0330_periodic_archive).
//
// Conservative by construction:
//   - a record class without a policy, or with retention_years NULL, is kept indefinitely: nothing is ever eligible;
//   - the number of years is a decision of the organisation, set by a QA e-signature (RETENTION_POLICY); the application ships no default
//     number and no regulatory citation;
//   - a legal hold on a class (or one record) blocks flagging for purge, in the service AND in the database (trigger);
//   - only an ARCHIVED record (verified bundle + QA decision) can be flagged, and a flag is only "may be considered for disposal":
//     this application has no purge function and nothing here deletes a GxP record.
import { randomBytes } from 'crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { archivedRecords, legalHolds, retentionFlags, retentionPolicies } from '../db/schema/periodic';
import { writeAudit } from '../db/utils';
import type { Db } from './core/context';
import { lockRow, updateVersioned, withTransaction } from './core/tx';
import { registerSignable, signRecord } from './esign';
import { AppError, ConflictError, NotFoundError } from './http/errors';

export const RETENTION_MEANING = 'RETENTION_POLICY';
export const LEGAL_HOLD_MEANING = 'LEGAL_HOLD';

/** The record classes a policy or a hold can name, and the archived entity types that belong to each. */
export const RECORD_CLASSES: ReadonlyArray<{ key: string; title: string; entityTypes: readonly string[] }> = [
  { key: 'sample-records', title: 'Samples and results', entityTypes: ['Sample', 'Result'] },
  { key: 'batch-records', title: 'Batch records, releases and Certificates of Analysis', entityTypes: ['ProductBatch', 'BatchRelease', 'CoaDocument'] },
  { key: 'audit-trail', title: 'Audit trail', entityTypes: [] },
  { key: 'signatures', title: 'Electronic signatures', entityTypes: [] },
  { key: 'controlled-documents', title: 'Controlled documents and training', entityTypes: [] },
  { key: 'quality-records', title: 'Deviations, CAPA, change control', entityTypes: [] },
  { key: 'equipment-records', title: 'Instruments and calibration', entityTypes: [] },
  { key: 'stability-records', title: 'Stability studies', entityTypes: [] },
  { key: 'environmental-monitoring', title: 'Environmental monitoring', entityTypes: [] },
  { key: 'periodic-reviews', title: 'Periodic reviews', entityTypes: [] },
];
const CLASS_KEYS = RECORD_CLASSES.map(c => c.key) as [string, ...string[]];
export const classOfEntity = (entityType: string) => RECORD_CLASSES.find(c => c.entityTypes.includes(entityType))?.key ?? null;

export const policySchema = z.object({
  retentionYears: z.number().int().min(1).max(100).nullable(),
  basis: z.string('The basis (the rule or the decision it rests on) is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(0),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
}).strict();

export const holdPlaceSchema = z.object({
  recordClass: z.enum(CLASS_KEYS, { error: `recordClass must be one of ${CLASS_KEYS.join(', ')}.` }),
  scopeRef: z.string().trim().min(1).max(200).optional(),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
}).strict();

export const holdReleaseSchema = z.object({
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
}).strict();

export const flagSchema = z.object({
  entityType: z.string().trim().min(1).max(64),
  entityId: z.string().trim().min(1).max(200),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
}).strict();

export const flagWithdrawSchema = z.object({
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
}).strict();

registerSignable({
  type: 'RetentionPolicy',
  async canonical(ex, { id }) {
    const [p] = await ex.select().from(retentionPolicies).where(eq(retentionPolicies.recordClass, id)).limit(1);
    return p ? { recordClass: p.recordClass, retentionYears: p.retentionYears, basis: p.basis } : null;
  },
});
registerSignable({
  type: 'LegalHold',
  async canonical(ex, { id, change }) {
    const [h] = await ex.select().from(legalHolds).where(eq(legalHolds.id, id)).limit(1);
    return h ? { id: h.id, recordClass: h.recordClass, scopeRef: h.scopeRef, reason: h.reason, status: change?.field === 'status' ? change.newValue : h.status } : null;
  },
});

const newId = (p: string) => `${p}-${randomBytes(8).toString('hex')}`;

export async function listPolicies(db: Db) {
  const rows = new Map((await db.select().from(retentionPolicies)).map(r => [r.recordClass, r]));
  return RECORD_CLASSES.map(c => {
    const r = rows.get(c.key);
    return { recordClass: c.key, title: c.title, retentionYears: r?.retentionYears ?? null, indefinite: !r || r.retentionYears === null, basis: r?.basis ?? null, updatedAt: r?.updatedAt ?? null, version: r?.version ?? 0 };
  });
}

export async function setPolicy(db: Db, user: { id: string }, recordClass: string, input: z.infer<typeof policySchema>, context?: Parameters<typeof signRecord>[0]['context']) {
  if (!RECORD_CLASSES.some(c => c.key === recordClass)) throw new NotFoundError(`"${recordClass}" is not a record class.`);
  return signRecord({
    db, user, meaningCode: RETENTION_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'RetentionPolicy', entityId: recordClass, context,
    execute: async (tx) => {
      const [current] = await tx.select().from(retentionPolicies).where(eq(retentionPolicies.recordClass, recordClass)).for('update');
      if ((current?.version ?? 0) !== input.expectedVersion) throw new ConflictError();
      let row: typeof retentionPolicies.$inferSelect;
      if (!current) {
        const inserted = await tx.insert(retentionPolicies).values({ recordClass, retentionYears: input.retentionYears, basis: input.basis, updatedBy: user.id }).onConflictDoNothing().returning();
        if (inserted.length !== 1) throw new ConflictError();
        row = inserted[0];
      } else {
        // The table is keyed by the class, not by an id column: the same predicate by hand (WHERE record_class AND version).
        const updated = await tx.update(retentionPolicies)
          .set({ retentionYears: input.retentionYears, basis: input.basis, updatedBy: user.id, updatedAt: new Date(), version: sql`${retentionPolicies.version} + 1` })
          .where(and(eq(retentionPolicies.recordClass, recordClass), eq(retentionPolicies.version, input.expectedVersion))).returning();
        if (updated.length !== 1) throw new ConflictError();
        row = updated[0];
      }
      return {
        recordVersion: row.version,
        audit: { action: 'SetRetention', field: 'retentionYears', oldValue: current ? String(current.retentionYears ?? 'indefinite') : 'indefinite', newValue: String(row.retentionYears ?? 'indefinite'), reason: input.reason },
        result: row,
      };
    },
  });
}

export async function placeHold(db: Db, user: { id: string }, input: z.infer<typeof holdPlaceSchema>, context?: Parameters<typeof signRecord>[0]['context']) {
  const id = newId('lh');
  return signRecord({
    db, user, meaningCode: LEGAL_HOLD_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'LegalHold', entityId: id, context,
    execute: async (tx) => {
      const [row] = await tx.insert(legalHolds).values({ id, recordClass: input.recordClass, scopeRef: input.scopeRef ?? null, reason: input.reason, placedBy: user.id }).returning();
      return { recordVersion: row.version, audit: { action: 'PlaceHold', field: 'status', oldValue: '', newValue: 'Active', reason: input.reason }, result: row };
    },
  });
}

export async function releaseHold(db: Db, user: { id: string }, id: string, input: z.infer<typeof holdReleaseSchema>, context?: Parameters<typeof signRecord>[0]['context']) {
  const [first] = await db.select().from(legalHolds).where(eq(legalHolds.id, id)).limit(1);
  if (!first) throw new NotFoundError(`Legal hold ${id} was not found.`);
  if (first.status !== 'Active') throw new AppError(409, 'ILLEGAL_TRANSITION', 'The hold is already released.');
  if (first.version !== input.expectedVersion) throw new ConflictError();
  return signRecord({
    db, user, meaningCode: LEGAL_HOLD_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'LegalHold', entityId: id, context,
    execute: async (tx) => {
      const current = await lockRow(tx, legalHolds, id);
      if (current.status !== 'Active') throw new AppError(409, 'ILLEGAL_TRANSITION', 'The hold is already released.');
      const row = await updateVersioned(tx, legalHolds, id, input.expectedVersion, { status: 'Released', releasedBy: user.id, releasedAt: new Date(), releaseReason: input.reason });
      return { recordVersion: row.version, audit: { action: 'ReleaseHold', field: 'status', oldValue: 'Active', newValue: 'Released', reason: input.reason }, result: row };
    },
  });
}

export async function listHolds(db: Db) {
  return db.select().from(legalHolds).orderBy(asc(legalHolds.placedAt), asc(legalHolds.id));
}

/** The active hold that covers (class, record), or null. */
export async function activeHold(ex: Pick<Db, 'select'>, recordClass: string, entityId: string) {
  const [h] = await ex.select().from(legalHolds).where(and(eq(legalHolds.status, 'Active'), eq(legalHolds.recordClass, recordClass), sql`(${legalHolds.scopeRef} IS NULL OR ${legalHolds.scopeRef} = ${entityId})`)).limit(1);
  return h ?? null;
}

const addYears = (d: Date, years: number) => new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));

/**
 * Archived records whose retention has run out and that nothing prevents from being considered for disposal. The clock starts when the
 * record was archived (a conservative start: never earlier than the record's own date). A record class without a number never appears.
 */
export async function purgeCandidates(db: Db, now = new Date()) {
  const policies = new Map((await db.select().from(retentionPolicies)).map(p => [p.recordClass, p]));
  const archived = await db.select().from(archivedRecords).orderBy(asc(archivedRecords.archivedAt), asc(archivedRecords.entityType), asc(archivedRecords.entityId));
  const flagged = new Set((await db.select().from(retentionFlags).where(eq(retentionFlags.status, 'Flagged'))).map(f => `${f.entityType}:${f.entityId}`));
  const out: Array<{ entityType: string; entityId: string; recordClass: string; archivedAt: Date; eligibleFrom: string; flagged: boolean }> = [];
  for (const a of archived) {
    const cls = classOfEntity(a.entityType);
    const years = cls ? policies.get(cls)?.retentionYears ?? null : null;
    if (!cls || years === null) continue;
    const eligible = addYears(a.archivedAt, years);
    if (eligible.getTime() > now.getTime()) continue;
    if (await activeHold(db, cls, a.entityId)) continue;
    out.push({ entityType: a.entityType, entityId: a.entityId, recordClass: cls, archivedAt: a.archivedAt, eligibleFrom: eligible.toISOString().slice(0, 10), flagged: flagged.has(`${a.entityType}:${a.entityId}`) });
  }
  return out;
}

/** Flags one archived record for disposal review. Nothing is deleted. 423 when the class (or the record) is under legal hold. */
export async function flagForPurge(db: Db, actorId: string, input: z.infer<typeof flagSchema>, now = new Date()) {
  const recordClass = classOfEntity(input.entityType);
  if (!recordClass) throw new AppError(422, 'NOT_A_RECORD_CLASS', `"${input.entityType}" does not belong to a retention class that can be flagged.`);
  return withTransaction(db, async (tx) => {
    const [archived] = await tx.select().from(archivedRecords).where(and(eq(archivedRecords.entityType, input.entityType), eq(archivedRecords.entityId, input.entityId))).limit(1);
    if (!archived) throw new AppError(409, 'NOT_ARCHIVED', 'Only an archived record (verified bundle, QA decision) can be flagged for disposal review.');
    const hold = await activeHold(tx, recordClass, input.entityId);
    if (hold) throw new AppError(423, 'LEGAL_HOLD', `The record class ${recordClass} is under legal hold (${hold.id}): it cannot be flagged for purge.`, { holdId: hold.id });
    const [policy] = await tx.select().from(retentionPolicies).where(eq(retentionPolicies.recordClass, recordClass)).limit(1);
    if (!policy || policy.retentionYears === null) throw new AppError(409, 'RETENTION_INDEFINITE', `The class ${recordClass} has no retention period set: its records are kept indefinitely.`);
    const eligible = addYears(archived.archivedAt, policy.retentionYears);
    if (eligible.getTime() > now.getTime()) throw new AppError(409, 'RETENTION_NOT_EXPIRED', `Retention runs until ${eligible.toISOString().slice(0, 10)}.`, { eligibleFrom: eligible.toISOString().slice(0, 10) });
    const id = newId('rf');
    const inserted = await tx.insert(retentionFlags).values({ id, recordClass, entityType: input.entityType, entityId: input.entityId, reason: input.reason, flaggedBy: actorId }).onConflictDoNothing().returning();
    if (inserted.length !== 1) throw new AppError(409, 'ALREADY_FLAGGED', 'The record is already flagged.');
    await writeAudit(tx, actorId, 'FlagForPurge', 'RetentionFlag', id, 'status', '', 'Flagged', `${input.entityType} ${input.entityId}: ${input.reason}`);
    return inserted[0];
  });
}

export async function withdrawFlag(db: Db, actorId: string, id: string, input: z.infer<typeof flagWithdrawSchema>) {
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, retentionFlags, id);
    if (current.version !== input.expectedVersion) throw new ConflictError();
    if (current.status !== 'Flagged') throw new AppError(409, 'ILLEGAL_TRANSITION', 'The flag is already withdrawn.');
    const row = await updateVersioned(tx, retentionFlags, id, input.expectedVersion, { status: 'Withdrawn', withdrawnBy: actorId, withdrawnAt: new Date() });
    await writeAudit(tx, actorId, 'WithdrawFlag', 'RetentionFlag', id, 'status', 'Flagged', 'Withdrawn', input.reason);
    return row;
  });
}

export async function listFlags(db: Db) {
  return db.select().from(retentionFlags).orderBy(asc(retentionFlags.flaggedAt), asc(retentionFlags.id));
}
