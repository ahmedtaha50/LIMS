/**
 * Storage conditions, chambers and the controlled stability protocol (roadmap M31).
 *
 * A protocol revision is a Draft (edited by the people who hold stability.manage) and then Approved with STABILITY_PROTOCOL_APPROVAL by
 * someone who neither drafted nor edited it (403 SOD_VIOLATION, audited AUTHZ_DENIED). An Approved or Superseded revision is never
 * edited (409 PROTOCOL_LOCKED): a change is a new revision (`revise`), signed again, and on its approval the earlier Approved revision
 * becomes Superseded in the same transaction. Studies keep the revision they were started under.
 *
 * Every write is audited in its own transaction (writeAudit, or signRecord's entry for the approval); every update carries the version
 * predicate (updateVersioned). The actor is always the signed-in user.
 */
import { randomBytes } from 'crypto';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Request } from 'express';
import { products, users } from '../../db/schema';
import { testPlans } from '../../db/schema/methods';
import { stabilityChambers, stabilityConditions, stabilityProtocols, type ProtocolCondition } from '../../db/schema/stability';
import { writeAudit } from '../../db/utils';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, auditParticipants, SodViolationError } from '../authz/sod';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { materialKey } from '../lib/specs';
import './entities';

export const PROTOCOL_MEANING = 'STABILITY_PROTOCOL_APPROVAL';
type Actor = { id: string; role: string };
type ConditionRow = typeof stabilityConditions.$inferSelect;
type ChamberRow = typeof stabilityChambers.$inferSelect;
export type ProtocolRow = typeof stabilityProtocols.$inferSelect;

export const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;
/** An audit value: '' for nothing, JSON for a structure, the text otherwise. */
const auditText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';
const num = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));

/** Writes one audit entry per field that changes and the row with the version predicate; refuses an edit that changes nothing. */
async function updateAudited<T extends { version: number }>(tx: Tx, table: any, entity: string, current: T & { id: string }, expectedVersion: number,
  changes: Record<string, unknown>, actorId: string, reason: string): Promise<T> {
  const set = Object.fromEntries(Object.entries(changes).filter(([k, v]) => v !== undefined && auditText(v) !== auditText((current as any)[k])));
  if (Object.keys(set).length === 0) throw new BadRequestError('Nothing changes: the values sent are the values the record already holds.');
  const row = await updateVersioned(tx, table, current.id, expectedVersion, set) as T;
  for (const [field, value] of Object.entries(set)) {
    await writeAudit(tx, actorId, 'Update', entity, current.id, field, auditText((current as any)[field]), auditText(value), reason);
  }
  return row;
}

// ---- storage conditions ----------------------------------------------------------------------------------------------------------

export const listConditions = (db: Db) => db.select().from(stabilityConditions).orderBy(asc(stabilityConditions.category), asc(stabilityConditions.code));

