/**
 * The OOS investigation workflow (roadmap M26; FDA guidance "Investigating OOS Test Results", 21 CFR 211.192). Owned by r2-oos-workflow.
 *
 *   due dates     Phase I is due `phase1DueDays` after the date raised (until a due date is stored); moving to Phase II stores the
 *                 Phase II due date (`phase2DueDays` from that day). An open investigation past its due date is overdue.
 *   tasks         from a checklist template (once per template) or added by hand; completed (Done / Not applicable) with a finding, then
 *                 frozen.
 *   cause         Phase I only: the investigator records an assignable cause (category from the coded OOS reasons); QA who is neither
 *                 the investigator, the author of the cause nor the original analyst confirms it with a signature (OOS_INVALIDATION),
 *                 which invalidates the original result. The cause is frozen once confirmed.
 *   retest plan   one per investigation, signed by QA (OOS_RETEST_AUTHORISATION) before any retest: after a confirmed cause (basis
 *                 "Assignable cause") or in Phase II (basis "Phase II protocol"), with a justification and a maximum number of retests
 *                 no larger than the settings allow.
 *   retests       entered by an Analyst or Admin who did not enter the original OOS value (setting retestAnalystMustDiffer), evaluated
 *                 against the limit of the original result, numbered; refused once the plan's maximum is reached.
 *   closure       src/server/routes/oos.ts, with the rule of src/lib/validations/oos.ts (oosClosureProblems).
 *   settings      changed only with an e-signature (OOS_SETTING_CHANGE).
 * Every write is audited in its own transaction; a refused signed step is refused before the password is checked, and checked again
 * inside the signing transaction.
 */
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { and, asc, count, desc, eq, inArray, notInArray, or } from 'drizzle-orm';
import { auditTrail, signatures, users } from '../../db/schema';
import { oosChecklistTemplates, oosInvestigations, oosRetestPlans, oosRetests, oosSettings, oosTasks } from '../../db/schema/oos';
import { qmsLinks, qmsRecords } from '../../db/schema/qms';
import { resultVersions } from '../../db/schema/rawdata';
import { results } from '../../db/schema/samples';
import { writeAudit } from '../../db/utils';
import { OOS_TERMINAL_STATUSES, isTerminalOosStatus, oosStage } from '../../lib/constants/oos';
import { RESULT_ENTRY_ROLES } from '../../lib/constants/results';
import { phase2Reached, type OosClosureState } from '../../lib/validations/oos';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Executor } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { evaluateResult, limitOfResult } from '../lib/evaluate';
import { todayIso } from '../lib/specs';
import { assertResultGuards } from '../services/result-guards';
import { assertEditable } from '../workflow/entityStates';
import './entities';

export interface Actor { id: string; role: string }
type Inv = typeof oosInvestigations.$inferSelect;
type Credentials = { password: string; totpCode?: string };

// ---- settings --------------------------------------------------------------------------------------------------------------------

export const SETTINGS_ID = 'default';
const DEFAULT_SETTINGS = { id: SETTINGS_ID, retestAnalystMustDiffer: true, maxRetests: 2, phase1DueDays: 10, phase2DueDays: 30, updatedBy: null, updatedAt: null, version: 1 };
export type OosSettings = Pick<typeof oosSettings.$inferSelect, 'retestAnalystMustDiffer' | 'maxRetests' | 'phase1DueDays' | 'phase2DueDays' | 'version'>;

export async function getOosSettings(ex: Executor) {
  const [row] = await ex.select().from(oosSettings).where(eq(oosSettings.id, SETTINGS_ID)).limit(1);
  // Installed by migration 0210; a database without the row has the installed defaults.
  return row ?? DEFAULT_SETTINGS;
}

// ---- due dates -------------------------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `days` calendar days after the YYYY-MM-DD date `day`. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return todayIso(new Date(y, m - 1, d + days));
}
const dayNumber = (day: string) => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };

