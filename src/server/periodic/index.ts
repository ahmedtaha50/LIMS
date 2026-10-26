// Periodic review (roadmap M42, r3-periodic-archive; migration 0330_periodic_archive). The service behind routes/periodic-reviews.ts and the
// scheduled scan (schedules/periodic.ts).
//
// A PLAN says what is reviewed (user access, an instrument, a specification, a method, a document, a qualified module, the whole system),
// how often and when it is next due. A REVIEW is one pass over one plan: the server snapshots the evidence when the review is opened (hash
// stored, never edited), the reviewer records the checklist and the findings, and QA completes it with an e-signature (meaning
// PERIODIC_REVIEW) bound to the record version and the evidence hash. Completing it moves the plan's due date forward.
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  periodicReviewPlans, periodicReviews, REVIEW_CONCLUSIONS, REVIEW_KINDS,
  type ChecklistAnswer, type ReviewFinding, type ReviewKind,
} from '../../db/schema/periodic';
import { writeAudit } from '../../db/utils';
import { utcToday } from '../../lib/validations/instruments';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { registerSignable, signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { buildEvidence, subjectExists } from './evidence';
import { randomBytes } from 'crypto';

export const PERIODIC_MEANING = 'PERIODIC_REVIEW';
/** A review is opened by the scan this many days before it is due, so the reviewer has time. */
export const OPEN_LEAD_DAYS = 14;

/** The checklist a plan starts with when none is given: what a reviewer of that kind is asked. */
export const DEFAULT_CHECKLIST: Record<ReviewKind, string[]> = {
  user_access: ['Every active user still needs an account', 'Each role is appropriate to the person\'s current duties', 'Leavers and dormant accounts are deactivated', 'Training is current for every active user'],
  instrument: ['Calibration is current and the history is complete', 'Usage is consistent with the qualified purpose', 'No unresolved deviation concerns the instrument'],
  specification: ['The limits still reflect the registered method and product knowledge', 'The specification is still the approved current version'],
  method: ['The method is still fit for its purpose', 'System suitability criteria are still appropriate'],
  document: ['The content is still accurate and in use', 'Training on the effective version is complete'],
  module: ['The qualification evidence still covers the module as used', 'No change since the declaration invalidates it'],
  system: ['Deviations, changes and CAPAs of the period were reviewed', 'Backups and restore tests were successful', 'The audit trail was reviewed and its chain verified'],
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.').refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'Not a calendar date.');

export const planCreateSchema = z.object({
  kind: z.enum(REVIEW_KINDS, { error: `kind must be one of ${REVIEW_KINDS.join(', ')}.` }),
  subjectId: z.string('subjectId is required (use * for user_access and system).').trim().min(1).max(200),
  title: z.string('A title is required.').trim().min(3).max(200),
  intervalMonths: z.number('intervalMonths is required.').int().min(1).max(120),
  firstDueDate: date,
  checklist: z.array(z.string().trim().min(3).max(300)).max(30).optional(),
}).strict();

export const planUpdateSchema = z.object({
  intervalMonths: z.number().int().min(1).max(120).optional(),
  nextDueDate: date.optional(),
  checklist: z.array(z.string().trim().min(3).max(300)).max(30).optional(),
  status: z.enum(['Active', 'Retired']).optional(),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
}).strict().refine(b => b.intervalMonths !== undefined || b.nextDueDate !== undefined || b.checklist !== undefined || b.status !== undefined, 'Nothing to change.');

const findingSchema = z.object({
  text: z.string().trim().min(3).max(2000),
  severity: z.enum(['Observation', 'Minor', 'Major', 'Critical']),
  qmsRecordId: z.string().trim().min(1).max(128).optional(),
}).strict();
const answerSchema = z.object({ item: z.string().trim().min(1).max(300), answer: z.enum(['Yes', 'No', 'NotApplicable']), comment: z.string().trim().max(1000).optional() }).strict();

export const reviewDraftSchema = z.object({
  checklist: z.array(answerSchema).max(30).optional(),
  findings: z.array(findingSchema).max(100).optional(),
  summary: z.string().trim().max(4000).optional(),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
}).strict().refine(b => b.checklist !== undefined || b.findings !== undefined || b.summary !== undefined, 'Nothing to change.');

export const reviewCompleteSchema = z.object({
  conclusion: z.enum(REVIEW_CONCLUSIONS, { error: `conclusion must be one of ${REVIEW_CONCLUSIONS.join(', ')}.` }),
  summary: z.string('A summary is required.').trim().min(5).max(4000),
  checklist: z.array(answerSchema).max(30),
  findings: z.array(findingSchema).max(100),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
}).strict();

export const reviewCancelSchema = z.object({
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
}).strict();

const newId = (prefix: string) => `${prefix}-${randomBytes(8).toString('hex')}`;

/** Calendar addition in UTC; a day that does not exist in the target month (31 January + 1 month) becomes its last day. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

registerSignable({
  type: 'PeriodicReview',
  async canonical(ex, { id }) {
    const [r] = await ex.select().from(periodicReviews).where(eq(periodicReviews.id, id)).limit(1);
    if (!r) return null;
    // Fixed once Completed (trigger): the conclusion, the answers, the findings and the evidence hash are what was signed.
    return {
      id: r.id, planId: r.planId, kind: r.kind, subjectId: r.subjectId, dueDate: r.dueDate, evidenceSha256: r.evidenceSha256,
      checklist: r.checklist, findings: r.findings, conclusion: r.conclusion, summary: r.summary,
    };
  },
});

export async function createPlan(db: Db, actorId: string, input: z.infer<typeof planCreateSchema>) {
  if (!(await subjectExists(db, input.kind, input.subjectId))) {
    throw new AppError(404, 'SUBJECT_NOT_FOUND', input.kind === 'user_access' || input.kind === 'system'
      ? `A ${input.kind} plan covers the whole system: use "*" as subjectId.`
      : `The ${input.kind} "${input.subjectId}" does not exist.`);
  }
  const checklist = input.checklist ?? DEFAULT_CHECKLIST[input.kind];
  return withTransaction(db, async (tx) => {
    const id = newId('prp');
    const inserted = await tx.insert(periodicReviewPlans).values({
      id, kind: input.kind, subjectId: input.subjectId, title: input.title, intervalMonths: input.intervalMonths,
      nextDueDate: input.firstDueDate, checklist, createdBy: actorId,
    }).onConflictDoNothing().returning();
    if (inserted.length !== 1) throw new AppError(409, 'PLAN_EXISTS', `An active ${input.kind} review plan for "${input.subjectId}" already exists.`);
    await writeAudit(tx, actorId, 'Create', 'PeriodicReviewPlan', id, 'plan', '', JSON.stringify({ kind: input.kind, subjectId: input.subjectId, intervalMonths: input.intervalMonths, nextDueDate: input.firstDueDate }), `Review plan created: ${input.title}`);
    return inserted[0];
  });
}

export async function updatePlan(db: Db, actorId: string, id: string, input: z.infer<typeof planUpdateSchema>) {
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, periodicReviewPlans, id);
    if (current.version !== input.expectedVersion) throw new ConflictError();
    const set: Partial<typeof periodicReviewPlans.$inferInsert> = {};
    if (input.intervalMonths !== undefined) set.intervalMonths = input.intervalMonths;
    if (input.nextDueDate !== undefined) set.nextDueDate = input.nextDueDate;
    if (input.checklist !== undefined) set.checklist = input.checklist;
    if (input.status !== undefined) set.status = input.status;
    const row = await updateVersioned(tx, periodicReviewPlans, id, input.expectedVersion, set);
    const before = { intervalMonths: current.intervalMonths, nextDueDate: current.nextDueDate, status: current.status, checklist: current.checklist };
    const after = { intervalMonths: row.intervalMonths, nextDueDate: row.nextDueDate, status: row.status, checklist: row.checklist };
    await writeAudit(tx, actorId, 'Update', 'PeriodicReviewPlan', id, 'plan', JSON.stringify(before), JSON.stringify(after), input.reason);
    return row;
  });
}

/** Opens the review of a plan: evidence is built now and fixed. One Open review per plan (unique index). */
export async function openReview(db: Db, actorId: string, planId: string, opts: { now?: Date; reason?: string } = {}) {
  const now = opts.now ?? new Date();
  const [plan] = await db.select().from(periodicReviewPlans).where(eq(periodicReviewPlans.id, planId)).limit(1);
  if (!plan) throw new NotFoundError(`Review plan ${planId} was not found.`);
  if (plan.status !== 'Active') throw new AppError(409, 'ILLEGAL_TRANSITION', 'The plan is retired: no review can be opened for it.');
  const { evidence, sha256 } = await buildEvidence(db, plan.kind as ReviewKind, plan.subjectId, now);
  return withTransaction(db, async (tx) => {
    const id = newId('prv');
    const inserted = await tx.insert(periodicReviews).values({
      id, planId: plan.id, kind: plan.kind, subjectId: plan.subjectId, title: plan.title, dueDate: plan.nextDueDate,
      evidence, evidenceSha256: sha256, evidenceGeneratedAt: now,
      openedBy: actorId, openedAt: now,
    }).onConflictDoNothing().returning();
    if (inserted.length !== 1) throw new AppError(409, 'REVIEW_OPEN', 'A review of this plan is already open.');
    await writeAudit(tx, actorId, 'Open', 'PeriodicReview', id, 'status', '', 'Open', opts.reason ?? `Review opened for plan ${plan.id} (due ${plan.nextDueDate})`);
    return inserted[0];
  });
}

export async function saveDraft(db: Db, actorId: string, id: string, input: z.infer<typeof reviewDraftSchema>) {
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, periodicReviews, id);
    if (current.version !== input.expectedVersion) throw new ConflictError();
    if (current.status !== 'Open') throw new AppError(409, 'ILLEGAL_TRANSITION', `The review is ${current.status}: it cannot be changed.`);
    const set: Partial<typeof periodicReviews.$inferInsert> = {};
    if (input.checklist !== undefined) set.checklist = input.checklist;
    if (input.findings !== undefined) set.findings = input.findings;
    if (input.summary !== undefined) set.summary = input.summary;
    const row = await updateVersioned(tx, periodicReviews, id, input.expectedVersion, set);
    await writeAudit(tx, actorId, 'Update', 'PeriodicReview', id, 'draft',
      JSON.stringify({ checklist: current.checklist, findings: current.findings, summary: current.summary }),
      JSON.stringify({ checklist: row.checklist, findings: row.findings, summary: row.summary }), input.reason);
    return row;
  });
}

