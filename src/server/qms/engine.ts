/**
 * The QMS engine (roadmap M27): every write on a quality record, its actions, links, comments and effectiveness checks.
 * The routes (src/server/routes/qms.ts) only parse and answer; the rules of AGENTS.md live here:
 *   - the actor is the authenticated user passed in by the route (req.user), never a field of the body;
 *   - every write takes the record's row lock, checks the version predicate (updateVersioned) and writes its audit entry in the
 *     same transaction;
 *   - a signed step goes through signRecord with the step's own meaning (states.ts), bound to the record version it produces;
 *     what can be decided without the password is decided first, so a refused step costs the signer no attempt;
 *   - a final record answers 423 to everything; content is frozen after approval.
 */
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray, or, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { instruments, oosInvestigations, samples, specifications, users } from '../../db/schema';
import { qmsActions, qmsComments, qmsEffectivenessChecks, qmsLinks, qmsRecords, qmsSettings } from '../../db/schema/qms';
import { writeAudit } from '../../db/utils';
import type { UserRow } from '../auth/sessions';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { permissionsOfRole } from '../authz/grants';
import type { Db } from '../core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { todayIso } from '../lib/specs';
import './entities';
import { assertRules } from './rules';
import { QMS_PAYLOAD_SCHEMAS } from './schemas';
import { LIFECYCLES, QMS_TYPE_LIST, assertContentEditable, assertNotTerminal, findMove, isTerminal, movesFrom, type Move, type QmsType } from './states';

export type QmsRow = typeof qmsRecords.$inferSelect;
export type ActionRow = typeof qmsActions.$inferSelect;
type Actor = Pick<UserRow, 'id' | 'role'>;
interface Credentials { password: string; totpCode?: string; reason?: string }

const auditValue = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const rowId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

// ---- reading ---------------------------------------------------------------------------------------------------------------------

export const isOverdue = (dueDate: string | null, open: boolean, today = todayIso()) => open && !!dueDate && dueDate < today;

export function presentRecord(r: QmsRow, today = todayIso()) {
  const type = r.type as QmsType;
  return {
    ...r,
    overdue: isOverdue(r.dueDate, !isTerminal(type, r.state), today),
    editable: LIFECYCLES[type].editable.includes(r.state),
    final: isTerminal(type, r.state),
    nextMoves: movesFrom(type, r.state).map(m => ({ to: m.to, signed: !!m.sign, meaningCode: m.sign ?? null, qa: !!m.qa, reasonRequired: !!m.reason })),
  };
}

export function presentAction(a: ActionRow, today = todayIso()) {
  return { ...a, overdue: isOverdue(a.dueDate, a.status === 'Open', today) };
}

/** Records that are not final: per type, a state outside that type's terminal states. */
const openRecord = (): SQL => or(...QMS_TYPE_LIST.map(t => and(eq(qmsRecords.type, t), notInArray(qmsRecords.state, [...LIFECYCLES[t].terminal]))))!;
const finalRecord = (): SQL => or(...QMS_TYPE_LIST.map(t => and(eq(qmsRecords.type, t), inArray(qmsRecords.state, [...LIFECYCLES[t].terminal]))))!;

/** The newest 500 records that match. Every filter runs in the database, so a match is never lost behind a page of others. */
export async function listRecords(ex: Executor, f: { type?: string; state?: string; open?: boolean; overdue?: boolean }) {
  const today = todayIso();
  const where: SQL[] = [];
  if (f.type) where.push(eq(qmsRecords.type, f.type));
  if (f.state) where.push(eq(qmsRecords.state, f.state));
  if (f.open !== undefined) where.push(f.open ? openRecord() : finalRecord());
  if (f.overdue === true) where.push(openRecord(), isNotNull(qmsRecords.dueDate), lt(qmsRecords.dueDate, today));
  const rows = await ex.select().from(qmsRecords).where(where.length ? and(...where) : undefined).orderBy(desc(qmsRecords.createdAt), desc(qmsRecords.id)).limit(500);
  return rows.map(r => presentRecord(r, today)).filter(r => f.overdue !== false || !r.overdue);
}

