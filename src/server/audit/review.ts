/**
 * Audit-trail review (roadmap M35, EU GMP Annex 11 s.9, PIC/S PI 041 s.9.6, MHRA GXP data integrity 6.13). r2-audit-tamper owns this file.
 *
 * Review by exception: the reviewer reads every row of a scope, and the rows that most need a second look are listed apart:
 *
 *   EDIT_AFTER_SUBMIT               a result (or the sample) changed after the sample was submitted for review
 *   SIGNATURE_FAILED                a failed e-signature attempt
 *   ROLE_OR_SETTING_CHANGE          a role change or a change of a system, security, integration, key, QMS or review setting
 *   SAME_USER_CREATED_AND_APPROVED  the person who created a record also approved or released it
 *
 * A scope is the rows about one batch (its samples, their results and OOS investigations, the batch release) or a range of sequences.
 * The review is an e-signature (AUDIT_REVIEW, QA or Admin) over an audit_reviews row that records the range the reviewer saw (a batch
 * review names the last entry it was shown; 409 SCOPE_CHANGED when the batch has a newer one). The
 * reviewer must not be the author of any row reviewed (403 SOD_VIOLATION), and a scope with exceptions needs a comment.
 *
 * Release interlock (auditReviewReleaseBlocker): when audit_review_settings.required_for_release is on, a batch is not released while
 * any row about it lies outside every signed review: a review of the batch whose range contains the row, or a range review that does.
 * A change after the review is therefore not covered by it.
 */
import { randomBytes } from 'crypto';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { auditReviews, auditReviewSettings } from '../../db/schema/audit-review';
import type { EventContext } from '../auth/events';
import type { Db } from '../core/context';
import { updateVersioned, type Executor } from '../core/tx';
import { registerSignable, signRecord, type SigningCredentials } from '../esign';
import { AppError, NotFoundError } from '../http/errors';
import type { ReleaseBlocker } from '../release-blockers';

