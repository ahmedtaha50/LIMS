/**
 * Domain: methods (roadmap M18). Owned by r2-methods-calc.
 *
 *   GET  /methods                 every revision of every method, with author and approver names
 *   POST /methods                 revision 1 of a new method, a Draft (code unique ignoring case: 409)
 *   PUT  /methods/:id             a Draft only (423 otherwise), with the version predicate (409), one audit entry per changed field
 *   POST /methods/:id/revise      the next revision, a Draft cloned from the Effective one (one Draft per code: 409)
 *   POST /methods/:id/approve     METHOD_APPROVAL through signRecord, never by the author or an editor (403 SOD_VIOLATION); the
 *                                 Effective revision of the code becomes Superseded in the same transaction
 *
 * The lifecycle (Draft -> Effective -> Superseded, revise, independent approval) is shared with calculation formulas
 * (./calc.ts) and test plans (./test-plans.ts) through the helpers exported here. Who may call each route:
 * src/server/authz/routeTable.ts (method.view, method.manage, method.approve).
 */
import { randomBytes } from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Request } from 'express';
import { users } from '../../db/schema';
import { calcFormulas } from '../../db/schema/calc';
import { methods, testPlans } from '../../db/schema/methods';
import { writeAudit } from '../../db/utils';
import { configApproveSchema, methodCreateSchema, methodUpdateSchema, reviseSchema, type SstCriterion } from '../../lib/validations/methods';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, auditParticipants, SodViolationError } from '../authz/sod';
import type { Db, RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { asSigned, registerSignable, signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

// ---- the shared lifecycle ------------------------------------------------------------------------------------------------------

export type ConfigKind = 'Method' | 'CalcFormula' | 'TestPlan';

const CONFIG = {
  Method: { table: methods, meaning: 'METHOD_APPROVAL', prefix: 'MTH', label: 'method', route: 'POST /methods/:id/approve' },
  CalcFormula: { table: calcFormulas, meaning: 'FORMULA_APPROVAL', prefix: 'FRM', label: 'formula', route: 'POST /calc/formulas/:id/approve' },
  TestPlan: { table: testPlans, meaning: 'TEST_PLAN_APPROVAL', prefix: 'TPL', label: 'test plan', route: 'POST /test-plans/:id/approve' },
} as const;

/** The columns every configuration record has (methods, calc_formulas, test_plans). */
export interface ConfigRow {
  id: string; code: string; revision: number; status: string; version: number;
  createdBy: string | null; approvedBy: string | null; approvedAt: Date | null; createdAt: Date;
}

// The three tables share these columns; drizzle's builders do not accept a union of tables, so the helpers address them as one.
const tableOf = (kind: ConfigKind) => CONFIG[kind].table as unknown as typeof methods;

export const newConfigId = (kind: ConfigKind) => `${CONFIG[kind].prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;
/** An audit value: '' for nothing, JSON for a structure, the text otherwise. */
const auditText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';

/** Holds, until the transaction ends, the right to create or approve revisions of one code. */
const lockCode = (tx: Executor, kind: ConfigKind, code: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${kind}:${code.toLowerCase()}`}))`);

export async function revisionsOfCode<T extends ConfigRow>(ex: Executor, kind: ConfigKind, code: string): Promise<T[]> {
  const t = tableOf(kind);
  return await ex.select().from(t).where(sql`lower(${t.code}) = ${code.toLowerCase()}`).orderBy(desc(t.revision)) as unknown as T[];
}

/** The Effective revision of a code, or null. */
export async function effectiveByCode<T extends ConfigRow>(ex: Executor, kind: ConfigKind, code: string): Promise<T | null> {
  const t = tableOf(kind);
  const [row] = await ex.select().from(t).where(sql`lower(${t.code}) = ${code.toLowerCase()} AND ${t.status} = 'Effective'`).limit(1);
  return (row as unknown as T) ?? null;
}

export async function findConfig<T extends ConfigRow>(ex: Executor, kind: ConfigKind, id: string): Promise<T> {
  const t = tableOf(kind);
  const [row] = await ex.select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) throw new NotFoundError(`${capital(CONFIG[kind].label)} ${id} was not found.`);
  return row as unknown as T;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every revision with the names of its author and approver, newest revision first within a code. */
export async function listConfig(db: Db, kind: ConfigKind, where?: ReturnType<typeof sql>) {
  const t = tableOf(kind);
  const author = alias(users, 'cfg_author');
  const approver = alias(users, 'cfg_approver');
  const q = db.select({ row: t, createdByName: author.name, approvedByName: approver.name }).from(t)
    .leftJoin(author, eq(author.id, t.createdBy)).leftJoin(approver, eq(approver.id, t.approvedBy));
  const rows = await (where ? q.where(where) : q).orderBy(sql`lower(${t.code})`, desc(t.revision));
  return rows.map(r => ({ ...(r.row as object), createdByName: r.createdByName, approvedByName: r.approvedByName }));
}

/** Revision 1 of a new code, a Draft, with its Create audit entry. */
export async function createConfig<T extends ConfigRow>(db: Db, user: { id: string }, kind: ConfigKind, values: Record<string, unknown> & { code: string }): Promise<T> {
  return withTransaction(db, async (tx) => {
    await lockCode(tx, kind, values.code);
    const existing = await revisionsOfCode(tx, kind, values.code);
    if (existing.length > 0) {
      throw new AppError(409, 'DUPLICATE', `A ${CONFIG[kind].label} with the code ${existing[0].code} already exists (revision ${existing[0].revision}, ${existing[0].status}). Draft a new revision of it instead.`);
    }
    const record = { ...values, id: newConfigId(kind), revision: 1, status: 'Draft', createdBy: user.id, version: 1 };
    let row: T;
    try {
      [row] = await tx.insert(tableOf(kind)).values(record as any).returning() as unknown as T[];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A ${CONFIG[kind].label} with the code ${values.code} already exists.`);
      throw e;
    }
    await writeAudit(tx, user.id, 'Create', kind, row.id, 'all', '', JSON.stringify(record), `Revision 1 of ${CONFIG[kind].label} ${values.code} drafted`);
    return row;
  });
}