export async function getRecordDetail(ex: Executor, id: string) {
  const [row] = await ex.select().from(qmsRecords).where(eq(qmsRecords.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Quality record ${id} was not found.`);
  const [actions, links, linkedFrom, comments, checks] = await Promise.all([
    ex.select().from(qmsActions).where(eq(qmsActions.recordId, id)).orderBy(asc(qmsActions.createdAt), asc(qmsActions.id)),
    ex.select().from(qmsLinks).where(eq(qmsLinks.recordId, id)).orderBy(asc(qmsLinks.createdAt), asc(qmsLinks.id)),
    ex.select().from(qmsLinks).where(and(eq(qmsLinks.targetType, 'QmsRecord'), eq(qmsLinks.targetId, id))).orderBy(asc(qmsLinks.createdAt)),
    ex.select().from(qmsComments).where(eq(qmsComments.recordId, id)).orderBy(asc(qmsComments.createdAt), asc(qmsComments.id)),
    ex.select().from(qmsEffectivenessChecks).where(eq(qmsEffectivenessChecks.recordId, id)).orderBy(asc(qmsEffectivenessChecks.checkedAt)),
  ]);
  return { record: presentRecord(row), actions: actions.map(a => presentAction(a)), links, linkedFrom, comments, effectivenessChecks: checks };
}

export async function listActions(ex: Executor, f: { ownerId?: string; status?: string; overdue?: boolean }) {
  const today = todayIso();
  const where: SQL[] = [];
  if (f.ownerId) where.push(eq(qmsActions.ownerId, f.ownerId));
  if (f.status) where.push(eq(qmsActions.status, f.status));
  if (f.overdue === true) where.push(and(eq(qmsActions.status, 'Open'), lt(qmsActions.dueDate, today))!);
  const rows = await ex.select({ action: qmsActions, recordTitle: qmsRecords.title, recordType: qmsRecords.type }).from(qmsActions)
    .innerJoin(qmsRecords, eq(qmsRecords.id, qmsActions.recordId))
    .where(where.length ? and(...where) : undefined).orderBy(asc(qmsActions.dueDate), asc(qmsActions.id)).limit(500);
  return rows.map(r => ({ ...presentAction(r.action, today), recordTitle: r.recordTitle, recordType: r.recordType }))
    .filter(a => f.overdue !== false || !a.overdue);
}

// ---- checks shared by the writes -------------------------------------------------------------------------------------------------

async function assertUser(ex: Executor, id: string, label: string) {
  const [u] = await ex.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, id)).limit(1);
  if (!u || !u.active) throw new AppError(400, 'UNKNOWN_USER', `${label}: there is no active user ${id}.`);
}

function assertNotPast(day: string | undefined, label: string) {
  if (day && day < todayIso()) throw new AppError(400, 'DATE_IN_PAST', `${label} ${day} is in the past.`);
}

function parsePayload(type: QmsType, payload: unknown) {
  return QMS_PAYLOAD_SCHEMAS[type].parse(payload ?? {}) as Record<string, unknown>;
}

async function hasPermission(ex: Executor, actor: Actor, code: string) {
  return (await permissionsOfRole(ex as Db, actor.role)).includes(code);
}

/** A step reserved to the quality unit (qms.approve): 403 PERMISSION_DENIED, recorded as AUTHZ_DENIED. */
async function assertQa(db: Db, req: Request, actor: Actor, what: string) {
  if (await hasPermission(db, actor, 'qms.approve')) return;
  await recordDenied(db, req, actor, { permission: 'qms.approve', what });
  throw new AppError(403, 'PERMISSION_DENIED', `${what} is a decision of the quality unit (permission qms.approve).`, { permission: 'qms.approve' });
}

/**
 * Independence of a quality signature: the person who approves, closes or verifies a record must be neither the person who raised it
 * nor its owner. A rejection (cancelling a draft) is not covered.
 */
async function assertIndependentSigner(db: Db, req: Request, actor: Actor, row: QmsRow, meaning: string) {
  if (meaning === 'QMS_REJECTION') return;
  const involved = [row.createdBy, row.ownerId].filter(Boolean);
  if (!involved.includes(actor.id)) return;
  await recordDenied(db, req, actor, { rule: 'qms.independent-signer', entity: 'QmsRecord', entityId: row.id });
  throw new AppError(403, 'SOD_VIOLATION', `${row.id} was raised or is owned by you: another member of the quality unit must sign this step.`);
}

async function loadRecord(ex: Executor, id: string) {
  const [row] = await ex.select().from(qmsRecords).where(eq(qmsRecords.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Quality record ${id} was not found.`);
  return row;
}

const lockRecord = (tx: Tx, id: string) => lockRow(tx, qmsRecords, id).catch(e => { throw e instanceof NotFoundError ? new NotFoundError(`Quality record ${id} was not found.`) : e; });

// ---- records ---------------------------------------------------------------------------------------------------------------------

/** The next record number of a type: DEV-2026-0001. Gap-free and unique under concurrency (row lock on the counter). */
export async function nextRecordId(tx: Executor, type: QmsType, now = new Date()) {
  const { prefix } = LIFECYCLES[type];
  const year = now.getFullYear();
  const n = await nextSequence(tx, `qms:${prefix}:${year}`);
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

export interface NewRecord {
  type: QmsType; title: string; description?: string; classification?: string; ownerId?: string; dueDate?: string; payload?: Record<string, unknown>;
}

/** Inserts a record and its Create audit entry inside `tx`. Used by the route and by the automatic opening (autoOpen.ts). */
export async function insertRecord(tx: Tx, actorId: string, input: NewRecord, origin: { origin?: string; sourceType?: string; sourceId?: string; state?: string; reason?: string } = {}) {
  const payload = parsePayload(input.type, input.payload);
  const id = await nextRecordId(tx, input.type);
  const values = {
    id, type: input.type, title: input.title, description: input.description ?? '', classification: input.classification ?? null,
    state: origin.state ?? LIFECYCLES[input.type].initial, ownerId: input.ownerId ?? actorId, dueDate: input.dueDate ?? null, payload,
    origin: origin.origin ?? 'manual', sourceType: origin.sourceType ?? null, sourceId: origin.sourceId ?? null, createdBy: actorId, version: 1,
  };
  const [row] = await tx.insert(qmsRecords).values(values).returning();
  await writeAudit(tx, actorId, 'Create', 'QmsRecord', id, 'all', '', JSON.stringify(values), origin.reason ?? `${input.type} raised`);
  return row;
}

export async function createRecord(db: Db, actor: Actor, input: NewRecord) {
  parsePayload(input.type, input.payload); // 400 before anything is written
  assertNotPast(input.dueDate, 'Due date');
  if (input.ownerId) await assertUser(db, input.ownerId, 'Owner');
  return withTransaction(db, tx => insertRecord(tx, actor.id, input)).then(r => presentRecord(r));
}

export interface RecordEdit {
  title?: string; description?: string; classification?: string; ownerId?: string; dueDate?: string; payload?: Record<string, unknown>;
  reason?: string; expectedVersion: number;
}

/**
 * The classification decides the path a record takes (a Minor deviation may close without a CAPA), so once the record exists only the
 * quality unit (qms.approve) changes it. The raiser proposes one when raising the record.
 */
async function assertMayClassify(db: Db, req: Request, actor: Actor, row: QmsRow, classification: string | undefined) {
  if (classification === undefined || classification === row.classification) return;
  await assertQa(db, req, actor, `Changing the classification of ${row.id}`);
}

export async function updateRecord(db: Db, req: Request, actor: Actor, id: string, input: RecordEdit) {
  const content = (['title', 'description', 'classification', 'payload'] as const).filter(k => input[k] !== undefined);
  const admin = (['ownerId', 'dueDate'] as const).filter(k => input[k] !== undefined);
  if (!content.length && !admin.length) throw new AppError(400, 'NOTHING_TO_CHANGE', 'There is nothing to change.');
  assertNotPast(input.dueDate, 'Due date');
  if (input.ownerId) await assertUser(db, input.ownerId, 'Owner');
  await assertMayClassify(db, req, actor, await loadRecord(db, id), input.classification);

  const updated = await withTransaction(db, async (tx) => {
    const row = await lockRecord(tx, id);
    const type = row.type as QmsType;
    assertNotTerminal(type, id, row.state);
    if (content.length) assertContentEditable(type, id, row.state);
    if (row.version !== input.expectedVersion) throw new ConflictError();
    if (input.classification !== undefined && input.classification !== row.classification && !(await hasPermission(tx, actor, 'qms.approve'))) {
      throw new AppError(403, 'PERMISSION_DENIED', `Changing the classification of ${id} is a decision of the quality unit (permission qms.approve).`, { permission: 'qms.approve' });
    }

    const set: Partial<QmsRow> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) set.description = input.description;
    if (input.classification !== undefined) set.classification = input.classification;
    if (input.ownerId !== undefined) set.ownerId = input.ownerId;
    if (input.dueDate !== undefined) set.dueDate = input.dueDate;
    if (input.payload !== undefined) set.payload = parsePayload(type, { ...row.payload, ...input.payload });

    const next = await updateVersioned(tx, qmsRecords, id, input.expectedVersion, set);
    const columns: Record<string, string> = { title: 'title', description: 'description', classification: 'classification', ownerId: 'owner_id', dueDate: 'due_date', payload: 'payload' };
    for (const [key, value] of Object.entries(set)) {
      const old = (row as any)[key];
      if (JSON.stringify(old) === JSON.stringify(value)) continue;
      await writeAudit(tx, actor.id, 'Update', 'QmsRecord', id, columns[key], auditValue(old), auditValue(value), input.reason || `${columns[key]} edited in state ${row.state}`);
    }
    return next;
  });
  return presentRecord(updated);
}

async function prepareMove(db: Db, req: Request, actor: Actor, row: QmsRow, to: string, signed: boolean, expectedVersion: number, reason?: string): Promise<Move> {
  const move = findMove(row.type as QmsType, row.id, row.state, to, signed);
  if (row.version !== expectedVersion) throw new ConflictError();
  if (move.qa) await assertQa(db, req, actor, `${row.state} to ${to}`);
  if (move.reason && !reason) throw new AppError(400, 'REASON_REQUIRED', `${row.state} to ${to} needs a reason.`);
  return move;
}

async function applyMove(tx: Tx, actorId: string, id: string, to: string, signed: boolean, expectedVersion: number, reason: string | undefined) {
  const current = await lockRecord(tx, id);
  const move = findMove(current.type as QmsType, id, current.state, to, signed);
  if (current.version !== expectedVersion) throw new ConflictError();
  await assertRules(tx, current, move.rules);
  const closing = isTerminal(current.type as QmsType, to);
  const row = await updateVersioned(tx, qmsRecords, id, expectedVersion, { state: to, ...(closing ? { closedAt: new Date() } : {}) });
  return { from: current.state, row, why: reason || `${current.type} ${id}: ${current.state} to ${to}` };
}

/** An unsigned step of the lifecycle. */
export async function transitionRecord(db: Db, req: Request, actor: Actor, id: string, input: { to: string; reason?: string; expectedVersion: number }) {
  const row = await loadRecord(db, id);
  const move = await prepareMove(db, req, actor, row, input.to, false, input.expectedVersion, input.reason);
  await assertRules(db, row, move.rules);
  const updated = await withTransaction(db, async (tx) => {
    const { from, row: next, why } = await applyMove(tx, actor.id, id, input.to, false, input.expectedVersion, input.reason);
    await writeAudit(tx, actor.id, 'StatusChange', 'QmsRecord', id, 'state', from, input.to, why);
    return next;
  });
  return presentRecord(updated);
}

/** A signed step: approval, closure, rejection or the emergency authorisation of a change. */
export async function signRecordStep(db: Db, req: Request, actor: Actor, id: string, input: Credentials & { to: string; expectedVersion: number }) {
  const row = await loadRecord(db, id);
  const move = await prepareMove(db, req, actor, row, input.to, true, input.expectedVersion);
  await assertIndependentSigner(db, req, actor, row, move.sign!);
  await assertRules(db, row, move.rules);

  const { result, signature } = await signRecord({
    db, user: actor, meaningCode: move.sign!, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'QmsRecord', entityId: id, context: securityEventContext(req),
    execute: async (tx) => {
      const { from, row: next, why } = await applyMove(tx, actor.id, id, input.to, true, input.expectedVersion, input.reason);
      return { recordVersion: next.version, audit: { action: 'StatusChange', field: 'state', oldValue: from, newValue: input.to, reason: why }, result: next };
    },
  });
  return { record: presentRecord(result), signature };
}

/** A signed effectiveness check of a CAPA in Effectiveness Check. Not effective sends the CAPA back to Implementation. */
export async function recordEffectiveness(db: Db, req: Request, actor: Actor, id: string, input: Credentials & { result: 'Effective' | 'Not effective'; evidence: string; expectedVersion: number }) {
  const row = await loadRecord(db, id);
  const check = (r: QmsRow) => {
    assertNotTerminal(r.type as QmsType, id, r.state);
    if (r.type !== 'CAPA') throw new AppError(400, 'NOT_A_CAPA', `${id} is a ${r.type}: effectiveness is checked on a CAPA.`);
    if (r.state !== 'Effectiveness Check') throw new AppError(409, 'ILLEGAL_TRANSITION', `${id} is ${r.state}: move it to Effectiveness Check first.`);
    if (r.version !== input.expectedVersion) throw new ConflictError();
  };
  check(row);
  await assertIndependentSigner(db, req, actor, row, 'QMS_EFFECTIVENESS');
  const checkId = rowId('EFF');

  const { result, signature } = await signRecord({
    db, user: actor, meaningCode: 'QMS_EFFECTIVENESS', credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'QmsEffectivenessCheck', entityId: checkId, context: securityEventContext(req),
    execute: async (tx) => {
      const current = await lockRecord(tx, id);
      check(current);
      await tx.insert(qmsEffectivenessChecks).values({ id: checkId, recordId: id, result: input.result, evidence: input.evidence, recordVersion: current.version, checkedBy: actor.id });
      let record = current;
      if (input.result === 'Not effective') {
        record = await updateVersioned(tx, qmsRecords, id, current.version, { state: 'Implementation' });
        await writeAudit(tx, actor.id, 'StatusChange', 'QmsRecord', id, 'state', current.state, 'Implementation',
          `Effectiveness check ${checkId} found ${id} not effective: ${input.evidence}`);
      }
      return { recordVersion: 1, audit: { action: 'EffectivenessCheck', field: 'result', oldValue: '', newValue: input.result, reason: `${id}: ${input.evidence}` }, result: record };
    },
  });
  return { record: presentRecord(result), checkId, signature };
}

// ---- links and comments ----------------------------------------------------------------------------------------------------------

const TARGET_TABLES: Record<string, { table: any; id: any } | undefined> = {
  QmsRecord: { table: qmsRecords, id: qmsRecords.id },
  Sample: { table: samples, id: samples.id },
  OOS: { table: oosInvestigations, id: oosInvestigations.id },
  Specification: { table: specifications, id: specifications.id },
  User: { table: users, id: users.id },
  Instrument: { table: instruments, id: instruments.id },
};

export async function addLink(db: Db, actor: Actor, id: string, input: { relation: 'capa' | 'affects' | 'related'; targetType: string; targetId: string }) {
  try {
    return await withTransaction(db, async (tx) => {
      const row = await lockRecord(tx, id);
      const type = row.type as QmsType;
      assertNotTerminal(type, id, row.state);
      if (input.relation === 'affects') {
        if (type !== 'ChangeControl') throw new AppError(400, 'BAD_RELATION', 'Only a change control affects other records.');
        // The scope is part of what the approval signs: it is frozen with the content.
        assertContentEditable(type, id, row.state);
      }
      if (input.targetType === 'QmsRecord' && input.targetId === id) throw new AppError(400, 'SELF_LINK', 'A record cannot be linked to itself.');
      const known = TARGET_TABLES[input.targetType];
      if (known) {
        const [found] = await tx.select({ id: known.id }).from(known.table).where(eq(known.id, input.targetId)).limit(1);
        if (!found) throw new AppError(400, 'UNKNOWN_TARGET', `There is no ${input.targetType} ${input.targetId}.`);
      }
      if (input.relation === 'capa') {
        if (type !== 'Deviation' && type !== 'AuditFinding') throw new AppError(400, 'BAD_RELATION', `A CAPA is linked to a deviation or an audit finding, not to a ${type}.`);
        const target = input.targetType === 'QmsRecord' ? await loadRecord(tx, input.targetId) : null;
        if (!target || target.type !== 'CAPA') throw new AppError(400, 'BAD_RELATION', 'The target of a capa link must be a CAPA record.');
      }
      const link = { id: rowId('QL'), recordId: id, relation: input.relation, targetType: input.targetType, targetId: input.targetId, createdBy: actor.id };
      await tx.insert(qmsLinks).values(link);
      await writeAudit(tx, actor.id, 'Link', 'QmsRecord', id, 'link', '', `${input.relation} ${input.targetType} ${input.targetId}`, `${input.relation} link added`);
      return link;
    });
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === '23505') throw new AppError(409, 'DUPLICATE', `${id} is already linked to ${input.targetType} ${input.targetId} (${input.relation}).`);
    throw e;
  }
}

