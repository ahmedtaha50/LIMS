// Domain: reagents, reference standards and prepared solutions (roadmap M13 receipt, M30 lifecycle). Owned by r2-reagents.
//
// Legacy (reagentsRoutes, v0.1.0 register; nothing links a result to it):
//   GET  /reagents                              the flat register of v0.1.0 and R1
//   POST /reagents                              receipt into that register (e-signed RECEIPT); kept for compatibility, see
//                                               docs/changes/r2-reagents.md (the screen receives lots instead)
//
// Inventory (reagentInventoryRoutes, registered by the wave gate):
//   GET  /reagent-items, POST /reagent-items, PUT /reagent-items/:id          the item master (versioned; an audit entry per field)
//   GET  /reagent-lots[?itemId&status], GET /reagent-lots/:id                 each lot with its balance and whether it may be used
//   POST /reagent-lots                          receipt: e-signed RECEIPT by the receiver; the lot starts in Quarantine and its
//                                               first ledger row (Receipt) carries the quantity received
//   POST /reagent-lots/:id/release              e-signed REAGENT_LOT_RELEASE, never by the receiver (403 SOD_VIOLATION): Approved
//   POST /reagent-lots/:id/reject               e-signed REAGENT_LOT_REJECTION with a reason: Rejected (final)
//   POST /reagent-lots/:id/retest               e-signed REAGENT_LOT_RETEST with a reason: a new retest date (after today, not
//                                               after the expiry date)
//   POST /reagent-lots/:id/open                 Approved -> InUse; in_use_expiry = min(expiry, today + in-use shelf life)
//   POST /reagent-lots/:id/consume              a ledger row (Consumed); a balance of 0 closes the lot (Consumed)
//   POST /reagent-lots/:id/dispose              the remaining balance is disposed of, with a reason (Disposed, final)
//   GET  /reagent-lots/:id/traceback            every result measured with the lot, directly or through solutions made from it
//   GET  /prepared-solutions, GET /prepared-solutions/:id, POST /prepared-solutions (components consumed from their lots and
//        solutions in the same transaction; the expiry may not be after any parent's: 400 naming the parent and its date),
//   POST /prepared-solutions/:id/consume, POST /prepared-solutions/:id/discard, GET /prepared-solutions/:id/traceback
//   GET  /reagent-materials                     lots and solutions for a result: each with `usable` and, if not, why (the picker
//                                               shows expired, quarantined and rejected material disabled with that reason)
//   GET  /samples/:id/materials                 the materials linked to the results of a sample
//   POST /samples/:id/results/:resultId/materials   links a lot or solution to a result (optional quantity used); 400 naming the lot
//                                               and the date when it may not be used
//   POST /result-materials/:id/withdraw         withdraws a wrong link, with a reason (while the sample is in Testing)
//
// Every change is audited in its own transaction; every update carries the version predicate; the actor is req.user.
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { reagents, results, samples } from '../../db/schema';
import {
  POTENCY_BASES, REAGENT_CATEGORIES, preparedSolutionComponents, preparedSolutions, reagentItems, reagentLots, reagentTransactions, resultMaterials,
  type PreparedSolution, type ReagentItem, type ReagentLot,
} from '../../db/schema/reagents';
import { writeAudit } from '../../db/utils';
import { RESULT_ENTRY_ROLES, RESULT_ENTRY_STATE } from '../../lib/constants/results';
import { calendarDate, utcToday } from '../../lib/validations/instruments';
import { reagentSchema } from '../../lib/validations/reagents';
import { signatureFields } from '../../lib/validations/signatures';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { assertIndependent, SodViolationError } from '../authz/sod';
import { type Db, type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Executor, type Tx } from '../core/tx';
import { registerSignable, signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors';
import { validate } from '../http/validate';
import {
  appendTransaction, assertUsable, balanceOf, closeIfEmpty, inUseExpiryOf, linkResultMaterials, lotUseLimit, materialStates,
  parentLimit, type Holder, type MaterialState,
} from '../services/result-guards/reagent';

// ---- request schemas (strict; ids, status, versions of the server, people and times are never accepted) ---------------------------

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);
const optionalText = (label: string, max = 200) => text(label, max).optional();
const quantity = (label: string) => z.number({ error: `${label} must be a number.` })
  .positive(`${label} must be more than 0.`).max(1e9, `${label} is too large.`)
  .refine(v => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, `${label} has at most 4 decimals.`);
const expectedVersion = z.number('expectedVersion must be a number').int().positive('Record version mismatch. Refresh required.');
const reason = z.string('A reason is required.').trim().min(5, 'A clear reason is required (at least 5 characters, ALCOA+).').max(1000);
const id = z.string().min(1).max(100);

export const reagentItemCreateSchema = z.object({
  code: text('Item code', 50),
  name: text('Item name'),
  category: z.enum(REAGENT_CATEGORIES, { error: `category must be one of ${REAGENT_CATEGORIES.join(', ')}.` }),
  grade: optionalText('Grade', 100),
  unit: text('Unit', 20),
  storageCondition: optionalText('Storage condition'),
  inUseShelfLifeDays: z.number('The in-use shelf life is a number of days.').int('The in-use shelf life is a whole number of days.').min(1).max(3650).optional(),
  requiresPotency: z.boolean().optional(),
}).strict();

export const reagentItemUpdateSchema = z.object({
  name: optionalText('Item name'),
  grade: text('Grade', 100).nullable().optional(),
  storageCondition: text('Storage condition').nullable().optional(),
  inUseShelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
  requiresPotency: z.boolean().optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
  reason,
  expectedVersion,
}).strict();