export const EXCEPTION_KINDS = ['EDIT_AFTER_SUBMIT', 'SIGNATURE_FAILED', 'ROLE_OR_SETTING_CHANGE', 'SAME_USER_CREATED_AND_APPROVED'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** A range review may span at most this many sequences (a larger period is reviewed in parts). */
export const MAX_RANGE = 50_000;
/** At most this many exceptions are listed; the count is always complete. */
const MAX_LISTED = 2_000;
/** Text a scope with exceptions needs from the reviewer. */
export const MIN_COMMENT = 10;
const SETTINGS_ID = 'default';

/** Audit entities whose entity_id is a sample id / a result id / an OOS id. */
const SAMPLE_ENTITIES = ['Sample', 'SampleContext', 'CertificateOfAnalysis'];
const SETTING_ENTITIES = ['SystemSettings', 'Integration', 'Keystore', 'QmsSettings', 'AuditReviewSettings', 'UserRole'];
const APPROVAL_VALUES = ['Approved', 'Active', 'QA Approved', 'Released', 'Effective'];

export type ReviewScope = { kind: 'batch'; batch: string } | { kind: 'range'; from: number; to: number };

const list = (values: readonly string[]) => sql.join(values.map(v => sql`${v}`), sql`, `);

/** The audit rows of a scope, as a SQL condition on audit_trail aliased `a`. */
function scopeCondition(scope: ReviewScope): SQL {
  if (scope.kind === 'range') return sql`a.sequence BETWEEN ${scope.from} AND ${scope.to}`;
  const b = scope.batch;
  return sql`((a.entity IN (${list(SAMPLE_ENTITIES)}) AND a.entity_id IN (SELECT id FROM samples WHERE batch = ${b}))
    OR (a.entity = 'Result' AND a.entity_id IN (SELECT r.id FROM results r JOIN samples s ON s.id = r.sample_id WHERE s.batch = ${b}))
    OR (a.entity = 'OOS' AND a.entity_id IN (SELECT o.id FROM oos_investigations o JOIN samples s ON s.id = o.sample_id WHERE s.batch = ${b}))
    OR (a.entity = 'BatchRelease' AND a.entity_id = ${b}))`;
}

const rowsOf = (r: any): any[] => r.rows ?? r;

/** Every (row, exception) pair of the rows matching `cond`; one row can be several kinds of exception. */
function exceptionQuery(cond: SQL): SQL {
  return sql`
    WITH scope AS (SELECT a.* FROM audit_trail a WHERE ${cond})
    SELECT x.*, k.kind, k.detail FROM scope x
    CROSS JOIN LATERAL (
      SELECT 'EDIT_AFTER_SUBMIT' AS kind, 'Changed after the sample was submitted for review (sequence ' || sub.sequence || ').' AS detail
        FROM (SELECT s.sequence FROM audit_trail s
               WHERE s.entity = 'Sample' AND s.action = 'Transition' AND s.new_value = 'Pending Review' AND s.sequence < x.sequence
                 AND s.entity_id = CASE WHEN x.entity = 'Result' THEN (SELECT r.sample_id FROM results r WHERE r.id = x.entity_id) ELSE x.entity_id END
               ORDER BY s.sequence LIMIT 1) sub
       WHERE (x.entity = 'Result' AND x.action IN ('Update', 'Invalidate')) OR (x.entity = 'Sample' AND x.action = 'Update')
      UNION ALL
      SELECT 'SIGNATURE_FAILED', 'A failed electronic signature attempt.' WHERE x.action = 'SignatureFailed'
      UNION ALL
      SELECT 'ROLE_OR_SETTING_CHANGE', 'A change of a role or of a system setting.'
       WHERE x.action LIKE 'RoleChange%' OR (x.entity = 'User' AND x.field = 'role') OR (x.entity IN (${list(SETTING_ENTITIES)}) AND x.action <> 'SignatureFailed')
      UNION ALL
      SELECT 'SAME_USER_CREATED_AND_APPROVED', 'Approved or released by the person who created it (sequence ' || c.sequence || ').'
        FROM (SELECT c.sequence FROM audit_trail c WHERE c.entity = x.entity AND c.entity_id = x.entity_id AND c.action = 'Create'
                 AND c.user_id = x.user_id AND c.sequence < x.sequence ORDER BY c.sequence LIMIT 1) c
       WHERE x.action IN ('Transition', 'StatusChange', 'Approve', 'Release') AND x.new_value IN (${list(APPROVAL_VALUES)})
    ) k`;
}

export interface AuditExceptionRow {
  kind: ExceptionKind; sequence: number; entity: string; entityId: string; userId: string; actorName: string | null; action: string;
  field: string; oldValue: string; newValue: string; reason: string; timestamp: string; detail: string;
}
export interface ScopeSummary {
  scope: { kind: 'batch'; batch: string } | { kind: 'range' };
  fromSequence: number | null;
  toSequence: number | null;
  rowCount: number;
  authors: string[];
  exceptionCount: number;
  exceptions: AuditExceptionRow[];
  truncated: boolean;
}

/** The rows of the scope (up to `through`, when given) and their exceptions. */
export async function findExceptions(ex: Executor, scope: ReviewScope, through?: number): Promise<ScopeSummary> {
  const bound = through === undefined ? sql`TRUE` : sql`a.sequence <= ${through}`;
  const cond = sql`${scopeCondition(scope)} AND ${bound}`;
  const [stats] = rowsOf(await ex.execute(sql`
    SELECT count(*)::int AS n, min(a.sequence)::int AS first, max(a.sequence)::int AS last, coalesce(array_agg(DISTINCT a.user_id), '{}') AS authors
      FROM audit_trail a WHERE ${cond}`));

  const found = rowsOf(await ex.execute(sql`${exceptionQuery(cond)} ORDER BY x.sequence, k.kind LIMIT ${MAX_LISTED + 1}`));
  const truncated = found.length > MAX_LISTED;
  const exceptions: AuditExceptionRow[] = found.slice(0, MAX_LISTED).map((r: any) => ({
    kind: r.kind, sequence: r.sequence, entity: r.entity, entityId: r.entity_id, userId: r.user_id, actorName: r.actor_name ?? null, action: r.action,
    field: r.field, oldValue: r.old_value, newValue: r.new_value, reason: r.reason, timestamp: r.timestamp_str, detail: r.detail,
  }));
  return {
    scope: scope.kind === 'batch' ? { kind: 'batch', batch: scope.batch } : { kind: 'range' },
    fromSequence: scope.kind === 'range' ? scope.from : stats.first ?? null,
    toSequence: scope.kind === 'range' ? scope.to : stats.last ?? null,
    rowCount: stats.n,
    authors: [...stats.authors].sort(),
    exceptionCount: truncated ? rowsOf(await ex.execute(sql`SELECT count(*)::int AS n FROM (${exceptionQuery(cond)}) z`))[0].n : exceptions.length,
    exceptions,
    truncated,
  };
}

export interface Coverage { covered: boolean; uncoveredRows: number; firstUncovered: number | null; lastUncovered: number | null }

/** The rows about `batch` that no signed review covers. */
export async function batchCoverage(ex: Executor, batch: string): Promise<Coverage> {
  const [r] = rowsOf(await ex.execute(sql`
    SELECT count(*)::int AS n, min(a.sequence)::int AS first, max(a.sequence)::int AS last FROM audit_trail a
     WHERE ${scopeCondition({ kind: 'batch', batch })}
       AND NOT EXISTS (SELECT 1 FROM audit_reviews v WHERE a.sequence BETWEEN v.from_sequence AND v.to_sequence
                         AND (v.scope = 'range' OR (v.scope = 'batch' AND v.scope_id = ${batch})))`));
  return { covered: r.n === 0, uncoveredRows: r.n, firstUncovered: r.first ?? null, lastUncovered: r.last ?? null };
}

export type ReviewSettings = typeof auditReviewSettings.$inferSelect;

export async function getReviewSettings(ex: Executor): Promise<ReviewSettings> {
  const [row] = await ex.select().from(auditReviewSettings).where(eq(auditReviewSettings.id, SETTINGS_ID)).limit(1);
  // A database built from the migration script alone (a restore before its rows are loaded) has no row: the requirement is then off.
  return row ?? { id: SETTINGS_ID, requiredForRelease: false, updatedBy: null, updatedAt: new Date(0), version: 0 };
}

export const auditReviewReleaseBlocker: ReleaseBlocker = {
  name: 'audit-trail-reviewed',
  async check(ex, batch, batchSamples) {
    if (batchSamples.length === 0 || !(await getReviewSettings(ex)).requiredForRelease) return [];
    const c = await batchCoverage(ex, batch);
    if (c.covered) return [];
    return [`Audit-trail review required: ${c.uncoveredRows} audit-trail ${c.uncoveredRows === 1 ? 'entry' : 'entries'} about batch ${batch} ` +
      `(sequence ${c.firstUncovered}${c.lastUncovered !== c.firstUncovered ? ` to ${c.lastUncovered}` : ''}) ${c.uncoveredRows === 1 ? 'is' : 'are'} not covered by a signed audit-trail review (AUDIT_REVIEW).`];
  },
};

registerSignable({
  type: 'AuditReview',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(auditReviews).where(eq(auditReviews.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, scope: row.scope, scopeId: row.scopeId, fromSequence: row.fromSequence, toSequence: row.toSequence, rowsReviewed: row.rowsReviewed,
      exceptionCount: row.exceptionCount, comment: row.comment, reviewerId: row.reviewerId,
    };
  },
});

registerSignable({
  type: 'AuditReviewSettings',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(auditReviewSettings).where(eq(auditReviewSettings.id, id)).limit(1);
    return row ? { id: row.id, requiredForRelease: row.requiredForRelease } : null;
  },
});