export async function addComment(db: Db, actor: Actor, id: string, text: string) {
  return withTransaction(db, async (tx) => {
    const row = await lockRecord(tx, id);
    assertNotTerminal(row.type as QmsType, id, row.state);
    const comment = { id: rowId('QC'), recordId: id, authorId: actor.id, text };
    const [inserted] = await tx.insert(qmsComments).values(comment).returning();
    await writeAudit(tx, actor.id, 'Comment', 'QmsRecord', id, 'comment', '', text, 'Comment added');
    return inserted;
  });
}

// ---- actions ---------------------------------------------------------------------------------------------------------------------

export async function createAction(db: Db, actor: Actor, recordId: string, input: { title: string; description?: string; ownerId: string; dueDate: string }) {
  assertNotPast(input.dueDate, 'Due date');
  await assertUser(db, input.ownerId, 'Owner');
  const action = await withTransaction(db, async (tx) => {
    const row = await lockRecord(tx, recordId);
    assertNotTerminal(row.type as QmsType, recordId, row.state);
    const n = await nextSequence(tx, `qms:action:${recordId}`);
    const values = { id: `${recordId}-A${n}`, recordId, title: input.title, description: input.description ?? '', ownerId: input.ownerId, dueDate: input.dueDate, status: 'Open', createdBy: actor.id, version: 1 };
    const [inserted] = await tx.insert(qmsActions).values(values).returning();
    await writeAudit(tx, actor.id, 'Create', 'QmsAction', values.id, 'all', '', JSON.stringify(values), `Action added to ${recordId}`);
    return inserted;
  });
  return presentAction(action);
}

