/**
 * Worklists and batch runs (roadmap M33). Every write is one transaction with its audit entry (AGENTS.md section 2); a version
 * predicate guards every update. The rules:
 *
 *   method        a worklist is one run of one method with an Effective revision; a Sample item is a result of a parameter bound to
 *                 that method (the specification binding, result-guards/method.ts). Unbound results are not worklisted.
 *   assignee      a Sample item names the analyst who runs it: an active Analyst or Admin who is qualified for the method
 *                 (r2-docs-training qualificationFor: no overdue mandatory training of the method; a QA override is accepted and
 *                 audited). Otherwise 400 naming the method and the overdue training.
 *   instrument    the worklist's instrument must be Active, within calibration and of the type the method names; checked when it is
 *                 set, when an item is added and at release.
 *   duplicate     a result is on one Draft or Released worklist at a time (409 naming it); a result that has a value is not worklisted.
 *   release       Draft -> Released freezes the membership. From then on adding, changing, removing or reordering items, and
 *                 changing the header, needs a reason (400), and a change refused for want of one is itself audited (ChangeRefused).
 *   enforcement   while Released, only the assignee may enter the result: result-guards/assignment.ts (403 NOT_ASSIGNED).
 *
 * Membership changes lock the worklist row and bump its version, so a release (which carries expectedVersion) never freezes a
 * membership the releaser has not seen.
 */
import { randomBytes } from 'crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { results, samples, users, instruments } from '../../db/schema';
import { worklistItems, worklists } from '../../db/schema/worklists';
import { writeAudit } from '../../db/utils';
import { RESULT_ENTRY_ROLES } from '../../lib/constants/results';
import { calibrationState } from '../../lib/validations/instruments';
import type { Db } from '../core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { todayIso } from '../lib/specs';
import { bindingOfResult, methodByCode } from '../services/result-guards/method';
import { qualificationFor } from '../training/status';
import { ITEM_KINDS } from './schemas';

export interface Actor { id: string; role: string }
export type WorklistRow = typeof worklists.$inferSelect;
export type ItemRow = typeof worklistItems.$inferSelect;

/** The states of a sample that can still be planned: results are entered in Testing; a Logged sample starts testing on the day. */
const PLANNABLE_SAMPLE_STATES = ['Logged', 'Testing'];
/** The roles that run a method on the bench. 'Instrument' is the service account of an API client, never an analyst. */
const ANALYST_ROLES = RESULT_ENTRY_ROLES.filter(r => r !== 'Instrument');

const rowsOf = <T = any>(res: unknown): T[] => (res as { rows: T[] }).rows;
const itemId = () => `wli-${randomBytes(8).toString('hex')}`;
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** A change that needs a reason because the worklist is Released. Raised inside the transaction; audited outside it (see `change`). */
class ReasonRequiredError extends BadRequestError {
  constructor(message: string, readonly attempt: { op: string; target?: string }) { super(message); }
}

export async function nextWorklistId(ex: Executor, now = new Date()): Promise<string> {
  const year = now.getFullYear();
  return `WL-${year}-${String(await nextSequence(ex, `worklist:${year}`)).padStart(4, '0')}`;
}

async function loadWorklist(ex: Executor, id: string): Promise<WorklistRow> {
  const [w] = await ex.select().from(worklists).where(eq(worklists.id, id)).limit(1);
  if (!w) throw new NotFoundError(`Worklist ${id} was not found.`);
  return w;
}

const activeItems = (ex: Executor, worklistId: string) =>
  ex.select().from(worklistItems).where(and(eq(worklistItems.worklistId, worklistId), eq(worklistItems.status, 'Active'))).orderBy(asc(worklistItems.position));

/**
 * Runs a change of a worklist's content in one transaction. A ReasonRequiredError is the one refusal that is audited: it is written in a
 * transaction of its own, after the failed one has rolled back, so the record of the attempt survives (Part 11 11.10(e)).
 */