export async function cancelReview(db: Db, actorId: string, id: string, input: z.infer<typeof reviewCancelSchema>) {
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, periodicReviews, id);
    if (current.version !== input.expectedVersion) throw new ConflictError();
    if (current.status !== 'Open') throw new AppError(409, 'ILLEGAL_TRANSITION', `The review is ${current.status}.`);
    const row = await updateVersioned(tx, periodicReviews, id, input.expectedVersion, { status: 'Cancelled' });
    await writeAudit(tx, actorId, 'Cancel', 'PeriodicReview', id, 'status', 'Open', 'Cancelled', input.reason);
    return row;
  });
}

/** What the signer must have recorded before a review can be concluded. */
export function checkCompletion(plan: { checklist: string[] }, body: Pick<z.infer<typeof reviewCompleteSchema>, 'checklist' | 'findings' | 'conclusion'>) {
  const answered = new Set(body.checklist.map(a => a.item));
  const missing = plan.checklist.filter(i => !answered.has(i));
  if (missing.length) throw new AppError(422, 'CHECKLIST_INCOMPLETE', `Answer every checklist item before concluding: ${missing.join('; ')}.`, { missing });
  const unknown = body.checklist.filter(a => !plan.checklist.includes(a.item));
  if (unknown.length) throw new AppError(422, 'CHECKLIST_UNKNOWN', `These items are not on the checklist: ${unknown.map(a => a.item).join('; ')}.`);
  const no = body.checklist.filter(a => a.answer === 'No');
  const noWithoutComment = no.filter(a => !a.comment || a.comment.length < 3);
  if (noWithoutComment.length) throw new AppError(422, 'CHECKLIST_COMMENT_REQUIRED', `Explain every "No" answer in its comment: ${noWithoutComment.map(a => a.item).join('; ')}.`);
  const serious = body.findings.some(f => f.severity === 'Major' || f.severity === 'Critical');
  if (body.conclusion === 'Satisfactory' && (serious || no.length)) {
    throw new AppError(422, 'CONCLUSION_CONTRADICTS_FINDINGS', 'A Satisfactory conclusion cannot stand with a "No" answer or a Major or Critical finding.');
  }
  if (body.conclusion !== 'Satisfactory' && body.findings.length === 0) {
    throw new AppError(422, 'FINDINGS_REQUIRED', `A ${body.conclusion} conclusion needs at least one finding.`);
  }
}