async function lockAction(tx: Tx, id: string) {
  const action = await lockRow(tx, qmsActions, id).catch(e => { throw e instanceof NotFoundError ? new NotFoundError(`Action ${id} was not found.`) : e; });
  const record = await lockRecord(tx, action.recordId);
  return { action, record };
}

function assertActionOpen(action: ActionRow, record: QmsRow, expectedVersion: number) {
  assertNotTerminal(record.type as QmsType, record.id, record.state);
  if (action.status !== 'Open') throw new AppError(423, 'RECORD_LOCKED', `Action ${action.id} is ${action.status} and final.`);
  if (action.version !== expectedVersion) throw new ConflictError();
}

export async function updateAction(db: Db, actor: Actor, id: string, input: { title?: string; description?: string; ownerId?: string; dueDate?: string; reason: string; expectedVersion: number }) {
  assertNotPast(input.dueDate, 'Due date');
  if (input.ownerId) await assertUser(db, input.ownerId, 'Owner');
  const updated = await withTransaction(db, async (tx) => {
    const { action, record } = await lockAction(tx, id);
    assertActionOpen(action, record, input.expectedVersion);
    const set: Partial<ActionRow> = {};
    for (const k of ['title', 'description', 'ownerId', 'dueDate'] as const) if (input[k] !== undefined) (set as any)[k] = input[k];
    if (!Object.keys(set).length) throw new AppError(400, 'NOTHING_TO_CHANGE', 'There is nothing to change.');
    const next = await updateVersioned(tx, qmsActions, id, input.expectedVersion, set);
    const columns: Record<string, string> = { title: 'title', description: 'description', ownerId: 'owner_id', dueDate: 'due_date' };
    for (const [k, v] of Object.entries(set)) {
      if ((action as any)[k] === v) continue;
      await writeAudit(tx, actor.id, 'Update', 'QmsAction', id, columns[k], auditValue((action as any)[k]), auditValue(v), input.reason);
    }
    return next;
  });
  return presentAction(updated);
}