async function change<T>(db: Db, actor: Actor, worklistId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(db, tx => work(tx));
  } catch (e) {
    if (e instanceof ReasonRequiredError) {
      await db.transaction(tx => writeAudit(tx, actor.id, 'ChangeRefused', 'Worklist', worklistId, 'content', '', JSON.stringify(e.attempt), `Refused: ${e.message}`));
    }
    throw e;
  }
}

/** On a Released worklist a change needs a reason; on a Draft it does not. Returns the reason to audit. */
function reasonFor(w: WorklistRow, reason: string | undefined, fallback: string, attempt: { op: string; target?: string }): string {
  if (w.status === 'Released') {
    if (!reason) throw new ReasonRequiredError(`Worklist ${w.id} is Released: its membership is frozen, so this change needs a reason. Nothing was changed.`, attempt);
    return reason;
  }
  return reason ?? fallback;
}

function assertOpen(w: WorklistRow) {
  if (w.status === 'Completed' || w.status === 'Cancelled') {
    throw new AppError(409, 'WORKLIST_CLOSED', `Worklist ${w.id} is ${w.status}; it can no longer be changed.`);
  }
}

// ---- rules ---------------------------------------------------------------------------------------------------------------------

/** The instrument must exist, be Active, be within calibration and be of the type the method is run on. Throws 400 naming it. */
async function assertInstrumentFit(ex: Executor, instrumentId: string, method: { code: string; instrumentType: string | null }, now = new Date()) {
  const [inst] = await ex.select().from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  if (!inst) throw new BadRequestError(`Instrument ${instrumentId} does not exist.`);
  if (inst.status !== 'Active') throw new BadRequestError(`Instrument ${inst.id} (${inst.name}) is ${inst.status}; only an Active instrument can be planned.`);
  if (calibrationState(inst.calibrationDueDate, now).expired) {
    throw new BadRequestError(`Instrument ${inst.id} (${inst.name}) is past its calibration due date (${inst.calibrationDueDate}); it cannot be planned for a run.`);
  }
  if (method.instrumentType && !same(inst.type, method.instrumentType)) {
    throw new BadRequestError(`Method ${method.code} is run on a ${method.instrumentType}; instrument ${inst.id} is a ${inst.type}.`);
  }
  return inst;
}