export type ReviewBody = SigningCredentials & { comment?: string; reason?: string } & (
  { scope: 'batch'; batch: string; throughSequence: number } | { scope: 'range'; fromSequence: number; toSequence: number });

async function headSequence(ex: Executor): Promise<number> {
  const [r] = rowsOf(await ex.execute(sql`SELECT coalesce(max(sequence), 0)::int AS s FROM audit_trail`));
  return r.s;
}

function assertIndependent(summary: ScopeSummary, userId: string) {
  if (summary.authors.includes(userId)) {
    throw new AppError(403, 'SOD_VIOLATION', 'Segregation of duties: you made entries in this part of the audit trail and may not review it. Another QA reviewer must sign the review.');
  }
}

/** The signed review (AUDIT_REVIEW). Every refusal that does not need the password comes before it is checked. */
export async function createReview(db: Db, user: { id: string }, body: ReviewBody, context?: Partial<EventContext>) {
  let scope: ReviewScope;
  if (body.scope === 'range') {
    if (body.toSequence - body.fromSequence + 1 > MAX_RANGE) throw new AppError(400, 'RANGE_TOO_LARGE', `A review covers at most ${MAX_RANGE} entries; review a longer period in parts.`);
    if (body.toSequence > await headSequence(db)) throw new AppError(400, 'RANGE_BEYOND_HEAD', 'The range ends after the newest audit entry.');
    scope = { kind: 'range', from: body.fromSequence, to: body.toSequence };
  } else {
    scope = { kind: 'batch', batch: body.batch };
  }
  const seen = await findExceptions(db, scope);
  if (seen.rowCount === 0 || seen.toSequence === null) throw new NotFoundError(scope.kind === 'batch' ? `The audit trail has no entries about batch ${scope.batch}.` : 'The range holds no audit entries.');
  if (body.scope === 'batch' && seen.toSequence !== body.throughSequence) {
    throw new AppError(409, 'SCOPE_CHANGED', `The audit trail of batch ${body.batch} has changed since it was shown (its last entry is now #${seen.toSequence}, not #${body.throughSequence}). Show it again and review the new entries.`);
  }
  assertIndependent(seen, user.id);
  const comment = (body.comment ?? '').trim();
  if (seen.exceptionCount > 0 && comment.length < MIN_COMMENT) {
    throw new AppError(400, 'COMMENT_REQUIRED', `This scope has ${seen.exceptionCount} exception(s): say in a comment of at least ${MIN_COMMENT} characters how each was assessed.`);
  }
  const through = seen.toSequence;
  const id = `AR-${randomBytes(6).toString('hex').toUpperCase()}`;

  const { result, signature } = await signRecord({
    db, user, meaningCode: 'AUDIT_REVIEW', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'AuditReview', entityId: id, context,
    execute: async tx => {
      // Again inside the transaction, bounded by what the reviewer saw: rows written since are not part of this review.
      const now = await findExceptions(tx, scope, through);
      assertIndependent(now, user.id);
      const [row] = await tx.insert(auditReviews).values({
        id, scope: body.scope, scopeId: body.scope === 'batch' ? body.batch : null, fromSequence: now.fromSequence ?? through, toSequence: through,
        rowsReviewed: now.rowCount, exceptionCount: now.exceptionCount, comment, reviewerId: user.id,
      }).returning();
      return {
        recordVersion: row.version, result: row,
        audit: {
          action: 'Review', field: 'auditTrail', oldValue: '', reason: comment || 'Audit trail review',
          newValue: JSON.stringify({ scope: row.scope, scopeId: row.scopeId, fromSequence: row.fromSequence, toSequence: row.toSequence, rows: row.rowsReviewed, exceptions: row.exceptionCount }),
        },
      };
    },
  });
  return { review: result, signature };
}