/** Completion: an e-signature by the action's owner (or the quality unit), naming the evidence. */
export async function completeAction(db: Db, req: Request, actor: Actor, id: string, input: Credentials & { evidenceRef: string; expectedVersion: number }) {
  const [found] = await db.select().from(qmsActions).where(eq(qmsActions.id, id)).limit(1);
  if (!found) throw new NotFoundError(`Action ${id} was not found.`);
  assertActionOpen(found, await loadRecord(db, found.recordId), input.expectedVersion);
  if (found.ownerId !== actor.id && !(await hasPermission(db, actor, 'qms.approve'))) {
    await recordDenied(db, req, actor, { rule: 'qms.action-owner', entity: 'QmsAction', entityId: id });
    throw new ForbiddenError(`Action ${id} belongs to ${found.ownerId}: only its owner or the quality unit can complete it.`);
  }
  const { result, signature } = await signRecord({
    db, user: actor, meaningCode: 'QMS_ACTION_COMPLETION', credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'QmsAction', entityId: id, context: securityEventContext(req),
    execute: async (tx) => {
      const { action, record } = await lockAction(tx, id);
      assertActionOpen(action, record, input.expectedVersion);
      const next = await updateVersioned(tx, qmsActions, id, input.expectedVersion, { status: 'Done', evidenceRef: input.evidenceRef, completedBy: actor.id, completedAt: new Date() });
      return { recordVersion: next.version, audit: { action: 'StatusChange', field: 'status', oldValue: 'Open', newValue: 'Done', reason: `Completed with evidence: ${input.evidenceRef}` }, result: next };
    },
  });
  return { action: presentAction(result), signature };
}