/**
 * Edits a Draft: 404, 423 for anything that is not a Draft, 409 for a stale version. `check` sees the row and the changes inside
 * the transaction (to validate what depends on the record). One audit entry per field that changes.
 */
export async function updateConfig<T extends ConfigRow>(
  db: Db, user: { id: string }, kind: ConfigKind, id: string, expectedVersion: number, changes: Record<string, unknown>,
  check?: (tx: Tx, row: T, changes: Record<string, unknown>) => Promise<void>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    const current = await lockRow(tx, tableOf(kind), id) as unknown as T;
    if (current.status !== 'Draft') {
      throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: ${capital(CONFIG[kind].label)} ${current.code} revision ${current.revision} is ${current.status}; only a Draft is edited. Draft a new revision instead.`);
    }
    if (current.version !== expectedVersion) throw new ConflictError();
    if (check) await check(tx, current, changes);
    const set = Object.fromEntries(Object.entries(changes).filter(([k, v]) => v !== undefined && auditText(v) !== auditText((current as any)[k])));
    if (Object.keys(set).length === 0) throw new BadRequestError('Nothing changes: the values sent are the values the record already holds.');
    const row = await updateVersioned(tx, tableOf(kind), id, expectedVersion, set) as unknown as T;
    for (const [field, value] of Object.entries(set)) {
      await writeAudit(tx, user.id, 'Update', kind, id, field, auditText((current as any)[field]), auditText(value), `${capital(CONFIG[kind].label)} ${current.code} revision ${current.revision}: ${field} edited`);
    }
    return row;
  });
}

/** The next revision of a code, a Draft cloned (by `clone`) from its Effective revision. */
export async function reviseConfig<T extends ConfigRow>(db: Db, user: { id: string }, kind: ConfigKind, id: string, clone: (row: T) => Record<string, unknown>): Promise<T> {
  return withTransaction(db, async (tx) => {
    const source = await findConfig<T>(tx, kind, id);
    await lockCode(tx, kind, source.code);
    const revisions = await revisionsOfCode<T>(tx, kind, source.code);
    const draft = revisions.find(r => r.status === 'Draft');
    if (draft) throw new AppError(409, 'DRAFT_EXISTS', `Revision ${draft.revision} of ${source.code} (${draft.id}) is already a Draft: edit and approve it; a code has one Draft at a time.`, { draft: draft.id });
    const fresh = revisions.find(r => r.id === id)!;
    if (fresh.status !== 'Effective') throw new AppError(409, 'NOT_EFFECTIVE', `Revision ${fresh.revision} of ${fresh.code} is ${fresh.status}: a new revision is drafted from the Effective one.`);
    const revision = Math.max(...revisions.map(r => r.revision)) + 1;
    const record = { ...clone(fresh), code: fresh.code, id: newConfigId(kind), revision, status: 'Draft', createdBy: user.id, version: 1 };
    const [row] = await tx.insert(tableOf(kind)).values(record as any).returning() as unknown as T[];
    await writeAudit(tx, user.id, 'Create', kind, row.id, 'all', '', JSON.stringify(record), `Revision ${revision} of ${CONFIG[kind].label} ${fresh.code} drafted from revision ${fresh.revision} (${fresh.id})`);
    return row;
  });
}

/** Independence: never the author, never anyone the audit trail shows creating or editing the record (audited as AUTHZ_DENIED). */
async function assertApproverIndependent(db: Db, req: Request, user: { id: string; role: string }, kind: ConfigKind, row: ConfigRow) {
  const rule = { code: `${kind}.approve`, description: `The person who approves a ${CONFIG[kind].label} must not have drafted or edited it.` };
  const participants = await auditParticipants(db, kind, row.id, ['Create', 'Update']);
  try {
    assertIndependent([row.createdBy, ...participants], user.id, rule, { entity: kind, entityId: row.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, user, { route: CONFIG[kind].route, ...(e.details as object) });
    throw e;
  }
}

/**
 * Signs a Draft Effective. Everything that can be refused without the password is refused first (404, 409 not a Draft, 403 SoD,
 * 409 stale version, then `precheck`), so a refusal costs the signer no attempt. In the signing transaction the row is locked and
 * checked again, the Effective revision of the code (if any) becomes Superseded with its audit entry, and the Draft becomes
 * Effective with the version predicate; signRecord writes the Approve audit entry and the signature bound to the new version.
 */
export async function approveConfig<T extends ConfigRow>(args: {
  db: Db; req: Request; user: { id: string; role: string }; kind: ConfigKind; id: string; expectedVersion: number;
  credentials: { password: string; totpCode?: string }; reason?: string;
  precheck?: (ex: Executor, row: T) => Promise<void>;
}) {
  const { db, req, user, kind, id, expectedVersion } = args;
  const label = CONFIG[kind].label;
  const row = await findConfig<T>(db, kind, id);
  const assertDraft = (r: T) => {
    if (r.status !== 'Draft') throw new AppError(409, 'ILLEGAL_TRANSITION', `${capital(label)} ${r.code} revision ${r.revision} is ${r.status}; only a Draft is approved.`);
  };
  assertDraft(row);
  await assertApproverIndependent(db, req, user, kind, row);
  if (row.version !== expectedVersion) throw new ConflictError();
  if (args.precheck) await args.precheck(db, row);

  return signRecord({
    db, user, meaningCode: CONFIG[kind].meaning, credentials: args.credentials, reason: args.reason, entityType: kind, entityId: id,
    context: securityEventContext(req),
    execute: async (tx) => {
      await lockCode(tx, kind, row.code);
      const current = await lockRow(tx, tableOf(kind), id) as unknown as T;
      assertDraft(current);
      if (args.precheck) await args.precheck(tx, current);
      const previous = await effectiveByCode<T>(tx, kind, current.code);
      if (previous) {
        await updateVersioned(tx, tableOf(kind), previous.id, previous.version, { status: 'Superseded' } as any);
        await writeAudit(tx, user.id, 'StatusChange', kind, previous.id, 'status', 'Effective', 'Superseded', `Superseded by revision ${current.revision} (${id})`);
      }
      const updated = await updateVersioned(tx, tableOf(kind), id, expectedVersion, { status: 'Effective', approvedBy: user.id, approvedAt: new Date() } as any) as unknown as T;
      return {
        recordVersion: updated.version,
        audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Effective', reason: args.reason?.trim() || `Revision ${current.revision} of ${label} ${current.code} approved for use` },
        result: updated,
      };
    },
  });
}

// ---- methods -------------------------------------------------------------------------------------------------------------------

type MethodRow = typeof methods.$inferSelect;

// A signature on a method covers the method as approved: everything but the counters and the approval bookkeeping.
registerSignable({
  type: 'Method',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(methods).where(eq(methods.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, code: row.code, title: row.title, description: row.description, revision: row.revision, instrumentType: row.instrumentType,
      requiredTrainingModule: row.requiredTrainingModule, sstCriteria: row.sstCriteria, status: asSigned(change, ['status'], row.status),
    };
  },
});

/** Every formula an SST criterion names must exist (it must be Effective when a run is recorded). */
async function assertSstFormulasExist(ex: Executor, criteria: readonly SstCriterion[] | undefined) {
  for (const c of criteria ?? []) {
    const [f] = await ex.select({ id: calcFormulas.id }).from(calcFormulas).where(sql`lower(${calcFormulas.code}) = ${c.formulaCode.toLowerCase()}`).limit(1);
    if (!f) throw new BadRequestError(`${c.name}: the formula ${c.formulaCode} does not exist.`);
  }
}

export const methodsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/methods', requireAuth, async (_req, res) => {
    res.json(await listConfig(db, 'Method'));
  });

  router.post('/methods', requireAuth, validate(methodCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as { code: string; title: string; description: string | null; instrumentType: string | null; requiredTrainingModule: string | null; sstCriteria?: SstCriterion[] };
    await assertSstFormulasExist(db, body.sstCriteria);
    res.json(await createConfig<MethodRow>(db, user, 'Method', { ...body, sstCriteria: body.sstCriteria ?? [] }));
  });

  router.put('/methods/:id', requireAuth, validate(methodUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const { expectedVersion, ...changes } = req.body as Record<string, unknown> & { expectedVersion: number };
    res.json(await updateConfig<MethodRow>(db, user, 'Method', String(req.params.id), expectedVersion, changes,
      async (tx, _row, c) => assertSstFormulasExist(tx, c.sstCriteria as SstCriterion[] | undefined)));
  });

  router.post('/methods/:id/revise', requireAuth, validate(reviseSchema), async (req, res) => {
    const user = (req as any).user;
    res.json(await reviseConfig<MethodRow>(db, user, 'Method', String(req.params.id), r => ({
      title: r.title, description: r.description, instrumentType: r.instrumentType, requiredTrainingModule: r.requiredTrainingModule, sstCriteria: r.sstCriteria,
    })));
  });

  router.post('/methods/:id/approve', requireAuth, validate(configApproveSchema), async (req, res) => {
    const user = (req as any).user;
    const { password, totpCode, reason, expectedVersion } = req.body as { password: string; totpCode?: string; reason?: string; expectedVersion: number };
    const { result, signature } = await approveConfig<MethodRow>({
      db, req, user, kind: 'Method', id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason,
      precheck: async (ex, row) => assertSstFormulasExist(ex, row.sstCriteria as SstCriterion[]),
    });
    res.json({ method: result, signature });
  });

  return router;
};