export async function createCondition(db: Db, user: Actor, body: { code: string; name: string; category: string; temperatureC: number; temperatureToleranceC: number; humidityRh?: number | null; humidityToleranceRh?: number | null }) {
  return withTransaction(db, async (tx) => {
    const record = {
      id: newId('STC'), code: body.code, name: body.name, category: body.category,
      temperatureC: String(body.temperatureC), temperatureToleranceC: String(body.temperatureToleranceC),
      humidityRh: num(body.humidityRh), humidityToleranceRh: num(body.humidityToleranceRh),
      status: 'Active', origin: 'entry', createdBy: user.id, version: 1,
    };
    let row: ConditionRow;
    try {
      [row] = await tx.insert(stabilityConditions).values(record).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A storage condition with the code ${body.code} already exists (codes are unique ignoring case).`);
      throw e;
    }
    await writeAudit(tx, user.id, 'Create', 'StabilityCondition', row.id, 'all', '', JSON.stringify(record), `Storage condition ${body.code} defined`);
    return row;
  });
}

export async function updateCondition(db: Db, user: Actor, id: string, body: { expectedVersion: number; reason: string } & Record<string, unknown>) {
  const { expectedVersion, reason, ...changes } = body;
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, stabilityConditions, id);
    if (current.version !== expectedVersion) throw new ConflictError();
    const next: Record<string, unknown> = { ...changes };
    for (const k of ['temperatureC', 'temperatureToleranceC', 'humidityRh', 'humidityToleranceRh']) if (k in next) next[k] = num(next[k] as number | null);
    const rh = 'humidityRh' in next ? next.humidityRh : current.humidityRh;
    const tol = 'humidityToleranceRh' in next ? next.humidityToleranceRh : current.humidityToleranceRh;
    if ((rh === null) !== (tol === null)) throw new BadRequestError('Give the relative humidity and its tolerance together, or neither (humidity not controlled).');
    return updateAudited<ConditionRow>(tx, stabilityConditions, 'StabilityCondition', current, expectedVersion, next, user.id, reason);
  });
}

// ---- chambers ------------------------------------------------------------------------------------------------------------------

export async function listChambers(db: Db) {
  const rows = await db.select({ chamber: stabilityChambers, conditionCode: stabilityConditions.code }).from(stabilityChambers)
    .innerJoin(stabilityConditions, eq(stabilityConditions.id, stabilityChambers.conditionId)).orderBy(asc(stabilityChambers.code));
  return rows.map(r => ({ ...r.chamber, conditionCode: r.conditionCode }));
}

export async function createChamber(db: Db, user: Actor, body: { code: string; name: string; conditionId: string; location?: string | null }) {
  return withTransaction(db, async (tx) => {
    const [condition] = await tx.select().from(stabilityConditions).where(eq(stabilityConditions.id, body.conditionId)).limit(1);
    if (!condition) throw new NotFoundError(`Storage condition ${body.conditionId} was not found.`);
    if (condition.status !== 'Active') throw new AppError(409, 'CONDITION_INACTIVE', `Storage condition ${condition.code} is ${condition.status}: no chamber can be set up for it.`);
    const record = { id: newId('STCH'), code: body.code, name: body.name, conditionId: condition.id, location: body.location ?? null, status: 'Active', createdBy: user.id, version: 1 };
    let row: ChamberRow;
    try {
      [row] = await tx.insert(stabilityChambers).values(record).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A chamber with the code ${body.code} already exists (codes are unique ignoring case).`);
      throw e;
    }
    await writeAudit(tx, user.id, 'Create', 'StabilityChamber', row.id, 'all', '', JSON.stringify(record), `Chamber ${body.code} set up for ${condition.code}`);
    return row;
  });
}

export async function updateChamber(db: Db, user: Actor, id: string, body: { expectedVersion: number; reason: string } & Record<string, unknown>) {
  const { expectedVersion, reason, ...changes } = body;
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, stabilityChambers, id);
    if (current.version !== expectedVersion) throw new ConflictError();
    return updateAudited<ChamberRow>(tx, stabilityChambers, 'StabilityChamber', current, expectedVersion, changes, user.id, reason);
  });
}

// ---- protocols -----------------------------------------------------------------------------------------------------------------

const lockCode = (tx: Executor, code: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`StabilityProtocol:${code.toLowerCase()}`}))`);

/** The snapshot of the conditions a protocol names, in the order given. Each must exist and be Active. */
async function snapshotConditions(ex: Executor, ids: readonly string[]): Promise<ProtocolCondition[]> {
  const rows = await ex.select().from(stabilityConditions).where(inArray(stabilityConditions.id, [...ids]));
  return ids.map(id => {
    const c = rows.find(r => r.id === id);
    if (!c) throw new BadRequestError(`Storage condition ${id} was not found.`);
    if (c.status !== 'Active') throw new AppError(409, 'CONDITION_INACTIVE', `Storage condition ${c.code} is ${c.status}: a protocol cannot name it.`);
    return { conditionId: c.id, code: c.code, name: c.name, category: c.category, temperatureC: c.temperatureC, temperatureToleranceC: c.temperatureToleranceC, humidityRh: c.humidityRh, humidityToleranceRh: c.humidityToleranceRh };
  });
}

export async function listProtocols(db: Db) {
  const author = alias(users, 'stp_author');
  const approver = alias(users, 'stp_approver');
  const rows = await db.select({ row: stabilityProtocols, productName: products.name, createdByName: author.name, approvedByName: approver.name })
    .from(stabilityProtocols).innerJoin(products, eq(products.id, stabilityProtocols.productId))
    .leftJoin(author, eq(author.id, stabilityProtocols.createdBy)).leftJoin(approver, eq(approver.id, stabilityProtocols.approvedBy))
    .orderBy(sql`lower(${stabilityProtocols.code})`, desc(stabilityProtocols.revision));
  return rows.map(r => ({ ...r.row, productName: r.productName, createdByName: r.createdByName, approvedByName: r.approvedByName }));
}

export async function findProtocol(ex: Executor, id: string): Promise<ProtocolRow> {
  const [row] = await ex.select().from(stabilityProtocols).where(eq(stabilityProtocols.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Stability protocol ${id} was not found.`);
  return row;
}