/** POST /reagent-lots: the receipt, signed by the receiver (RECEIPT). The unit is the item's; the status starts in Quarantine. */
export const reagentLotReceiptSchema = z.object({
  itemId: id,
  lotNumber: text('Supplier lot number', 100),
  supplier: text('Supplier'),
  quantity: quantity('Quantity received'),
  expiryDate: calendarDate('Expiry date'),
  retestDate: calendarDate('Retest date').optional(),
  potency: z.number('Potency must be a number.').positive('Potency must be more than 0.').max(1e6).optional(),
  potencyBasis: z.enum(POTENCY_BASES, { error: `potencyBasis must be one of ${POTENCY_BASES.join(', ')}.` }).optional(),
  coaReference: optionalText('Certificate of analysis reference'),
  storageLocation: optionalText('Storage location'),
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();

export const reagentLotSignSchema = z.object({
  expectedVersion, password: signatureFields.password, totpCode: signatureFields.totpCode, reason: signatureFields.reason,
}).strict();
export const reagentLotRejectSchema = z.object({ expectedVersion, password: signatureFields.password, totpCode: signatureFields.totpCode, reason }).strict();
export const reagentLotRetestSchema = z.object({
  expectedVersion, retestDate: calendarDate('New retest date'), password: signatureFields.password, totpCode: signatureFields.totpCode, reason,
}).strict();
export const reagentLotOpenSchema = z.object({ expectedVersion }).strict();
export const reagentConsumeSchema = z.object({ quantity: quantity('Quantity'), reason }).strict();
export const reagentCloseSchema = z.object({ expectedVersion, reason }).strict();

export const preparedSolutionSchema = z.object({
  name: text('Solution name'),
  concentration: optionalText('Concentration', 100),
  preparation: text('Preparation (procedure and what was done)', 2000),
  quantity: quantity('Quantity prepared'),
  unit: text('Unit', 20),
  expiryDate: calendarDate('Expiry date'),
  storageCondition: optionalText('Storage condition'),
  components: z.array(z.object({ materialId: id, quantity: quantity('Component quantity') }).strict(), 'components must be a list.')
    .min(1, 'A solution is made from at least one lot or solution.').max(20, 'At most 20 components.')
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((c, i) => {
        if (seen.has(c.materialId)) ctx.addIssue({ code: 'custom', path: [i, 'materialId'], message: `${c.materialId} appears more than once.` });
        seen.add(c.materialId);
      });
    }),
}).strict();

export const resultMaterialLinkSchema = z.object({ materialId: id, quantity: quantity('Quantity used').optional() }).strict();
export const resultMaterialWithdrawSchema = z.object({ reason }).strict();

const lotListQuerySchema = z.object({
  itemId: id.optional(),
  status: z.string().max(50).optional(),
}).strict();

// ---- signatures --------------------------------------------------------------------------------------------------------------

// A signature on a lot covers its receipt (frozen by trigger) and the signed event (receipt, release, rejection or retest) as the
// audit entry recorded it; the audit chain protects that entry. Later moves of the lot (opened, consumed) do not break it.
registerSignable({
  type: 'ReagentLot',
  async canonical(ex, { id: lotId, change }) {
    if (!change) return null;
    const [l] = await ex.select().from(reagentLots).where(eq(reagentLots.id, lotId)).limit(1);
    if (!l) return null;
    return {
      id: l.id, itemId: l.itemId, lotNumber: l.lotNumber, supplier: l.supplier, coaReference: l.coaReference, receivedQuantity: l.receivedQuantity,
      unit: l.unit, expiryDate: l.expiryDate, potency: l.potency, potencyBasis: l.potencyBasis, receivedBy: l.receivedBy,
      receivedAt: l.receivedAt.toISOString(), event: { action: change.action, field: change.field, oldValue: change.oldValue, newValue: change.newValue },
    };
  },
});

// ---- helpers -----------------------------------------------------------------------------------------------------------------

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const auditValue = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';
const FINAL_LOT = new Set(['Consumed', 'Disposed', 'Expired', 'Rejected']);

const lotView = (lot: ReagentLot, item: Pick<ReagentItem, 'code' | 'name' | 'category'>, balance: string, state: MaterialState | undefined) => ({
  ...lot,
  receivedQuantity: Number(lot.receivedQuantity), potency: lot.potency === null ? null : Number(lot.potency),
  itemCode: item.code, itemName: item.name, category: item.category, balance: Number(balance),
  useUntil: lotUseLimit(lot), usable: state?.usable ?? false, blockedReason: state?.blockedReason ?? null,
});
const solutionView = (s: PreparedSolution, balance: string, state: MaterialState | undefined) => ({
  ...s, quantity: Number(s.quantity), balance: Number(balance), useUntil: s.expiryDate, usable: state?.usable ?? false, blockedReason: state?.blockedReason ?? null,
});
const txView = (t: typeof reagentTransactions.$inferSelect) => ({ ...t, qtyDelta: Number(t.qtyDelta), balanceAfter: Number(t.balanceAfter) });

/** Latest balance per holder, in one query. */
async function balances(ex: Executor, column: 'lot_id' | 'solution_id', ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await ex.execute(sql`
    SELECT DISTINCT ON (${sql.raw(column)}) ${sql.raw(column)} AS id, balance_after::text AS balance FROM reagent_transactions
     WHERE ${sql.raw(column)} IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) ORDER BY ${sql.raw(column)}, seq DESC`);
  return new Map((res as any).rows.map((r: any) => [r.id, r.balance]));
}

async function findLot(ex: Executor, lotId: string) {
  const [row] = await ex.select({ lot: reagentLots, item: reagentItems }).from(reagentLots)
    .innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId)).where(eq(reagentLots.id, lotId)).limit(1);
  if (!row) throw new NotFoundError(`Reagent lot ${lotId} was not found.`);
  return row;
}
const lotName = (lot: ReagentLot, item: ReagentItem) => `Reagent lot ${lot.id} (${item.name}, supplier lot ${lot.lotNumber})`;