export async function cancelAction(db: Db, actor: Actor, id: string, input: { reason: string; expectedVersion: number }) {
  const updated = await withTransaction(db, async (tx) => {
    const { action, record } = await lockAction(tx, id);
    assertActionOpen(action, record, input.expectedVersion);
    const next = await updateVersioned(tx, qmsActions, id, input.expectedVersion, { status: 'Cancelled', cancelReason: input.reason });
    await writeAudit(tx, actor.id, 'StatusChange', 'QmsAction', id, 'status', 'Open', 'Cancelled', input.reason);
    return next;
  });
  return presentAction(updated);
}

// ---- settings --------------------------------------------------------------------------------------------------------------------

const SETTINGS_ID = 'default';

export async function getSettings(ex: Executor) {
  const [row] = await ex.select().from(qmsSettings).where(eq(qmsSettings.id, SETTINGS_ID)).limit(1);
  // Installed by migration 0180; a database without the row has the requirement off (the installed default).
  return row ?? { id: SETTINGS_ID, changeControlRequired: false, updatedBy: null, updatedAt: null, version: 1 };
}

export async function updateSettings(db: Db, req: Request, actor: Actor, input: Credentials & { changeControlRequired: boolean; expectedVersion: number }) {
  const before = await getSettings(db);
  if (before.version !== input.expectedVersion) throw new ConflictError();
  if (before.changeControlRequired === input.changeControlRequired) throw new AppError(409, 'NO_CHANGE', `Change control is already ${input.changeControlRequired ? 'required' : 'not required'}.`);
  return signRecord({
    db, user: actor, meaningCode: 'QMS_SETTING_CHANGE', credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'QmsSettings', entityId: SETTINGS_ID, context: securityEventContext(req),
    execute: async (tx) => {
      await tx.insert(qmsSettings).values({ id: SETTINGS_ID, changeControlRequired: false }).onConflictDoNothing();
      const current = await lockRow(tx, qmsSettings, SETTINGS_ID);
      if (current.changeControlRequired === input.changeControlRequired) throw new AppError(409, 'NO_CHANGE', 'The setting was changed meanwhile.');
      const next = await updateVersioned(tx, qmsSettings, SETTINGS_ID, input.expectedVersion, { changeControlRequired: input.changeControlRequired, updatedBy: actor.id, updatedAt: new Date() });
      return {
        recordVersion: next.version,
        audit: { action: 'SettingChange', field: 'change_control_required', oldValue: String(current.changeControlRequired), newValue: String(next.changeControlRequired), reason: input.reason ?? '' },
        result: next,
      };
    },
  }).then(({ result, signature }) => ({ settings: result, signature }));
}