/** The due date of the investigation's current phase: the stored one, or the date raised plus the Phase I period. */
export function dueDateOf(row: Pick<Inv, 'dueDate' | 'dateRaised'>, settings: Pick<OosSettings, 'phase1DueDays'>): string | null {
  if (row.dueDate) return row.dueDate;
  const raised = (row.dateRaised ?? '').slice(0, 10);
  return DATE.test(raised) ? addDays(raised, settings.phase1DueDays) : null;
}

/** Open and past its due date (the due day itself is not overdue). */
export function isOverdueOos(row: Pick<Inv, 'status' | 'dueDate' | 'dateRaised'>, settings: Pick<OosSettings, 'phase1DueDays'>, today = todayIso()): boolean {
  const due = dueDateOf(row, settings);
  return !isTerminalOosStatus(row.status) && !!due && due < today;
}

/** How the investigation is shown everywhere: its stage, due date and whether it is overdue. */
export function presentOos<T extends Inv>(row: T, settings: Pick<OosSettings, 'phase1DueDays'>, today = todayIso()) {
  return { ...row, stage: oosStage(row), dueDate: dueDateOf(row, settings), overdue: isOverdueOos(row, settings, today) };
}

/** The open investigations past their due date, the most overdue first (the dashboard and the OOS screen show them). */
export async function listOverdue(ex: Executor, today = todayIso()) {
  const settings = await getOosSettings(ex);
  const open = await ex.select().from(oosInvestigations).where(notInArray(oosInvestigations.status, [...OOS_TERMINAL_STATUSES]));
  return open.filter(o => isOverdueOos(o, settings, today))
    .map(o => {
      const dueDate = dueDateOf(o, settings)!;
      return { id: o.id, sampleId: o.sampleId, parameter: o.parameter, stage: oosStage(o), assignedTo: o.assignedTo, dueDate, daysOverdue: dayNumber(today) - dayNumber(dueDate) };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.id.localeCompare(b.id));
}

/** The values PUT /oos/:id writes with a move to Phase II: when it started and its due date. */
export function phase2Start(settings: Pick<OosSettings, 'phase2DueDays'>, now = new Date()) {
  return { phase2StartedAt: now, dueDate: addDays(todayIso(now), settings.phase2DueDays) };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------

/** The analysts who entered an OOS value of the result (its versions; the result row itself for a value older than 0120). */
export async function originalAnalysts(ex: Executor, resultId: string): Promise<string[]> {
  const versions = await ex.selectDistinct({ by: resultVersions.enteredBy }).from(resultVersions)
    .where(and(eq(resultVersions.resultId, resultId), eq(resultVersions.isOos, true)));
  const ids = new Set(versions.map(v => v.by).filter((x): x is string => !!x));
  const [r] = await ex.select({ by: results.enteredBy, isOos: results.isOos }).from(results).where(eq(results.id, resultId)).limit(1);
  if (r?.isOos && r.by) ids.add(r.by);
  return [...ids].sort();
}

/**
 * Everyone who has been the investigator: the assignee now and every assignee before, read from the audit entries of PUT /oos/:id
 * (field assigned_to). Handing the investigation over does not make its investigator independent of it.
 */
export async function investigatorsOf(ex: Executor, inv: Pick<Inv, 'id' | 'assignedTo'>): Promise<string[]> {
  const rows = await ex.select({ oldValue: auditTrail.oldValue, newValue: auditTrail.newValue }).from(auditTrail)
    .where(and(eq(auditTrail.entity, 'OOS'), eq(auditTrail.entityId, inv.id), eq(auditTrail.field, 'assigned_to')));
  const ids = new Set(rows.flatMap(r => [r.oldValue, r.newValue]).filter(Boolean));
  if (inv.assignedTo) ids.add(inv.assignedTo);
  return [...ids].sort();
}

async function loadInv(ex: Executor, id: string): Promise<Inv> {
  const [row] = await ex.select().from(oosInvestigations).where(eq(oosInvestigations.id, id)).limit(1);
  if (!row) throw new NotFoundError('OOS investigation record not found');
  return row;
}

const tasksOf = (ex: Executor, id: string) => ex.select().from(oosTasks).where(eq(oosTasks.oosId, id)).orderBy(asc(oosTasks.createdAt), asc(oosTasks.id));
const planOf = (ex: Executor, id: string) => ex.select().from(oosRetestPlans).where(eq(oosRetestPlans.oosId, id)).limit(1).then(r => r[0] ?? null);
const retestsOf = (ex: Executor, id: string) => ex.select().from(oosRetests).where(eq(oosRetests.oosId, id)).orderBy(asc(oosRetests.seq));

/** What the closure rule needs (src/lib/validations/oos.ts oosClosureProblems), read from the database. */
export async function closureState(ex: Executor, inv: Inv): Promise<OosClosureState> {
  return {
    ...inv, originalAnalystIds: await originalAnalysts(ex, inv.resultId), investigatorIds: await investigatorsOf(ex, inv),
    tasks: await tasksOf(ex, inv.id), retests: await retestsOf(ex, inv.id),
  };
}

/** The quality records linked to the investigation (a deviation opened by a confirmed OOS, or linked by hand: roadmap M27). */
export async function linkedQmsRecords(ex: Executor, id: string) {
  return ex.selectDistinct({ id: qmsRecords.id, type: qmsRecords.type, title: qmsRecords.title, state: qmsRecords.state, classification: qmsRecords.classification, relation: qmsLinks.relation })
    .from(qmsLinks).innerJoin(qmsRecords, eq(qmsRecords.id, qmsLinks.recordId))
    .where(and(eq(qmsLinks.targetType, 'OOS'), eq(qmsLinks.targetId, id))).orderBy(qmsRecords.id);
}

/** GET /oos/:id: the investigation with its due date, tasks, retest plan, retests, linked quality records and signatures. */
export async function getDetail(ex: Executor, id: string) {
  const inv = await loadInv(ex, id);
  const settings = await getOosSettings(ex);
  const plan = await planOf(ex, id);
  const entityMatch = [and(inArray(signatures.entityType, ['OOS', 'OOSInvalidation']), eq(signatures.entityId, id))];
  if (plan) entityMatch.push(and(eq(signatures.entityType, 'OOSRetestPlan'), eq(signatures.entityId, plan.id)));
  const sigs = await ex.select({
    id: signatures.id, entityType: signatures.entityType, meaningCode: signatures.meaningCode, meaning: signatures.meaning, signerId: signatures.signerId,
    signerName: signatures.signerName, signerRole: signatures.signerRole, reason: signatures.reason, timestamp: signatures.timestamp, recordVersion: signatures.recordVersion,
  }).from(signatures).where(or(...entityMatch)).orderBy(asc(signatures.timestamp));
  return {
    ...presentOos(inv, settings),
    originalAnalystIds: await originalAnalysts(ex, inv.resultId),
    investigatorIds: await investigatorsOf(ex, inv),
    tasks: await tasksOf(ex, id),
    retestPlan: plan,
    retests: await retestsOf(ex, id),
    deviations: await linkedQmsRecords(ex, id),
    signatures: sigs,
  };
}

// ---- guards ----------------------------------------------------------------------------------------------------------------------

function assertOpen(inv: Inv) {
  // 423 once Closed (or v0.1.0's Approved); a status word outside the machine (the demo seed's 'Phase II QA Review') is refused too.
  assertEditable('oos', inv.status);
}

async function assertActiveUser(ex: Executor, userId: string | null | undefined, field: string) {
  if (!userId) return;
  const [u] = await ex.select({ active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.active) throw new BadRequestError(`${field}: ${userId} is not an active user.`);
}

/** 403 SOD_VIOLATION, recorded as AUTHZ_DENIED, when the actor is one of `excluded`. */
async function assertIndependent(db: Db, req: Request, actor: Actor, excluded: Array<string | null | undefined>, rule: string, id: string, message: string) {
  if (!excluded.includes(actor.id)) return;
  await recordDenied(db, req, actor, { rule, entity: 'OOS', entityId: id });
  throw new AppError(403, 'SOD_VIOLATION', message);
}

const newId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;
const phaseOf = (inv: Inv) => inv.phase ?? 'Phase I';

// ---- tasks -----------------------------------------------------------------------------------------------------------------------

export async function addTasks(db: Db, actor: Actor, id: string, body: { templateId?: string; title?: string; phase?: 'Phase I' | 'Phase II'; ownerId?: string | null; dueDate?: string | null }) {
  return withTransaction(db, async (tx) => {
    const inv = await lockRow(tx, oosInvestigations, id);
    assertOpen(inv);
    await assertActiveUser(tx, body.ownerId, 'ownerId');
    const base = { oosId: id, ownerId: body.ownerId ?? null, dueDate: body.dueDate ?? null, createdBy: actor.id, status: 'Open', version: 1 };
    let rows: Array<typeof oosTasks.$inferInsert>;
    let reason: string;
    if (body.templateId) {
      const [tpl] = await tx.select().from(oosChecklistTemplates).where(eq(oosChecklistTemplates.id, body.templateId)).limit(1);
      if (!tpl) throw new NotFoundError(`Checklist template ${body.templateId} was not found.`);
      if (!tpl.active) throw new AppError(409, 'TEMPLATE_INACTIVE', `Checklist template ${tpl.id} has been replaced by a newer version.`);
      const [{ n }] = await tx.select({ n: count() }).from(oosTasks).where(and(eq(oosTasks.oosId, id), eq(oosTasks.templateId, tpl.id)));
      if (Number(n) > 0) throw new AppError(409, 'TEMPLATE_APPLIED', `Checklist ${tpl.title} (v${tpl.version}) is already applied to ${id}.`);
      rows = tpl.items.map(item => ({ ...base, id: newId('OOST'), phase: tpl.phase, title: item.text, templateId: tpl.id, itemKey: item.key }));
      reason = `Checklist ${tpl.code} v${tpl.version} applied`;
    } else {
      rows = [{ ...base, id: newId('OOST'), phase: body.phase ?? (phaseOf(inv) === 'Phase I' ? 'Phase I' : 'Phase II'), title: body.title!, templateId: null, itemKey: null }];
      reason = 'Task added';
    }
    const inserted = await tx.insert(oosTasks).values(rows).returning();
    for (const t of inserted) await writeAudit(tx, actor.id, 'Create', 'OOSTask', t.id, 'all', '', JSON.stringify(t), `${reason} (${id})`);
    return inserted;
  });
}

export async function updateTask(db: Db, actor: Actor, id: string, taskId: string, body: { status?: 'Done' | 'Not applicable'; finding?: string; ownerId?: string | null; dueDate?: string | null; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const task = await lockRow(tx, oosTasks, taskId);
    if (task.oosId !== id) throw new NotFoundError(`Task ${taskId} is not a task of ${id}.`);
    assertOpen(await loadInv(tx, id));
    if (task.status !== 'Open') throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: task ${taskId} is ${task.status}; a completed task is not changed.`);
    if (task.version !== body.expectedVersion) throw new ConflictError();
    if (body.status && !body.finding) throw new BadRequestError('finding: completing a task needs the finding (what was checked and what was found).');
    await assertActiveUser(tx, body.ownerId, 'ownerId');

    const set: Partial<typeof oosTasks.$inferInsert> = {};
    if (body.ownerId !== undefined && body.ownerId !== task.ownerId) set.ownerId = body.ownerId;
    if (body.dueDate !== undefined && body.dueDate !== task.dueDate) set.dueDate = body.dueDate;
    if (body.finding !== undefined && body.finding !== task.finding) set.finding = body.finding;
    if (body.status) Object.assign(set, { status: body.status, completedBy: actor.id, completedAt: new Date() });
    if (Object.keys(set).length === 0) return task;
    const row = await updateVersioned(tx, oosTasks, taskId, body.expectedVersion, set);
    if (body.status) {
      // One entry for the completion: the finding is its reason.
      await writeAudit(tx, actor.id, 'Complete', 'OOSTask', taskId, 'status', task.status, body.status, body.finding!);
    } else if (set.finding !== undefined) {
      await writeAudit(tx, actor.id, 'Update', 'OOSTask', taskId, 'finding', task.finding ?? '', set.finding ?? '', 'Finding recorded');
    }
    if (set.ownerId !== undefined) await writeAudit(tx, actor.id, 'Update', 'OOSTask', taskId, 'owner_id', task.ownerId ?? '', set.ownerId ?? '', 'Task reassigned');
    if (set.dueDate !== undefined) await writeAudit(tx, actor.id, 'Update', 'OOSTask', taskId, 'due_date', task.dueDate ?? '', set.dueDate ?? '', 'Task due date changed');
    return row;
  });
}

// ---- assignable cause and invalidation -------------------------------------------------------------------------------------------

function assertCauseOpen(inv: Inv) {
  if (inv.invalidatedAt) throw new AppError(409, 'CAUSE_CONFIRMED', `The assignable cause of ${inv.id} is confirmed and the original result invalidated; it is not changed.`);
  if (phaseOf(inv) !== 'Phase I') {
    throw new AppError(409, 'NOT_PHASE_I', `An assignable laboratory cause is established in Phase I; ${inv.id} is in ${phaseOf(inv)}.`);
  }
}

export async function recordCause(db: Db, actor: Actor, id: string, body: { category: string; description: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const inv = await lockRow(tx, oosInvestigations, id);
    assertOpen(inv);
    if (inv.version !== body.expectedVersion) throw new ConflictError();
    assertCauseOpen(inv);
    const row = await updateVersioned(tx, oosInvestigations, id, body.expectedVersion, {
      assignableCauseCategory: body.category, assignableCause: body.description, assignableCauseBy: actor.id, assignableCauseAt: new Date(),
    });
    await writeAudit(tx, actor.id, 'Update', 'OOS', id, 'assignable_cause',
      inv.assignableCause ? `[${inv.assignableCauseCategory}] ${inv.assignableCause}` : '', `[${body.category}] ${body.description}`, 'Assignable cause recorded (Phase I)');
    return row;
  });
}

function assertConfirmable(inv: Inv, expectedVersion: number) {
  assertOpen(inv);
  if (inv.version !== expectedVersion) throw new ConflictError();
  assertCauseOpen(inv);
  if (!inv.assignableCause) throw new AppError(409, 'NO_ASSIGNABLE_CAUSE', `No assignable cause is recorded on ${inv.id}: the investigator records it first.`);
}

export async function confirmCause(db: Db, req: Request, actor: Actor, id: string, body: Credentials & { reason: string; expectedVersion: number }) {
  const inv = await loadInv(db, id);
  assertConfirmable(inv, body.expectedVersion);
  await assertIndependent(db, req, actor, [...await investigatorsOf(db, inv), inv.assignableCauseBy, ...await originalAnalysts(db, inv.resultId)], 'oos.independent-invalidation', id,
    `You investigate or investigated ${id}, recorded its cause or entered the original result: another member of the quality unit must confirm the cause.`);
  return signRecord({
    db, user: actor, meaningCode: 'OOS_INVALIDATION', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'OOSInvalidation', entityId: id, sampleId: inv.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const current = await lockRow(tx, oosInvestigations, id);
      assertConfirmable(current, body.expectedVersion);
      const row = await updateVersioned(tx, oosInvestigations, id, body.expectedVersion, { invalidatedBy: actor.id, invalidatedAt: new Date() });
      return {
        recordVersion: row.version,
        audit: { action: 'Invalidate result', field: 'invalidated', oldValue: '', newValue: `${current.resultId}: [${current.assignableCauseCategory}] ${current.assignableCause}`, reason: body.reason },
        result: row,
      };
    },
  });
}

// ---- retest plan and retests -----------------------------------------------------------------------------------------------------

async function assertPlannable(ex: Executor, inv: Inv, expectedVersion: number, maxRetests: number) {
  assertOpen(inv);
  if (inv.version !== expectedVersion) throw new ConflictError();
  const settings = await getOosSettings(ex);
  if (maxRetests > settings.maxRetests) throw new BadRequestError(`maxRetests: the settings allow at most ${settings.maxRetests} retests per plan.`);
  if (await planOf(ex, inv.id)) throw new AppError(409, 'PLAN_EXISTS', `${inv.id} already has a retest plan; the number of retests is fixed by it.`);
  if (inv.invalidatedAt) return 'Assignable cause' as const;
  if (phase2Reached(inv)) return 'Phase II protocol' as const;
  throw new AppError(409, 'RETEST_NOT_AUTHORISABLE', `A retest is authorised after QA has confirmed an assignable cause (Phase I) or under the Phase II protocol; ${inv.id} has neither.`);
}

export async function authoriseRetests(db: Db, req: Request, actor: Actor, id: string, body: Credentials & { justification: string; maxRetests: number; reason?: string; expectedVersion: number }) {
  const inv = await loadInv(db, id);
  await assertPlannable(db, inv, body.expectedVersion, body.maxRetests);
  await assertIndependent(db, req, actor, [...await investigatorsOf(db, inv), ...await originalAnalysts(db, inv.resultId)], 'oos.independent-retest-authorisation', id,
    `You investigate or investigated ${id}, or entered the original result: another member of the quality unit must authorise its retests.`);
  const planId = newId('OOSRP');
  return signRecord({
    db, user: actor, meaningCode: 'OOS_RETEST_AUTHORISATION', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason ?? body.justification,
    entityType: 'OOSRetestPlan', entityId: planId, sampleId: inv.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const current = await lockRow(tx, oosInvestigations, id);
      const basis = await assertPlannable(tx, current, body.expectedVersion, body.maxRetests);
      const [plan] = await tx.insert(oosRetestPlans).values({
        id: planId, oosId: id, retestOf: current.resultId, basis, justification: body.justification, maxRetests: body.maxRetests, approvedBy: actor.id,
      }).returning();
      return {
        recordVersion: 1,
        audit: { action: 'Authorise retests', field: 'retest_plan', oldValue: '', newValue: JSON.stringify({ oosId: id, basis, maxRetests: body.maxRetests }), reason: body.justification },
        result: plan,
      };
    },
  }).then(({ result, signature }) => ({ plan: result, signature }));
}

export async function recordRetest(db: Db, req: Request, actor: Actor, id: string, body: { value: string; instrumentId?: string; reason: string }, now = new Date()) {
  const inv = await loadInv(db, id);
  assertOpen(inv);
  const plan = await planOf(db, id);
  if (!plan) throw new AppError(409, 'NO_RETEST_PLAN', `No retest is authorised for ${id}: QA signs a retest plan first.`);
  if (!RESULT_ENTRY_ROLES.includes(actor.role)) {
    throw new ForbiddenError(`Forbidden: retests are entered by ${RESULT_ENTRY_ROLES.join(' or ')}; a ${actor.role} reviews them.`);
  }
  const settings = await getOosSettings(db);
  if (settings.retestAnalystMustDiffer) {
    await assertIndependent(db, req, actor, await originalAnalysts(db, inv.resultId), 'oos.retest-second-analyst', id,
      `You entered the original OOS result of ${id}: the retest is performed by another analyst.`);
  }

  return withTransaction(db, async (tx) => {
    // The investigation lock serialises retests, so two at once cannot both take the last place of the plan.
    const current = await lockRow(tx, oosInvestigations, id);
    assertOpen(current);
    const [{ n }] = await tx.select({ n: count() }).from(oosRetests).where(eq(oosRetests.planId, plan.id));
    if (Number(n) >= plan.maxRetests) {
      throw new AppError(409, 'RETEST_LIMIT', `The retest plan of ${id} authorises ${plan.maxRetests} retest(s); all have been performed.`);
    }
    const [original] = await tx.select().from(results).where(eq(results.id, plan.retestOf)).limit(1);
    const evaluation = evaluateResult(body.value, limitOfResult(original));
    if (!evaluation.ok) throw new BadRequestError(`${original.parameter}: ${evaluation.error}`);
    // The result guards of the original result (instrument, method, SST) apply to its retest; userId is for the analyst-qualification
    // guard of r2-docs-training, which reads it once its gate adds it to ResultGuardInput.
    const guardInput = { sampleId: original.sampleId, resultId: original.id, instrumentId: body.instrumentId, now, userId: actor.id };
    await assertResultGuards(tx, guardInput);
    const [row] = await tx.insert(oosRetests).values({
      id: newId('OOSRT'), planId: plan.id, oosId: id, retestOf: plan.retestOf, seq: Number(n) + 1, value: evaluation.value, isOos: evaluation.isOos,
      analystId: actor.id, instrumentId: body.instrumentId ?? null, reason: body.reason, recordedAt: now,
    }).returning();
    await writeAudit(tx, actor.id, 'Create', 'OOSRetest', row.id, 'value', '', `${row.value}${row.isOos ? ' (OOS)' : ''}`, `Retest ${row.seq} of ${plan.maxRetests} for ${id}: ${body.reason}`);
    return row;
  });
}

// ---- settings and templates ------------------------------------------------------------------------------------------------------

export async function updateSettings(db: Db, req: Request, actor: Actor, body: Credentials & Omit<OosSettings, 'version'> & { reason: string; expectedVersion: number }) {
  const before = await getOosSettings(db);
  if (before.version !== body.expectedVersion) throw new ConflictError();
  const next = { retestAnalystMustDiffer: body.retestAnalystMustDiffer, maxRetests: body.maxRetests, phase1DueDays: body.phase1DueDays, phase2DueDays: body.phase2DueDays };
  const was = { retestAnalystMustDiffer: before.retestAnalystMustDiffer, maxRetests: before.maxRetests, phase1DueDays: before.phase1DueDays, phase2DueDays: before.phase2DueDays };
  if (JSON.stringify(next) === JSON.stringify(was)) throw new AppError(409, 'NO_CHANGE', 'The OOS settings already have these values.');
  return signRecord({
    db, user: actor, meaningCode: 'OOS_SETTING_CHANGE', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'OOSSettings', entityId: SETTINGS_ID, context: securityEventContext(req),
    execute: async (tx) => {
      await tx.insert(oosSettings).values({ id: SETTINGS_ID }).onConflictDoNothing();
      const row = await updateVersioned(tx, oosSettings, SETTINGS_ID, body.expectedVersion, { ...next, updatedBy: actor.id, updatedAt: new Date() });
      return { recordVersion: row.version, audit: { action: 'SettingChange', field: 'oos_settings', oldValue: JSON.stringify(was), newValue: JSON.stringify(next), reason: body.reason }, result: row };
    },
  }).then(({ result, signature }) => ({ settings: result, signature }));
}

export const listTemplates = (ex: Executor) =>
  ex.select().from(oosChecklistTemplates).orderBy(asc(oosChecklistTemplates.code), desc(oosChecklistTemplates.version));

export async function addTemplate(db: Db, actor: Actor, body: { code: string; phase: 'Phase I' | 'Phase II'; title: string; items: Array<{ key: string; text: string }> }) {
  return withTransaction(db, async (tx) => {
    const previous = await tx.select().from(oosChecklistTemplates).where(eq(oosChecklistTemplates.code, body.code)).orderBy(desc(oosChecklistTemplates.version)).for('update');
    const version = (previous[0]?.version ?? 0) + 1;
    for (const p of previous.filter(p => p.active)) {
      await tx.update(oosChecklistTemplates).set({ active: false }).where(eq(oosChecklistTemplates.id, p.id));
      await writeAudit(tx, actor.id, 'Update', 'OOSChecklistTemplate', p.id, 'active', 'true', 'false', `Replaced by version ${version}`);
    }
    const [row] = await tx.insert(oosChecklistTemplates).values({ id: `OOSCT-${body.code}-${version}`, ...body, version, createdBy: actor.id }).returning();
    await writeAudit(tx, actor.id, 'Create', 'OOSChecklistTemplate', row.id, 'all', '', JSON.stringify(row), `Checklist ${body.code} version ${version}`);
    return row;
  });
}