/** The analyst must be active, an Analyst or Admin, and qualified for the method. Returns the QA override id when the qualification rests on one. */
async function assertAssignable(ex: Executor, userId: string, methodCode: string, now = new Date()): Promise<{ name: string; overrideId: string | null }> {
  const [u] = await ex.select({ id: users.id, name: users.name, role: users.role, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new BadRequestError(`User ${userId} does not exist.`);
  if (!u.active) throw new BadRequestError(`${u.name} is deactivated and cannot be assigned work.`);
  if (!ANALYST_ROLES.includes(u.role)) throw new BadRequestError(`${u.name} is a ${u.role}; results are entered by ${ANALYST_ROLES.join(' or ')}.`);
  const q = await qualificationFor(ex, userId, methodCode, todayIso(now));
  if (q.status === 'NotQualified') {
    const modules = await trainingModulesOf(ex, q.overdue);
    throw new BadRequestError(`${u.name} is not qualified for method ${methodCode}: the training module ${modules.join(', ')} is overdue (assignment ${q.overdue.join(', ')}). Complete the training, or ask QA for a signed qualification override.`,
      [{ path: 'assigneeId', message: `Training overdue for method ${methodCode}: ${modules.join(', ')}` }]);
  }
  return { name: u.name, overrideId: q.status === 'Override' ? q.overrideId : null };
}

async function trainingModulesOf(ex: Executor, assignmentIds: string[]): Promise<string[]> {
  if (assignmentIds.length === 0) return [];
  const res = await ex.execute(sql`
    SELECT DISTINCT c.code || ' (' || c.title || ')' AS module
      FROM training_assignments a JOIN training_curricula c ON c.id = a.curriculum_id
     WHERE a.id IN (${sql.join(assignmentIds.map(i => sql`${i}`), sql`, `)})`);
  return rowsOf<{ module: string }>(res).map(r => r.module).sort();
}

async function methodOf(ex: Executor, code: string) {
  const method = await methodByCode(ex, code);
  if (!method) throw new BadRequestError(`Method ${code} does not exist.`);
  if (method.status !== 'Effective') throw new BadRequestError(`Method ${method.code} has no Effective revision (revision ${method.revision} is ${method.status}); worklists are planned only for an Effective method.`);
  return method;
}

// ---- worklists -----------------------------------------------------------------------------------------------------------------

export interface WorklistCreate { title: string; methodCode: string; instrumentId?: string; plannedDate: string; notes?: string }

export async function createWorklist(db: Db, actor: Actor, input: WorklistCreate) {
  return withTransaction(db, async (tx) => {
    const method = await methodOf(tx, input.methodCode);
    if (input.instrumentId) await assertInstrumentFit(tx, input.instrumentId, method);
    const row = {
      id: await nextWorklistId(tx), title: input.title, methodCode: method.code, instrumentId: input.instrumentId ?? null,
      plannedDate: input.plannedDate, status: 'Draft', notes: input.notes ?? null, createdBy: actor.id, version: 1,
    };
    await tx.insert(worklists).values(row);
    await writeAudit(tx, actor.id, 'Create', 'Worklist', row.id, 'all', '', JSON.stringify(row), `Worklist ${row.id} planned for method ${method.code} on ${row.plannedDate}`);
    return loadWorklist(tx, row.id);
  });
}

export interface WorklistUpdate { title?: string; instrumentId?: string | null; plannedDate?: string; notes?: string | null; reason?: string; expectedVersion: number }

export async function updateWorklist(db: Db, actor: Actor, id: string, input: WorklistUpdate) {
  return change(db, actor, id, async (tx) => {
    const w = await lockRow(tx, worklists, id);
    assertOpen(w);
    if (w.version !== input.expectedVersion) throw new ConflictError();
    const reason = reasonFor(w, input.reason, 'Draft worklist edited', { op: 'update' });
    const set: Partial<typeof worklists.$inferInsert> = {};
    const diffs: Array<[string, string, string]> = [];
    const note = (field: string, before: string | null, after: string | null) => diffs.push([field, before ?? '', after ?? '']);
    if (input.title !== undefined && input.title !== w.title) { set.title = input.title; note('title', w.title, input.title); }
    if (input.plannedDate !== undefined && input.plannedDate !== w.plannedDate) { set.plannedDate = input.plannedDate; note('plannedDate', w.plannedDate, input.plannedDate); }
    if (input.notes !== undefined && (input.notes ?? null) !== w.notes) { set.notes = input.notes; note('notes', w.notes, input.notes); }
    if (input.instrumentId !== undefined && (input.instrumentId ?? null) !== w.instrumentId) {
      if (input.instrumentId) await assertInstrumentFit(tx, input.instrumentId, await methodOf(tx, w.methodCode));
      set.instrumentId = input.instrumentId; note('instrumentId', w.instrumentId, input.instrumentId);
    }
    if (diffs.length === 0) throw new BadRequestError('Nothing changed: the values given are the ones recorded.');
    const updated = await updateVersioned(tx, worklists, id, input.expectedVersion, set);
    for (const [field, before, after] of diffs) await writeAudit(tx, actor.id, 'Update', 'Worklist', id, field, before, after, reason);
    return updated;
  });
}

export async function releaseWorklist(db: Db, actor: Actor, id: string, expectedVersion: number) {
  return withTransaction(db, async (tx) => {
    const w = await lockRow(tx, worklists, id);
    if (w.version !== expectedVersion) throw new ConflictError();
    if (w.status !== 'Draft') throw new AppError(409, 'WORKLIST_NOT_DRAFT', `Worklist ${id} is ${w.status}; only a Draft is released.`);
    const items = await activeItems(tx, id);
    const problems: string[] = [];
    if (!items.some(i => i.kind === 'Sample')) problems.push('it has no Sample item');
    const collect = async <T>(work: Promise<T>): Promise<T | null> => {
      try { return await work; } catch (e) { if (!(e instanceof AppError)) throw e; problems.push(e.message); return null; }
    };
    const method = await collect(methodOf(tx, w.methodCode));
    if (method && w.instrumentId) await collect(assertInstrumentFit(tx, w.instrumentId, method));
    if (method) {
      const seen = new Set<string>();
      for (const i of items) {
        if (i.assigneeId && !seen.has(i.assigneeId)) {
          seen.add(i.assigneeId);
          await collect(assertAssignable(tx, i.assigneeId, w.methodCode));
        }
        if (i.sampleId) {
          const [s] = await tx.select({ state: samples.state }).from(samples).where(eq(samples.id, i.sampleId)).limit(1);
          if (!s || !PLANNABLE_SAMPLE_STATES.includes(s.state)) problems.push(`sample ${i.sampleId} is ${s?.state ?? 'missing'}`);
        }
      }
    }
    if (problems.length > 0) {
      throw new AppError(409, 'RELEASE_BLOCKED', `Worklist ${id} cannot be released: ${[...new Set(problems)].join('; ')}.`, problems.map(message => ({ path: 'release', message })));
    }
    const updated = await updateVersioned(tx, worklists, id, expectedVersion, { status: 'Released', releasedBy: actor.id, releasedAt: new Date() });
    await writeAudit(tx, actor.id, 'Release', 'Worklist', id, 'status', 'Draft', 'Released', `Worklist released with ${items.length} item(s); membership is frozen`);
    return updated;
  });
}

export async function closeWorklist(db: Db, actor: Actor, id: string, kind: 'Completed' | 'Cancelled', input: { reason?: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const w = await lockRow(tx, worklists, id);
    if (w.version !== input.expectedVersion) throw new ConflictError();
    if (kind === 'Completed' && w.status !== 'Released') throw new AppError(409, 'WORKLIST_NOT_RELEASED', `Worklist ${id} is ${w.status}; only a Released worklist is completed.`);
    if (kind === 'Cancelled' && w.status !== 'Draft' && w.status !== 'Released') throw new AppError(409, 'WORKLIST_CLOSED', `Worklist ${id} is ${w.status}; it can no longer be changed.`);
    const items = await activeItems(tx, id);
    const [{ n: open }] = rowsOf<{ n: number }>(await tx.execute(sql`
      SELECT count(*)::int AS n FROM worklist_items i JOIN results r ON r.id = i.result_id
       WHERE i.worklist_id = ${id} AND i.status = 'Active' AND (r.value IS NULL OR r.value = '')`));
    const reason = input.reason ?? (kind === 'Completed' ? 'Run completed' : 'Cancelled');
    const updated = await updateVersioned(tx, worklists, id, input.expectedVersion, { status: kind, closedBy: actor.id, closedAt: new Date(), closeReason: reason });
    await writeAudit(tx, actor.id, kind === 'Completed' ? 'Complete' : 'Cancel', 'Worklist', id, 'status', w.status, kind,
      `${reason} (${items.length} item(s), ${open} result(s) without a value)`);
    return updated;
  });
}

// ---- items ---------------------------------------------------------------------------------------------------------------------

export interface ItemAdd { kind: (typeof ITEM_KINDS)[number]; sampleId?: string; resultId?: string; label?: string; assigneeId?: string; reason?: string }

export async function addItem(db: Db, actor: Actor, worklistId: string, input: ItemAdd) {
  return change(db, actor, worklistId, async (tx) => {
    const w = await lockRow(tx, worklists, worklistId);
    assertOpen(w);
    const reason = reasonFor(w, input.reason, 'Added to draft worklist', { op: 'add', target: input.resultId ?? input.label });
    const method = await methodOf(tx, w.methodCode);
    if (w.instrumentId) await assertInstrumentFit(tx, w.instrumentId, method);

    let note = '';
    if (input.kind === 'Sample') {
      // The result row is locked: two worklists adding the same result at once queue here, and the second sees the first.
      const [result] = await tx.select().from(results).where(eq(results.id, input.resultId!)).for('update');
      if (!result || result.sampleId !== input.sampleId) throw new NotFoundError(`Result ${input.resultId} is not a result of sample ${input.sampleId}.`);
      const [sample] = await tx.select({ state: samples.state }).from(samples).where(eq(samples.id, result.sampleId)).limit(1);
      if (!PLANNABLE_SAMPLE_STATES.includes(sample.state)) {
        throw new AppError(409, 'SAMPLE_NOT_PLANNABLE', `Sample ${result.sampleId} is ${sample.state}; only a Logged or Testing sample is put on a worklist.`);
      }
      if (result.value !== null && result.value !== '') {
        throw new AppError(409, 'RESULT_ALREADY_ENTERED', `${result.parameter} of sample ${result.sampleId} already has a value; it is not tested again from a worklist (use a correction or an OOS retest).`);
      }
      const binding = await bindingOfResult(tx, result.id);
      if (!same(binding?.methodCode, w.methodCode)) {
        throw new BadRequestError(binding?.methodCode
          ? `${result.parameter} of sample ${result.sampleId} is run by method ${binding.methodCode}, not by ${w.methodCode}.`
          : `${result.parameter} of sample ${result.sampleId} is not bound to a method; a worklist runs the parameters of its method (${w.methodCode}).`);
      }
      const clash = await tx.execute(sql`
        SELECT w.id AS worklist_id, w.status FROM worklist_items i JOIN worklists w ON w.id = i.worklist_id
         WHERE i.result_id = ${result.id} AND i.status = 'Active' AND w.status IN ('Draft', 'Released') LIMIT 1`);
      const other = (clash as any).rows[0] as { worklist_id: string; status: string } | undefined;
      if (other) throw new AppError(409, 'DUPLICATE_ASSIGNMENT', `${result.parameter} of sample ${result.sampleId} is already on worklist ${other.worklist_id} (${other.status}).`);
    }
    if (input.assigneeId) {
      const a = await assertAssignable(tx, input.assigneeId, w.methodCode);
      if (a.overrideId) note = ` (qualification rests on QA override ${a.overrideId})`;
    }

    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${worklistItems.position}), 0)` }).from(worklistItems).where(eq(worklistItems.worklistId, worklistId));
    const row = {
      id: itemId(), worklistId, position: Number(max) + 1, kind: input.kind, sampleId: input.sampleId ?? null, resultId: input.resultId ?? null,
      label: input.label ?? null, assigneeId: input.assigneeId ?? null, status: 'Active', addedBy: actor.id, version: 1,
    };
    await tx.insert(worklistItems).values(row);
    const updated = await updateVersioned(tx, worklists, worklistId, w.version, {});
    await writeAudit(tx, actor.id, 'Add', 'WorklistItem', row.id, 'all', '', JSON.stringify(row), `${reason}${note}`);
    return { item: row, worklistVersion: updated.version };
  });
}

export interface ItemUpdate { assigneeId?: string; label?: string; reason?: string; expectedVersion: number }

async function loadItem(ex: Executor, worklistId: string, itemIdValue: string): Promise<ItemRow> {
  const [i] = await ex.select().from(worklistItems).where(and(eq(worklistItems.id, itemIdValue), eq(worklistItems.worklistId, worklistId))).for('update');
  if (!i) throw new NotFoundError(`Item ${itemIdValue} is not on worklist ${worklistId}.`);
  if (i.status !== 'Active') throw new AppError(409, 'ITEM_REMOVED', `Item ${i.id} was removed from worklist ${worklistId}.`);
  return i;
}

export async function updateItem(db: Db, actor: Actor, worklistId: string, id: string, input: ItemUpdate) {
  return change(db, actor, worklistId, async (tx) => {
    const w = await lockRow(tx, worklists, worklistId);
    assertOpen(w);
    const item = await loadItem(tx, worklistId, id);
    if (item.version !== input.expectedVersion) throw new ConflictError();
    const reason = reasonFor(w, input.reason, 'Draft worklist edited', { op: 'update', target: id });
    const set: Partial<typeof worklistItems.$inferInsert> = {};
    const diffs: Array<[string, string, string]> = [];
    let note = '';
    if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
      const a = await assertAssignable(tx, input.assigneeId, w.methodCode);
      if (a.overrideId) note = ` (qualification rests on QA override ${a.overrideId})`;
      set.assigneeId = input.assigneeId; diffs.push(['assignee', item.assigneeId ?? '', input.assigneeId]);
    }
    if (input.label !== undefined && input.label !== item.label) {
      if (item.kind === 'Sample') throw new BadRequestError('A Sample item takes its label from its sample; change the assignee instead.');
      set.label = input.label; diffs.push(['label', item.label ?? '', input.label]);
    }
    if (diffs.length === 0) throw new BadRequestError('Nothing changed: the values given are the ones recorded.');
    const updated = await updateVersioned(tx, worklistItems, id, input.expectedVersion, set);
    await updateVersioned(tx, worklists, worklistId, w.version, {});
    for (const [field, before, after] of diffs) await writeAudit(tx, actor.id, 'Update', 'WorklistItem', id, field, before, after, `${reason}${note}`);
    return updated;
  });
}

export async function removeItem(db: Db, actor: Actor, worklistId: string, id: string, input: { reason?: string; expectedVersion: number }) {
  return change(db, actor, worklistId, async (tx) => {
    const w = await lockRow(tx, worklists, worklistId);
    assertOpen(w);
    const item = await loadItem(tx, worklistId, id);
    if (item.version !== input.expectedVersion) throw new ConflictError();
    // An item is never deleted, so removing one always says why (on a Draft as well).
    if (!input.reason) {
      if (w.status === 'Released') reasonFor(w, undefined, '', { op: 'remove', target: id });
      throw new BadRequestError('A reason is required to remove an item: it is kept in the record as Removed.');
    }
    const updated = await updateVersioned(tx, worklistItems, id, input.expectedVersion, {
      status: 'Removed', removedBy: actor.id, removedAt: new Date(), removedReason: input.reason,
    });
    await updateVersioned(tx, worklists, worklistId, w.version, {});
    await writeAudit(tx, actor.id, 'Remove', 'WorklistItem', id, 'status', 'Active', 'Removed', input.reason);
    return updated;
  });
}

export async function reorderItems(db: Db, actor: Actor, worklistId: string, input: { itemIds: string[]; reason?: string }) {
  return change(db, actor, worklistId, async (tx) => {
    const w = await lockRow(tx, worklists, worklistId);
    assertOpen(w);
    const items = await activeItems(tx, worklistId);
    const have = new Set(items.map(i => i.id));
    if (items.length !== input.itemIds.length || input.itemIds.some(i => !have.has(i))) {
      throw new BadRequestError('itemIds must list every Active item of the worklist exactly once.');
    }
    const before = items.map(i => i.id);
    if (before.every((v, n) => v === input.itemIds[n])) throw new BadRequestError('Nothing changed: the order given is the order recorded.');
    const reason = reasonFor(w, input.reason, 'Run order changed on a draft worklist', { op: 'reorder' });
    const byId = new Map(items.map(i => [i.id, i]));
    for (const [n, id] of input.itemIds.entries()) {
      const item = byId.get(id)!;
      if (item.position !== n + 1) await updateVersioned(tx, worklistItems, id, item.version, { position: n + 1 });
    }
    const updated = await updateVersioned(tx, worklists, worklistId, w.version, {});
    await writeAudit(tx, actor.id, 'Reorder', 'Worklist', worklistId, 'order', before.join(','), input.itemIds.join(','), reason);
    return updated;
  });
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export interface ListFilter { status?: string; methodCode?: string; instrumentId?: string; assigneeId?: string; from?: string; to?: string }

export async function listWorklists(db: Db, f: ListFilter) {
  const where = [sql`true`];
  if (f.status) where.push(sql`w.status = ${f.status}`);
  if (f.methodCode) where.push(sql`lower(w.method_code) = ${f.methodCode.toLowerCase()}`);
  if (f.instrumentId) where.push(sql`w.instrument_id = ${f.instrumentId}`);
  if (f.from) where.push(sql`w.planned_date >= ${f.from}`);
  if (f.to) where.push(sql`w.planned_date <= ${f.to}`);
  if (f.assigneeId) where.push(sql`EXISTS (SELECT 1 FROM worklist_items a WHERE a.worklist_id = w.id AND a.status = 'Active' AND a.assignee_id = ${f.assigneeId})`);
  const res = await db.execute(sql`
    SELECT w.id, w.title, w.method_code AS "methodCode", w.instrument_id AS "instrumentId", i.name AS "instrumentName", w.planned_date AS "plannedDate",
           w.status, w.created_by AS "createdBy", w.created_at AS "createdAt", w.released_at AS "releasedAt", w.closed_at AS "closedAt", w.version,
           (SELECT count(*) FROM worklist_items x WHERE x.worklist_id = w.id AND x.status = 'Active')::int AS "itemCount",
           (SELECT count(*) FROM worklist_items x WHERE x.worklist_id = w.id AND x.status = 'Active' AND x.kind = 'Sample')::int AS "sampleItems",
           (SELECT count(*) FROM worklist_items x JOIN results r ON r.id = x.result_id
             WHERE x.worklist_id = w.id AND x.status = 'Active' AND (r.value IS NULL OR r.value = ''))::int AS "pending"
      FROM worklists w LEFT JOIN instruments i ON i.id = w.instrument_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY w.planned_date DESC, w.id COLLATE "C" DESC
     LIMIT 500`);
  return rowsOf(res);
}

export async function getWorklist(db: Db, id: string) {
  const w = await loadWorklist(db, id);
  const [inst] = w.instrumentId ? await db.select().from(instruments).where(eq(instruments.id, w.instrumentId)).limit(1) : [];
  const items = rowsOf(await db.execute(sql`
    SELECT i.id, i.position, i.kind, i.sample_id AS "sampleId", i.result_id AS "resultId", i.label, i.assignee_id AS "assigneeId", u.name AS "assigneeName",
           i.status, i.version, i.added_by AS "addedBy", i.added_at AS "addedAt", i.removed_by AS "removedBy", i.removed_at AS "removedAt", i.removed_reason AS "removedReason",
           s.material, s.batch, s.state AS "sampleState", r.parameter, r.value, r.unit, r.version AS "resultVersion", r.is_oos AS "isOos",
           r.limit_kind AS "limitKind", r.lower_text AS "lowerText", r.upper_text AS "upperText", r.acceptance_text AS "acceptanceText", r.instrument_id AS "resultInstrumentId"
      FROM worklist_items i
      LEFT JOIN users u ON u.id = i.assignee_id
      LEFT JOIN samples s ON s.id = i.sample_id
      LEFT JOIN results r ON r.id = i.result_id
     WHERE i.worklist_id = ${id}
     ORDER BY (i.status = 'Removed'), i.position, i.id COLLATE "C"`));
  return {
    ...w, releasedAt: iso(w.releasedAt), closedAt: iso(w.closedAt), createdAt: iso(w.createdAt),
    instrument: inst ? { id: inst.id, name: inst.name, type: inst.type, status: inst.status, calibrationDueDate: inst.calibrationDueDate } : null,
    items,
  };
}

/** Results waiting for a method: bound to it, no value yet, sample Logged or Testing, on no Draft or Released worklist. */
export async function candidates(db: Db, methodCode: string) {
  const key = (c: string) => sql.raw(`lower(btrim(regexp_replace(${c}, '\\s+', ' ', 'g')))`);
  return rowsOf(await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (r.id) r.id AS "resultId", r.sample_id AS "sampleId", r.parameter, r.unit, s.material, s.batch, s.state, s.created_at AS "createdAt"
        FROM results r
        JOIN samples s ON s.id = r.sample_id
        JOIN spec_parameters sp ON sp.spec_id = s.spec_id AND ${key('sp.name')} = ${key('r.parameter')}
       WHERE lower(sp.method_code) = ${methodCode.trim().toLowerCase()}
         AND (r.value IS NULL OR r.value = '') AND s.state IN ('Logged', 'Testing')
         AND NOT EXISTS (SELECT 1 FROM worklist_items i JOIN worklists w ON w.id = i.worklist_id
                          WHERE i.result_id = r.id AND i.status = 'Active' AND w.status IN ('Draft', 'Released'))
       ORDER BY r.id, sp.position) c
    ORDER BY c."createdAt", c."resultId" COLLATE "C"
    LIMIT 200`));
}