export async function completeReview(db: Db, user: { id: string }, id: string, input: z.infer<typeof reviewCompleteSchema>, context?: Parameters<typeof signRecord>[0]['context']) {
  const [first] = await db.select().from(periodicReviews).where(eq(periodicReviews.id, id)).limit(1);
  if (!first) throw new NotFoundError(`Review ${id} was not found.`);
  // Decided before the signature is asked for: a refused conclusion costs the signer no attempt.
  const precheck = (r: typeof first, plan: { checklist: string[] }) => {
    if (r.version !== input.expectedVersion) throw new ConflictError();
    if (r.status !== 'Open') throw new AppError(409, 'ILLEGAL_TRANSITION', `The review is ${r.status}.`);
    checkCompletion(plan, input);
  };
  const [plan] = await db.select().from(periodicReviewPlans).where(eq(periodicReviewPlans.id, first.planId)).limit(1);
  precheck(first, plan);

  return signRecord({
    db, user, meaningCode: PERIODIC_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'PeriodicReview', entityId: id, context,
    execute: async (tx) => {
      const current = await lockRow(tx, periodicReviews, id);
      const [lockedPlan] = await tx.select().from(periodicReviewPlans).where(eq(periodicReviewPlans.id, current.planId)).for('update');
      precheck(current, lockedPlan);
      const now = new Date();
      const row = await updateVersioned(tx, periodicReviews, id, input.expectedVersion, {
        status: 'Completed', conclusion: input.conclusion, summary: input.summary, checklist: input.checklist as ChecklistAnswer[], findings: input.findings as ReviewFinding[],
        completedBy: user.id, completedAt: now,
      });
      // The next review falls one interval after this one was due (no drift); if that is already past, one interval from today.
      const today = utcToday(now);
      let next = addMonths(current.dueDate, lockedPlan.intervalMonths);
      if (next <= today) next = addMonths(today, lockedPlan.intervalMonths);
      if (lockedPlan.status === 'Active' && lockedPlan.nextDueDate === current.dueDate) {
        await updateVersioned(tx, periodicReviewPlans, lockedPlan.id, lockedPlan.version, { nextDueDate: next });
        await writeAudit(tx, user.id, 'Reschedule', 'PeriodicReviewPlan', lockedPlan.id, 'nextDueDate', lockedPlan.nextDueDate, next, `Review ${id} completed (${input.conclusion})`);
      }
      return {
        recordVersion: row.version,
        audit: { action: 'Complete', field: 'status', oldValue: 'Open', newValue: 'Completed', reason: input.reason },
        result: row,
      };
    },
  });
}