export async function listReviews(ex: Executor, f: { batch?: string } = {}) {
  const base = ex.select().from(auditReviews);
  const reviews = await (f.batch ? base.where(eq(auditReviews.scopeId, f.batch)) : base).orderBy(desc(auditReviews.reviewedAt), desc(auditReviews.id)).limit(200);
  const settings = await getReviewSettings(ex);
  return { reviews, requiredForRelease: settings.requiredForRelease, coverage: f.batch ? await batchCoverage(ex, f.batch) : null };
}

export interface SettingsBody extends SigningCredentials { requiredForRelease: boolean; expectedVersion: number; reason: string }

/** The requirement is changed only by an e-signature (AUDIT_REVIEW_SETTING, reason required). */
export async function updateReviewSettings(db: Db, user: { id: string }, body: SettingsBody, context?: Partial<EventContext>) {
  const { result, signature } = await signRecord({
    db, user, meaningCode: 'AUDIT_REVIEW_SETTING', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'AuditReviewSettings', entityId: SETTINGS_ID, context,
    execute: async tx => {
      const current = await getReviewSettings(tx);
      if (current.version === 0) await tx.insert(auditReviewSettings).values({ id: SETTINGS_ID }).onConflictDoNothing();
      const expected = current.version === 0 ? 1 : body.expectedVersion;
      const row = await updateVersioned(tx, auditReviewSettings, SETTINGS_ID, expected, { requiredForRelease: body.requiredForRelease, updatedBy: user.id, updatedAt: new Date() });
      return {
        recordVersion: row.version, result: row,
        audit: { action: 'Update', field: 'requiredForRelease', oldValue: String(current.requiredForRelease), newValue: String(row.requiredForRelease), reason: body.reason },
      };
    },
  });
  return { settings: result, signature };
}