/** The checks of a signed move that need no password, so a refusal costs the signer no attempt. Run again inside the signing transaction. */
function assertLotMove(lot: ReagentLot, label: string, allowedFrom: readonly string[], to: string, expected: number) {
  if (FINAL_LOT.has(lot.status)) throw new AppError(423, 'RECORD_LOCKED', `${label} is ${lot.status}: it can no longer be changed.`);
  if (!allowedFrom.includes(lot.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `${label} is ${lot.status}: it cannot be ${to} from that status.`);
  if (lot.version !== expected) throw new ConflictError();
}

async function assertNotReceiver(db: Db, req: Request, user: { id: string; role: string }, lot: ReagentLot) {
  const rule = { code: 'reagent.release', description: 'The person who releases or rejects a received lot must not be the person who received it.' };
  try {
    assertIndependent([lot.receivedBy], user.id, rule, { entity: 'ReagentLot', entityId: lot.id });
  } catch (e) {
    if (e instanceof SodViolationError) await recordDenied(db, req, user, { route: req.path, ...(e.details as object) });
    throw e;
  }
}

/** Every result measured with a lot or solution: directly, or through any solution made from it (at any depth). */
async function traceback(ex: Executor, root: { lotId?: string; solutionId?: string }, limit = 5000) {
  const start = root.lotId
    ? sql`SELECT c.solution_id, 1 AS depth FROM prepared_solution_components c WHERE c.lot_id = ${root.lotId}`
    : sql`SELECT c.solution_id, 1 AS depth FROM prepared_solution_components c WHERE c.parent_solution_id = ${root.solutionId!}`;
  const tree = await ex.execute(sql`
    WITH RECURSIVE made(solution_id, depth) AS (
      ${start}
      UNION
      SELECT c.solution_id, made.depth + 1 FROM made JOIN prepared_solution_components c ON c.parent_solution_id = made.solution_id WHERE made.depth < 20
    )
    SELECT made.solution_id AS id, min(made.depth) AS depth, s.name, s.status, s.expiry_date AS "expiryDate"
      FROM made JOIN prepared_solutions s ON s.id = made.solution_id GROUP BY made.solution_id, s.name, s.status, s.expiry_date ORDER BY 2, 1`);
  const solutions = (tree as any).rows as Array<{ id: string; depth: number; name: string; status: string; expiryDate: string }>;
  const via = solutions.map(s => s.id);
  const own = root.lotId ? sql`rm.lot_id = ${root.lotId}` : sql`rm.solution_id = ${root.solutionId!}`;
  const where = via.length ? sql`(${own} OR rm.solution_id IN (${sql.join(via.map(v => sql`${v}`), sql`, `)}))` : own;
  const rows = await ex.execute(sql`
    SELECT rm.id AS "linkId", rm.result_id AS "resultId", r.parameter, r.value, r.is_oos AS "isOos", r.version AS "resultVersion",
           rm.result_version AS "linkedAtResultVersion", rm.sample_id AS "sampleId", s.state AS "sampleState", s.material, s.batch,
           coalesce(rm.lot_id, rm.solution_id) AS "materialId", rm.quantity::text AS quantity, rm.linked_by AS "linkedBy", rm.linked_at AS "linkedAt",
           rm.withdrawn_at AS "withdrawnAt", rm.withdraw_reason AS "withdrawReason"
      FROM result_materials rm JOIN results r ON r.id = rm.result_id JOIN samples s ON s.id = rm.sample_id
     WHERE ${where}
     ORDER BY rm.linked_at DESC, rm.id
     LIMIT ${limit + 1}`);
  const list = (rows as any).rows as any[];
  return {
    solutions,
    results: list.slice(0, limit).map(r => ({ ...r, quantity: r.quantity === null ? null : Number(r.quantity) })),
    truncated: list.length > limit,
  };
}

async function sampleForEntry(tx: Tx, user: { role: string }, sampleId: string) {
  const sample = await lockRow(tx, samples, sampleId);
  if (!RESULT_ENTRY_ROLES.includes(user.role)) {
    throw new ForbiddenError(`Forbidden: the materials of a result are recorded by ${RESULT_ENTRY_ROLES.join(' or ')}, who enter results.`);
  }
  if (sample.state === 'Approved' || sample.state === 'Rejected') {
    throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: Sample ${sampleId} is ${sample.state}; its results can no longer be changed.`);
  }
  if (sample.state !== RESULT_ENTRY_STATE) {
    throw new AppError(409, 'SAMPLE_NOT_IN_TESTING', `Materials are recorded while the sample is in ${RESULT_ENTRY_STATE}; sample ${sampleId} is ${sample.state}.`);
  }
  return sample;
}

/**
 * The lot counts of the dashboard (GET /dashboard adds them to the legacy register's): `active` may be used today (Approved or In
 * use, within expiry, in-use expiry and retest date), `expired` is Expired or past its use limit while still open. Quarantined,
 * used-up, disposed and rejected lots are in neither.
 */
export async function reagentLotCounts(ex: Executor, today = utcToday()): Promise<{ active: number; expired: number }> {
  const res = await ex.execute(sql`
    SELECT count(*) FILTER (WHERE status IN ('Approved', 'InUse') AND least(expiry_date, coalesce(in_use_expiry, expiry_date)) >= ${today}
                              AND (retest_date IS NULL OR retest_date >= ${today}))::int AS active,
           count(*) FILTER (WHERE status = 'Expired' OR (status IN ('Quarantine', 'Approved', 'InUse') AND least(expiry_date, coalesce(in_use_expiry, expiry_date)) < ${today}))::int AS expired
      FROM reagent_lots`);
  const row = (res as any).rows[0];
  return { active: Number(row.active), expired: Number(row.expired) };
}

// ---- legacy routes (unchanged behaviour) ---------------------------------------------------------------------------------------

export const reagentsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/reagents', requireAuth, validate(reagentSchema), async (req, res) => {
    const user = (req as any).user;
    const { name, lotNumber, expiryDate, quantity: amount, password, totpCode } = req.body as z.infer<typeof reagentSchema>;
    // An expiry date is valid through the end of that day; a reagent that has already expired is not received into stock.
    if (expiryDate < utcToday()) {
      throw new ValidationError('The expiry date has passed: an expired reagent cannot be received into stock.', [{ path: 'expiryDate', message: 'The expiry date has passed.' }]);
    }

    const reagentId = `RGT-${randomBytes(4).toString('hex')}`;
    const { result } = await signRecord({
      db, user, meaningCode: 'RECEIPT',
      credentials: { password, totpCode },
      entityType: 'Reagent', entityId: reagentId,
      context: securityEventContext(req),
      execute: async (tx) => {
        const record = { id: reagentId, name, lotNumber, expiryDate, quantity: amount, status: 'Available' };
        await tx.insert(reagents).values(record);
        return {
          recordVersion: 1, // reagents have no version column: the receipt is an event on a record that is created by it
          audit: { action: 'Create', field: 'all', oldValue: '', newValue: JSON.stringify(record), reason: 'Reagent received and registered' },
          result: record,
        };
      },
    });
    res.json(result);
  });

  router.get('/reagents', requireAuth, async (_req, res) => {
    res.json(await db.select().from(reagents));
  });

  return router;
};

// ---- the inventory -----------------------------------------------------------------------------------------------------------

export const reagentInventoryRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // -- item master --
  router.get('/reagent-items', requireAuth, async (_req, res) => {
    res.json(await db.select().from(reagentItems).orderBy(asc(reagentItems.code)));
  });

  router.post('/reagent-items', requireAuth, validate(reagentItemCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as z.infer<typeof reagentItemCreateSchema>;
    const created = await withTransaction(db, async (tx) => {
      const record = {
        id: `RI-${randomBytes(5).toString('hex').toUpperCase()}`, code: body.code, name: body.name, category: body.category, grade: body.grade ?? null,
        unit: body.unit, storageCondition: body.storageCondition ?? null, inUseShelfLifeDays: body.inUseShelfLifeDays ?? null,
        requiresPotency: body.requiresPotency ?? body.category === 'ReferenceStandard', status: 'Active', createdBy: user.id, version: 1,
      };
      let row: ReagentItem;
      try {
        [row] = await tx.insert(reagentItems).values(record).returning();
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A reagent item with the code ${body.code} already exists.`);
        throw e;
      }
      const { createdAt: _c, ...stated } = row;
      await writeAudit(tx, user.id, 'Create', 'ReagentItem', row.id, 'all', '', JSON.stringify(stated), `Reagent item ${row.code} defined`);
      return row;
    });
    res.json(created);
  });

  router.put('/reagent-items/:id', requireAuth, validate(reagentItemUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const itemId = String(req.params.id);
    const { expectedVersion: expected, reason: why, ...changes } = req.body as z.infer<typeof reagentItemUpdateSchema>;
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, reagentItems, itemId);
      if (current.version !== expected) throw new ConflictError();
      const set: Partial<ReagentItem> = {};
      for (const [k, v] of Object.entries(changes) as Array<[keyof typeof changes, unknown]>) {
        if (v !== undefined && v !== (current as any)[k]) (set as any)[k] = v;
      }
      if (Object.keys(set).length === 0) throw new BadRequestError('Nothing to change: every field is what is already recorded.');
      const row = await updateVersioned(tx, reagentItems, itemId, expected, set);
      for (const k of Object.keys(set) as Array<keyof typeof set>) {
        await writeAudit(tx, user.id, 'Update', 'ReagentItem', itemId, k, auditValue(current[k]), auditValue(row[k]), why);
      }
      return row;
    });
    res.json(updated);
  });

  // -- lots --
  router.get('/reagent-lots', requireAuth, validate(lotListQuerySchema, 'query'), async (req, res) => {
    const { itemId, status } = req.query as { itemId?: string; status?: string };
    const where: SQL[] = [];
    if (itemId) where.push(eq(reagentLots.itemId, itemId));
    if (status) where.push(eq(reagentLots.status, status));
    const rows = await db.select({ lot: reagentLots, item: reagentItems }).from(reagentLots)
      .innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId)).where(where.length ? and(...where) : undefined)
      .orderBy(desc(reagentLots.receivedAt), desc(reagentLots.id)).limit(2000);
    const ids = rows.map(r => r.lot.id);
    const [bal, states] = await Promise.all([balances(db, 'lot_id', ids), materialStates(db, ids)]);
    res.json(rows.map(r => lotView(r.lot, r.item, bal.get(r.lot.id) ?? '0', states.get(r.lot.id))));
  });

  router.get('/reagent-lots/:id', requireAuth, async (req, res) => {
    const { lot, item } = await findLot(db, String(req.params.id));
    const [bal, states, ledger, made] = await Promise.all([
      balanceOf(db, { lotId: lot.id }), materialStates(db, [lot.id]),
      db.select().from(reagentTransactions).where(eq(reagentTransactions.lotId, lot.id)).orderBy(asc(reagentTransactions.seq)),
      db.select({ id: preparedSolutions.id, name: preparedSolutions.name, status: preparedSolutions.status, expiryDate: preparedSolutions.expiryDate })
        .from(preparedSolutionComponents).innerJoin(preparedSolutions, eq(preparedSolutions.id, preparedSolutionComponents.solutionId))
        .where(eq(preparedSolutionComponents.lotId, lot.id)).orderBy(asc(preparedSolutions.id)),
    ]);
    res.json({ lot: lotView(lot, item, bal, states.get(lot.id)), item, ledger: ledger.map(txView), solutions: made });
  });

  router.post('/reagent-lots', requireAuth, validate(reagentLotReceiptSchema), async (req, res) => {
    const user = (req as any).user;
    const b = req.body as z.infer<typeof reagentLotReceiptSchema>;
    const today = utcToday();
    // Everything that can be refused without the password is refused first.
    const [item] = await db.select().from(reagentItems).where(eq(reagentItems.id, b.itemId)).limit(1);
    if (!item) throw new NotFoundError(`Reagent item ${b.itemId} was not found.`);
    if (item.status !== 'Active') throw new AppError(409, 'ITEM_INACTIVE', `Reagent item ${item.code} is ${item.status}: no lot can be received for it.`);
    if (b.expiryDate < today) throw new ValidationError('The expiry date has passed: an expired lot cannot be received into stock.', [{ path: 'expiryDate', message: 'The expiry date has passed.' }]);
    if (b.retestDate && b.retestDate > b.expiryDate) throw new ValidationError('The retest date cannot be after the expiry date.', [{ path: 'retestDate', message: 'After the expiry date.' }]);
    if (b.retestDate && b.retestDate < today) throw new ValidationError('The retest date has passed: retest the lot before it is received for use.', [{ path: 'retestDate', message: 'The retest date has passed.' }]);
    if ((b.potency === undefined) !== (b.potencyBasis === undefined)) {
      throw new ValidationError('A potency is stated with its basis (as is, dried, anhydrous or solvent-free), or neither is given.', [{ path: 'potencyBasis', message: 'Potency and basis go together.' }]);
    }
    if (item.requiresPotency && b.potency === undefined) {
      throw new ValidationError(`${item.name} is received with its potency and the basis of the potency (from the certificate of analysis).`, [{ path: 'potency', message: 'Potency is required for this item.' }]);
    }

    const seq = await withTransaction(db, tx => nextSequence(tx, 'reagent_lot'));
    const lotId = `RL-${pad(seq, 6)}`;
    const { result, signature } = await signRecord({
      db, user, meaningCode: 'RECEIPT', credentials: { password: b.password, totpCode: b.totpCode },
      entityType: 'ReagentLot', entityId: lotId, context: securityEventContext(req),
      execute: async (tx) => {
        const record = {
          id: lotId, itemId: item.id, lotNumber: b.lotNumber, supplier: b.supplier, coaReference: b.coaReference ?? null,
          receivedQuantity: String(b.quantity), unit: item.unit, expiryDate: b.expiryDate, retestDate: b.retestDate ?? null,
          potency: b.potency === undefined ? null : String(b.potency), potencyBasis: b.potencyBasis ?? null, storageLocation: b.storageLocation ?? null,
          status: 'Quarantine', receivedBy: user.id, version: 1,
        };
        const [row] = await tx.insert(reagentLots).values(record).returning();
        await appendTransaction(tx, {
          holder: { lotId }, type: 'Receipt', delta: b.quantity, unit: item.unit, userId: user.id, label: lotName(row, item),
          reason: `Received ${b.quantity} ${item.unit} of ${item.name}, supplier lot ${b.lotNumber} from ${b.supplier}`,
        });
        const { receivedAt: _r, version: _v, ...stated } = row;
        return {
          recordVersion: row.version,
          audit: { action: 'Receive', field: 'all', oldValue: '', newValue: JSON.stringify(stated), reason: `Lot received into quarantine: ${item.name}, supplier lot ${b.lotNumber}` },
          result: row,
        };
      },
    });
    res.json({ lot: lotView(result, item, String(b.quantity), (await materialStates(db, [lotId])).get(lotId)), signature });
  });

  // Release and rejection: never by the receiver; the checks that need no password come first.
  const signedMove = (kind: 'release' | 'reject' | 'retest') => async (req: Request, res: any) => {
    const user = (req as any).user;
    const lotId = String(req.params.id);
    const body = req.body as { expectedVersion: number; password: string; totpCode?: string; reason?: string; retestDate?: string };
    const today = utcToday();
    const spec = {
      release: { from: ['Quarantine'], to: 'Approved', verb: 'released', meaning: 'REAGENT_LOT_RELEASE', action: 'Release' },
      reject: { from: ['Quarantine', 'Approved', 'InUse'], to: 'Rejected', verb: 'rejected', meaning: 'REAGENT_LOT_REJECTION', action: 'Reject' },
      retest: { from: ['Quarantine', 'Approved', 'InUse'], to: null, verb: 'retested', meaning: 'REAGENT_LOT_RETEST', action: 'Retest' },
    }[kind];
    const { lot, item } = await findLot(db, lotId);
    const label = lotName(lot, item);
    assertLotMove(lot, label, spec.from, spec.verb, body.expectedVersion);
    if (kind !== 'retest') await assertNotReceiver(db, req, user, lot);
    if (kind === 'release' && lot.expiryDate < today) throw new AppError(409, 'LOT_EXPIRED', `${label} expired on ${lot.expiryDate}: it cannot be released.`);
    if (kind === 'retest') {
      if (body.retestDate! <= today) throw new ValidationError('The new retest date must be after today.', [{ path: 'retestDate', message: 'Must be after today.' }]);
      if (body.retestDate! > lot.expiryDate) throw new ValidationError(`The new retest date cannot be after the expiry date (${lot.expiryDate}).`, [{ path: 'retestDate', message: 'After the expiry date.' }]);
    }

    const { result, signature } = await signRecord({
      db, user, meaningCode: spec.meaning, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
      entityType: 'ReagentLot', entityId: lotId, context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, reagentLots, lotId);
        assertLotMove(current, label, spec.from, spec.verb, body.expectedVersion);
        const now = new Date();
        const set: Partial<ReagentLot> = kind === 'release' ? { status: 'Approved', releasedBy: user.id, releasedAt: now }
          : kind === 'reject' ? { status: 'Rejected', closedBy: user.id, closedAt: now, closeReason: body.reason! }
          : { retestDate: body.retestDate! };
        const row = await updateVersioned(tx, reagentLots, lotId, body.expectedVersion, set);
        const audit = kind === 'retest'
          ? { action: spec.action, field: 'retestDate', oldValue: auditValue(current.retestDate), newValue: body.retestDate!, reason: body.reason! }
          : { action: spec.action, field: 'status', oldValue: current.status, newValue: row.status, reason: body.reason || `${label} released from quarantine for use` };
        return { recordVersion: row.version, audit, result: row };
      },
    });
    const bal = await balanceOf(db, { lotId });
    res.json({ lot: lotView(result, item, bal, (await materialStates(db, [lotId])).get(lotId)), signature });
  };
  router.post('/reagent-lots/:id/release', requireAuth, validate(reagentLotSignSchema), signedMove('release'));
  router.post('/reagent-lots/:id/reject', requireAuth, validate(reagentLotRejectSchema), signedMove('reject'));
  router.post('/reagent-lots/:id/retest', requireAuth, validate(reagentLotRetestSchema), signedMove('retest'));

  router.post('/reagent-lots/:id/open', requireAuth, validate(reagentLotOpenSchema), async (req, res) => {
    const user = (req as any).user;
    const lotId = String(req.params.id);
    const { expectedVersion: expected } = req.body as { expectedVersion: number };
    const opened = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, reagentLots, lotId);
      const [item] = await tx.select().from(reagentItems).where(eq(reagentItems.id, current.itemId)).limit(1);
      const label = lotName(current, item);
      assertLotMove(current, label, ['Approved'], 'opened', expected);
      const now = new Date();
      const today = utcToday(now);
      if (current.expiryDate < today) throw new AppError(409, 'LOT_EXPIRED', `${label} expired on ${current.expiryDate}: it cannot be opened for use.`);
      if (current.retestDate && current.retestDate < today) throw new AppError(409, 'RETEST_OVERDUE', `${label} is past its retest date ${current.retestDate}: retest it before it is opened.`);
      const inUseExpiry = inUseExpiryOf(current.expiryDate, today, item.inUseShelfLifeDays);
      const row = await updateVersioned(tx, reagentLots, lotId, expected, { status: 'InUse', openedBy: user.id, openedAt: now, inUseExpiry });
      await writeAudit(tx, user.id, 'Open', 'ReagentLot', lotId, 'status', current.status, 'InUse',
        `${label} opened on ${today}; in use until ${inUseExpiry}${item.inUseShelfLifeDays ? ` (in-use shelf life ${item.inUseShelfLifeDays} days, expiry ${current.expiryDate})` : ' (its expiry date)'}`);
      return { row, item };
    });
    const bal = await balanceOf(db, { lotId });
    res.json(lotView(opened.row, opened.item, bal, (await materialStates(db, [lotId])).get(lotId)));
  });

  // Consumption that is not a result's (cleaning, system suitability preparation, spills): a ledger row with its reason.
  const consume = (kind: 'lot' | 'solution') => async (req: Request, res: any) => {
    const user = (req as any).user;
    const materialId = String(req.params.id);
    const { quantity: amount, reason: why } = req.body as { quantity: number; reason: string };
    const out = await withTransaction(db, async (tx) => {
      const holder: Holder = kind === 'lot' ? { lotId: materialId } : { solutionId: materialId };
      if (kind === 'lot') await lockRow(tx, reagentLots, materialId); else await lockRow(tx, preparedSolutions, materialId);
      const [state] = [...(await assertUsable(tx, [materialId], new Date(), 'id')).values()];
      const t = await appendTransaction(tx, { holder, type: 'Consumed', delta: -amount, unit: state.unit, userId: user.id, label: state.label, reason: why });
      await closeIfEmpty(tx, holder, t.balanceAfter, user.id);
      return t;
    });
    res.json(txView(out));
  };
  router.post('/reagent-lots/:id/consume', requireAuth, validate(reagentConsumeSchema), consume('lot'));
  router.post('/prepared-solutions/:id/consume', requireAuth, validate(reagentConsumeSchema), consume('solution'));

  router.post('/reagent-lots/:id/dispose', requireAuth, validate(reagentCloseSchema), async (req, res) => {
    const user = (req as any).user;
    const lotId = String(req.params.id);
    const { expectedVersion: expected, reason: why } = req.body as { expectedVersion: number; reason: string };
    const row = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, reagentLots, lotId);
      const [item] = await tx.select().from(reagentItems).where(eq(reagentItems.id, current.itemId)).limit(1);
      const label = lotName(current, item);
      assertLotMove(current, label, ['Approved', 'InUse'], 'disposed of', expected);
      const left = await balanceOf(tx, { lotId });
      if (Number(left) > 0) {
        await appendTransaction(tx, { holder: { lotId }, type: 'Disposed', delta: -Number(left), unit: current.unit, userId: user.id, label, reason: why });
      }
      const updated = await updateVersioned(tx, reagentLots, lotId, expected, { status: 'Disposed', closedBy: user.id, closedAt: new Date(), closeReason: why });
      await writeAudit(tx, user.id, 'Dispose', 'ReagentLot', lotId, 'status', current.status, 'Disposed', why);
      return { updated, item };
    });
    res.json(lotView(row.updated, row.item, '0', (await materialStates(db, [lotId])).get(lotId)));
  });

  router.get('/reagent-lots/:id/traceback', requireAuth, async (req, res) => {
    const { lot, item } = await findLot(db, String(req.params.id));
    res.json({ material: (await materialStates(db, [lot.id])).get(lot.id), itemCode: item.code, ...(await traceback(db, { lotId: lot.id })) });
  });

  // -- prepared solutions --
  router.get('/prepared-solutions', requireAuth, async (_req, res) => {
    const rows = await db.select().from(preparedSolutions).orderBy(desc(preparedSolutions.preparedAt), desc(preparedSolutions.id)).limit(2000);
    const ids = rows.map(r => r.id);
    const [bal, states] = await Promise.all([balances(db, 'solution_id', ids), materialStates(db, ids)]);
    res.json(rows.map(s => solutionView(s, bal.get(s.id) ?? '0', states.get(s.id))));
  });

  router.get('/prepared-solutions/:id', requireAuth, async (req, res) => {
    const solutionId = String(req.params.id);
    const [s] = await db.select().from(preparedSolutions).where(eq(preparedSolutions.id, solutionId)).limit(1);
    if (!s) throw new NotFoundError(`Prepared solution ${solutionId} was not found.`);
    const [bal, states, ledger, components] = await Promise.all([
      balanceOf(db, { solutionId }), materialStates(db, [solutionId]),
      db.select().from(reagentTransactions).where(eq(reagentTransactions.solutionId, solutionId)).orderBy(asc(reagentTransactions.seq)),
      db.select().from(preparedSolutionComponents).where(eq(preparedSolutionComponents.solutionId, solutionId)).orderBy(asc(preparedSolutionComponents.id)),
    ]);
    res.json({
      solution: solutionView(s, bal, states.get(solutionId)), ledger: ledger.map(txView),
      components: components.map(c => ({ ...c, materialId: c.lotId ?? c.parentSolutionId, quantity: Number(c.quantity) })),
    });
  });

  router.post('/prepared-solutions', requireAuth, validate(preparedSolutionSchema), async (req, res) => {
    const user = (req as any).user;
    const b = req.body as z.infer<typeof preparedSolutionSchema>;
    const created = await withTransaction(db, async (tx) => {
      const now = new Date();
      const today = utcToday(now);
      if (b.expiryDate < today) throw new ValidationError('The expiry date of the solution has passed.', [{ path: 'expiryDate', message: 'The expiry date has passed.' }]);
      // Lock the parents in id order (two preparations from the same lots cannot deadlock), then check each one may be used today.
      const ordered = [...b.components].sort((x, y) => (x.materialId < y.materialId ? -1 : 1));
      const holders = new Map<string, Holder>();
      for (const c of ordered) {
        const [lot] = await tx.select({ id: reagentLots.id }).from(reagentLots).where(eq(reagentLots.id, c.materialId)).for('update');
        if (lot) { holders.set(c.materialId, { lotId: c.materialId }); continue; }
        const [sol] = await tx.select({ id: preparedSolutions.id }).from(preparedSolutions).where(eq(preparedSolutions.id, c.materialId)).for('update');
        if (!sol) throw new NotFoundError(`Reagent lot or prepared solution ${c.materialId} was not found.`);
        holders.set(c.materialId, { solutionId: c.materialId });
      }
      const states = await assertUsable(tx, ordered.map(c => c.materialId), now, 'components');
      // A solution cannot outlive its parents: lot expiry, in-use expiry and retest date; a parent solution's expiry.
      for (const c of ordered) {
        const h = holders.get(c.materialId)!;
        let limit: string;
        if ('lotId' in h) {
          const [lot] = await tx.select().from(reagentLots).where(eq(reagentLots.id, h.lotId)).limit(1);
          limit = parentLimit({ kind: 'lot', lot });
        } else {
          const [sol] = await tx.select().from(preparedSolutions).where(eq(preparedSolutions.id, h.solutionId)).limit(1);
          limit = parentLimit({ kind: 'solution', solution: sol });
        }
        if (b.expiryDate > limit) {
          const message = `The solution cannot expire after its parent: ${states.get(c.materialId)!.label} may be used until ${limit}, the solution was given ${b.expiryDate}.`;
          throw new ValidationError(message, [{ path: 'expiryDate', message }]);
        }
      }

      const solutionId = `PS-${pad(await nextSequence(tx, 'prepared_solution'), 6)}`;
      const record = {
        id: solutionId, name: b.name, concentration: b.concentration ?? null, preparation: b.preparation, quantity: String(b.quantity), unit: b.unit,
        expiryDate: b.expiryDate, storageCondition: b.storageCondition ?? null, status: 'Active', preparedBy: user.id, preparedAt: now, version: 1,
      };
      const [row] = await tx.insert(preparedSolutions).values(record).returning();
      const { preparedAt: _p, version: _v, ...stated } = row;
      await writeAudit(tx, user.id, 'Create', 'PreparedSolution', solutionId, 'all', '', JSON.stringify({ ...stated, components: b.components }), `Solution ${b.name} prepared`);
      for (const c of ordered) {
        const h = holders.get(c.materialId)!;
        const state = states.get(c.materialId)!;
        const t = await appendTransaction(tx, {
          holder: h, type: 'Consumed', delta: -c.quantity, unit: state.unit, userId: user.id, label: state.label, intoSolutionId: solutionId,
          reason: `Used to prepare ${solutionId} (${b.name})`,
        });
        await tx.insert(preparedSolutionComponents).values({
          id: `PSC-${randomBytes(6).toString('hex')}`, solutionId, lotId: 'lotId' in h ? h.lotId : null, parentSolutionId: 'solutionId' in h ? h.solutionId : null,
          quantity: String(c.quantity), unit: state.unit, transactionId: t.id,
        });
        await closeIfEmpty(tx, h, t.balanceAfter, user.id, now);
      }
      await appendTransaction(tx, {
        holder: { solutionId }, type: 'Prepared', delta: b.quantity, unit: b.unit, userId: user.id, label: `Prepared solution ${solutionId} (${b.name})`,
        reason: `Prepared ${b.quantity} ${b.unit} of ${b.name}`,
      });
      return row;
    });
    res.json(solutionView(created, String(b.quantity), (await materialStates(db, [created.id])).get(created.id)));
  });

  router.post('/prepared-solutions/:id/discard', requireAuth, validate(reagentCloseSchema), async (req, res) => {
    const user = (req as any).user;
    const solutionId = String(req.params.id);
    const { expectedVersion: expected, reason: why } = req.body as { expectedVersion: number; reason: string };
    const row = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, preparedSolutions, solutionId);
      const label = `Prepared solution ${current.id} (${current.name})`;
      if (current.status !== 'Active') throw new AppError(423, 'RECORD_LOCKED', `${label} is ${current.status}: it can no longer be changed.`);
      if (current.version !== expected) throw new ConflictError();
      const left = await balanceOf(tx, { solutionId });
      if (Number(left) > 0) {
        await appendTransaction(tx, { holder: { solutionId }, type: 'Disposed', delta: -Number(left), unit: current.unit, userId: user.id, label, reason: why });
      }
      const updated = await updateVersioned(tx, preparedSolutions, solutionId, expected, { status: 'Discarded', closedBy: user.id, closedAt: new Date(), closeReason: why });
      await writeAudit(tx, user.id, 'Discard', 'PreparedSolution', solutionId, 'status', current.status, 'Discarded', why);
      return updated;
    });
    res.json(solutionView(row, '0', (await materialStates(db, [solutionId])).get(solutionId)));
  });

  router.get('/prepared-solutions/:id/traceback', requireAuth, async (req, res) => {
    const solutionId = String(req.params.id);
    const state = (await materialStates(db, [solutionId])).get(solutionId);
    if (!state) throw new NotFoundError(`Prepared solution ${solutionId} was not found.`);
    res.json({ material: state, ...(await traceback(db, { solutionId })) });
  });

  // -- for result entry --
  router.get('/reagent-materials', requireAuth, async (_req, res) => {
    // Open stock only, plus what blocks entry for a reason the analyst must see (quarantine, expired, past retest); a lot that is
    // used up, disposed of or rejected long ago is not offered at all.
    const lots = await db.select({ lot: reagentLots, item: reagentItems }).from(reagentLots).innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId))
      .where(notInArray(reagentLots.status, ['Consumed', 'Disposed', 'Rejected'])).orderBy(asc(reagentItems.name), asc(reagentLots.id)).limit(1000);
    const sols = await db.select().from(preparedSolutions).where(inArray(preparedSolutions.status, ['Active', 'Expired']))
      .orderBy(asc(preparedSolutions.name), asc(preparedSolutions.id)).limit(1000);
    const lotIds = lots.map(l => l.lot.id);
    const solIds = sols.map(s => s.id);
    const [states, lotBal, solBal] = await Promise.all([materialStates(db, [...lotIds, ...solIds]), balances(db, 'lot_id', lotIds), balances(db, 'solution_id', solIds)]);
    res.json([
      ...lotIds.map(i => ({ ...states.get(i)!, balance: Number(lotBal.get(i) ?? 0) })),
      ...solIds.map(i => ({ ...states.get(i)!, balance: Number(solBal.get(i) ?? 0) })),
    ]);
  });

  router.get('/samples/:id/materials', requireAuth, async (req, res) => {
    const sampleId = String(req.params.id);
    const links = await db.select().from(resultMaterials).where(eq(resultMaterials.sampleId, sampleId)).orderBy(asc(resultMaterials.linkedAt), asc(resultMaterials.id));
    const states = await materialStates(db, links.map(l => (l.lotId ?? l.solutionId)!));
    res.json(links.map(l => {
      const m = states.get((l.lotId ?? l.solutionId)!);
      return { ...l, materialId: l.lotId ?? l.solutionId, quantity: l.quantity === null ? null : Number(l.quantity), label: m?.label ?? null, useUntil: m?.useUntil ?? null, usable: m?.usable ?? false, blockedReason: m?.blockedReason ?? null };
    }));
  });

  router.post('/samples/:id/results/:resultId/materials', requireAuth, validate(resultMaterialLinkSchema), async (req, res) => {
    const user = (req as any).user;
    const sampleId = String(req.params.id);
    const resultId = String(req.params.resultId);
    const { materialId, quantity: amount } = req.body as z.infer<typeof resultMaterialLinkSchema>;
    const created = await withTransaction(db, async (tx) => {
      await sampleForEntry(tx, user, sampleId);
      const [result] = await tx.select().from(results).where(eq(results.id, resultId)).limit(1);
      if (!result || result.sampleId !== sampleId) throw new NotFoundError('Result not found.');
      const [already] = await tx.select({ id: resultMaterials.id }).from(resultMaterials)
        .where(and(eq(resultMaterials.resultId, resultId), isNull(resultMaterials.withdrawnAt),
          sql`coalesce(${resultMaterials.lotId}, ${resultMaterials.solutionId}) = ${materialId}`)).limit(1);
      if (already) throw new AppError(409, 'ALREADY_LINKED', `${materialId} is already recorded for ${result.parameter}.`);
      const links = await linkResultMaterials(tx, {
        sampleId, resultId, materialIds: [materialId], quantities: amount === undefined ? undefined : { [materialId]: amount },
        userId: user.id, resultVersion: result.version,
      });
      return links[0];
    });
    res.json({ ...created, materialId, quantity: created.quantity === null ? null : Number(created.quantity) });
  });

  router.post('/result-materials/:id/withdraw', requireAuth, validate(resultMaterialWithdrawSchema), async (req, res) => {
    const user = (req as any).user;
    const linkId = String(req.params.id);
    const { reason: why } = req.body as { reason: string };
    const updated = await withTransaction(db, async (tx) => {
      const [link] = await tx.select().from(resultMaterials).where(eq(resultMaterials.id, linkId)).limit(1);
      if (!link) throw new NotFoundError(`Material link ${linkId} was not found.`);
      await sampleForEntry(tx, user, link.sampleId);
      const [current] = await tx.select().from(resultMaterials).where(eq(resultMaterials.id, linkId)).for('update');
      if (current.withdrawnAt) throw new AppError(409, 'ALREADY_WITHDRAWN', `Material link ${linkId} was already withdrawn.`);
      // The one-time withdrawal (the row guard allows nothing else); `withdrawn_at IS NULL` is the concurrency predicate.
      const [row] = await tx.update(resultMaterials).set({ withdrawnBy: user.id, withdrawnAt: new Date(), withdrawReason: why })
        .where(and(eq(resultMaterials.id, linkId), isNull(resultMaterials.withdrawnAt))).returning();
      if (!row) throw new ConflictError();
      await writeAudit(tx, user.id, 'Withdraw', 'ResultMaterial', linkId, 'withdrawnAt', '', row.withdrawnAt!.toISOString(), why);
      return row;
    });
    res.json({ ...updated, materialId: updated.lotId ?? updated.solutionId });
  });

  return router;
};