const locked = (p: ProtocolRow) => new AppError(409, 'PROTOCOL_LOCKED',
  `Stability protocol ${p.code} revision ${p.revision} is ${p.status}: an ${p.status} protocol is never edited. Draft a new revision; it is signed again before use.`);

export async function createProtocol(db: Db, user: Actor, body: { code: string; productId: string; title: string; testPlanCode: string; conditionIds: string[]; monthPoints: number[]; windowDays: number }) {
  return withTransaction(db, async (tx) => {
    await lockCode(tx, body.code);
    const [product] = await tx.select().from(products).where(eq(products.id, body.productId)).limit(1);
    if (!product) throw new NotFoundError(`Product ${body.productId} was not found.`);
    if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}: no protocol can be written for it.`);
    const [existing] = await tx.select().from(stabilityProtocols).where(sql`lower(${stabilityProtocols.code}) = ${body.code.toLowerCase()}`).limit(1);
    if (existing) throw new AppError(409, 'DUPLICATE', `A stability protocol with the code ${existing.code} already exists. Draft a new revision of it instead.`);
    const record = {
      id: newId('STP'), code: body.code, title: body.title, productId: product.id, testPlanCode: body.testPlanCode,
      conditions: await snapshotConditions(tx, body.conditionIds), monthPoints: body.monthPoints, windowDays: body.windowDays,
      revision: 1, status: 'Draft', createdBy: user.id, version: 1,
    };
    const [row] = await tx.insert(stabilityProtocols).values(record).returning();
    await writeAudit(tx, user.id, 'Create', 'StabilityProtocol', row.id, 'all', '', JSON.stringify(record), `Revision 1 of stability protocol ${body.code} drafted`);
    return row;
  });
}

export async function updateProtocol(db: Db, user: Actor, id: string, body: { expectedVersion: number; title?: string; testPlanCode?: string; conditionIds?: string[]; monthPoints?: number[]; windowDays?: number }) {
  const { expectedVersion, conditionIds, ...rest } = body;
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, stabilityProtocols, id);
    if (current.status !== 'Draft') throw locked(current);
    if (current.version !== expectedVersion) throw new ConflictError();
    const changes: Record<string, unknown> = { ...rest };
    if (conditionIds) changes.conditions = await snapshotConditions(tx, conditionIds);
    return updateAudited<ProtocolRow>(tx, stabilityProtocols, 'StabilityProtocol', current, expectedVersion, changes, user.id,
      `Stability protocol ${current.code} revision ${current.revision} (Draft) edited`);
  });
}

/** The next revision, a Draft cloned from the Approved one (one Draft per code at a time). */
export async function reviseProtocol(db: Db, user: Actor, id: string) {
  return withTransaction(db, async (tx) => {
    const source = await findProtocol(tx, id);
    await lockCode(tx, source.code);
    const revisions = await tx.select().from(stabilityProtocols).where(sql`lower(${stabilityProtocols.code}) = ${source.code.toLowerCase()}`).orderBy(desc(stabilityProtocols.revision));
    const draft = revisions.find(r => r.status === 'Draft');
    if (draft) throw new AppError(409, 'DRAFT_EXISTS', `Revision ${draft.revision} of ${source.code} (${draft.id}) is already a Draft: edit and approve it; a protocol has one Draft at a time.`, { draft: draft.id });
    const fresh = revisions.find(r => r.id === id)!;
    if (fresh.status !== 'Approved') throw new AppError(409, 'NOT_APPROVED', `Revision ${fresh.revision} of ${fresh.code} is ${fresh.status}: a new revision is drafted from the Approved one.`);
    const revision = Math.max(...revisions.map(r => r.revision)) + 1;
    const record = {
      id: newId('STP'), code: fresh.code, title: fresh.title, productId: fresh.productId, testPlanCode: fresh.testPlanCode, conditions: fresh.conditions,
      monthPoints: fresh.monthPoints, windowDays: fresh.windowDays, revision, status: 'Draft', createdBy: user.id, version: 1,
    };
    const [row] = await tx.insert(stabilityProtocols).values(record).returning();
    await writeAudit(tx, user.id, 'Create', 'StabilityProtocol', row.id, 'all', '', JSON.stringify(record), `Revision ${revision} of stability protocol ${fresh.code} drafted from revision ${fresh.revision} (${fresh.id})`);
    return row;
  });
}

/** The Effective test plan of `code` for the product, or the reason it cannot be used. */
export async function effectivePlanFor(ex: Executor, code: string, productName: string) {
  const [plan] = await ex.select().from(testPlans).where(sql`lower(${testPlans.code}) = ${code.toLowerCase()} AND ${testPlans.status} = 'Effective'`).limit(1);
  if (!plan) throw new AppError(409, 'TEST_PLAN_NOT_EFFECTIVE', `The test plan ${code} has no Effective revision: approve it first (Methods, Test plans).`);
  if (materialKey(plan.material) !== materialKey(productName)) {
    throw new AppError(409, 'TEST_PLAN_MISMATCH', `The test plan ${plan.code} is for ${plan.material}, not for ${productName}.`);
  }
  return plan;
}

/** What approval needs besides the signature: an Active product, its Effective test plan and Active conditions. */
async function assertApprovable(ex: Executor, p: ProtocolRow) {
  const [product] = await ex.select().from(products).where(eq(products.id, p.productId)).limit(1);
  if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}.`);
  await effectivePlanFor(ex, p.testPlanCode, product.name);
  await snapshotConditions(ex, p.conditions.map(c => c.conditionId));
}