/** Open reviews and plans that are due within `horizonDays` (default 30) or overdue: what the QA dashboard and the review screen list. */
export async function dueReviews(db: Db, now = new Date(), horizonDays = 30) {
  const today = utcToday(now);
  const horizon = utcToday(new Date(now.getTime() + horizonDays * 86_400_000));
  const open = await db.select().from(periodicReviews).where(and(eq(periodicReviews.status, 'Open'), sql`${periodicReviews.dueDate} <= ${horizon}`)).orderBy(asc(periodicReviews.dueDate), asc(periodicReviews.id));
  const plans = await db.select().from(periodicReviewPlans).where(and(eq(periodicReviewPlans.status, 'Active'), sql`${periodicReviewPlans.nextDueDate} <= ${horizon}`,
    sql`NOT EXISTS (SELECT 1 FROM periodic_reviews r WHERE r.plan_id = ${periodicReviewPlans.id} AND r.status = 'Open')`)).orderBy(asc(periodicReviewPlans.nextDueDate), asc(periodicReviewPlans.id));
  const item = (id: string, kind: string, subjectId: string, title: string, dueDate: string, opened: boolean) => ({
    id, kind, subjectId, title, dueDate, opened, daysRemaining: daysBetween(today, dueDate), overdue: dueDate < today,
  });
  const items = [
    ...open.map(r => item(r.id, r.kind, r.subjectId, r.title, r.dueDate, true)),
    ...plans.map(p => item(p.id, p.kind, p.subjectId, p.title, p.nextDueDate, false)),
  ].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : 1));
  return { today, horizonDays, overdue: items.filter(i => i.overdue).length, items };
}

export type { Tx };