/**
 * The workload of the laboratory: per analyst and per instrument, what is planned (Draft) and what is on the bench (Released), how
 * much of it is still without a value and how much is overdue (the worklist's planned date is before today).
 */
export async function workload(db: Db, range: { from?: string; to?: string }, now = new Date()) {
  const today = todayIso(now);
  const bounds = [sql`true`];
  if (range.from) bounds.push(sql`w.planned_date >= ${range.from}`);
  if (range.to) bounds.push(sql`w.planned_date <= ${range.to}`);
  const base = sql`
    FROM worklist_items i
    JOIN worklists w ON w.id = i.worklist_id AND w.status IN ('Draft', 'Released')
    LEFT JOIN results r ON r.id = i.result_id
    LEFT JOIN users u ON u.id = i.assignee_id
    LEFT JOIN instruments n ON n.id = w.instrument_id
   WHERE i.status = 'Active' AND ${sql.join(bounds, sql` AND `)}`;
  const pending = sql`(i.result_id IS NOT NULL AND (r.value IS NULL OR r.value = ''))`;
  const analysts = rowsOf(await db.execute(sql`
    SELECT i.assignee_id AS "userId", u.name,
           count(DISTINCT w.id) FILTER (WHERE w.status = 'Released')::int AS "releasedWorklists",
           count(*) FILTER (WHERE w.status = 'Released')::int AS "releasedItems",
           count(*) FILTER (WHERE w.status = 'Released' AND ${pending})::int AS "pending",
           count(*) FILTER (WHERE w.status = 'Released' AND ${pending} AND w.planned_date < ${today})::int AS "overdue",
           count(DISTINCT w.id) FILTER (WHERE w.status = 'Draft')::int AS "draftWorklists",
           count(*) FILTER (WHERE w.status = 'Draft')::int AS "draftItems",
           min(w.planned_date) AS "nextPlannedDate"
      ${base} AND i.assignee_id IS NOT NULL
     GROUP BY i.assignee_id, u.name`)) as any[];
  const instrumentsRows = rowsOf(await db.execute(sql`
    SELECT w.instrument_id AS "instrumentId", n.name,
           count(DISTINCT w.id) FILTER (WHERE w.status = 'Released')::int AS "releasedWorklists",
           count(DISTINCT w.id) FILTER (WHERE w.status = 'Draft')::int AS "draftWorklists",
           count(*)::int AS "items", min(w.planned_date) AS "nextPlannedDate"
      ${base} AND w.instrument_id IS NOT NULL
     GROUP BY w.instrument_id, n.name`)) as any[];
  const byName = (a: { name: string; userId?: string; instrumentId?: string }, b: typeof a) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { today, from: range.from ?? null, to: range.to ?? null, analysts: analysts.sort(byName), instruments: instrumentsRows.sort(byName) };
}