async function assertApproverIndependent(db: Db, req: Request, user: Actor, p: ProtocolRow) {
  const rule = { code: 'StabilityProtocol.approve', description: 'The person who approves a stability protocol must not have drafted or edited it.' };
  const participants = await auditParticipants(db, 'StabilityProtocol', p.id, ['Create', 'Update']);
  try {
    assertIndependent([p.createdBy, ...participants], user.id, rule, { entity: 'StabilityProtocol', entityId: p.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, user, { route: 'POST /stability/protocols/:id/approve', ...(e.details as object) });
    throw e;
  }
}

/**
 * Signs a Draft Approved. What can be refused without the password is refused first (404, 409 not a Draft, 403 SoD, 409 stale version,
 * 409 test plan / product / condition), so a refusal costs the signer no attempt; then again inside the signing transaction.
 */
export async function approveProtocol(args: { db: Db; req: Request; user: Actor; id: string; expectedVersion: number; credentials: { password: string; totpCode?: string }; reason?: string }) {
  const { db, req, user, id, expectedVersion } = args;
  const assertDraft = (p: ProtocolRow) => {
    if (p.status !== 'Draft') throw new AppError(409, 'ILLEGAL_TRANSITION', `Stability protocol ${p.code} revision ${p.revision} is ${p.status}; only a Draft is approved.`);
  };
  const row = await findProtocol(db, id);
  assertDraft(row);
  await assertApproverIndependent(db, req, user, row);
  if (row.version !== expectedVersion) throw new ConflictError();
  await assertApprovable(db, row);

  return signRecord({
    db, user, meaningCode: PROTOCOL_MEANING, credentials: args.credentials, reason: args.reason, entityType: 'StabilityProtocol', entityId: id,
    context: securityEventContext(req),
    execute: async (tx) => {
      await lockCode(tx, row.code);
      const current = await lockRow(tx, stabilityProtocols, id);
      assertDraft(current);
      await assertApprovable(tx, current);
      const [previous] = await tx.select().from(stabilityProtocols).where(sql`lower(${stabilityProtocols.code}) = ${current.code.toLowerCase()} AND ${stabilityProtocols.status} = 'Approved'`).limit(1);
      if (previous) {
        await updateVersioned(tx, stabilityProtocols, previous.id, previous.version, { status: 'Superseded' });
        await writeAudit(tx, user.id, 'StatusChange', 'StabilityProtocol', previous.id, 'status', 'Approved', 'Superseded', `Superseded by revision ${current.revision} (${id})`);
      }
      const updated = await updateVersioned(tx, stabilityProtocols, id, expectedVersion, { status: 'Approved', approvedBy: user.id, approvedAt: new Date() });
      return {
        recordVersion: updated.version,
        audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Approved', reason: args.reason?.trim() || `Revision ${current.revision} of stability protocol ${current.code} approved for use` },
        result: updated,
      };
    },
  });
}
