/**
 * Reagent lots and prepared solutions on results (roadmap M30). Owned by r2-reagents; the guard is registered in ./index.ts
 * (RESULT_GUARDS) and linkResultMaterials is called by saveResult for `lotIds` by the wave gate (docs/changes/r2-reagents.md).
 *
 * The rules of use, in one place (the routes, the result guard and the scheduled job all ask materialStates):
 *
 *   a lot is usable on a day      when it is InUse (released by a second person, then opened), the day is not after its expiry date
 *                                 nor after its in-use expiry (min(expiry, opening day + in-use shelf life)), and its retest date,
 *                                 if any, has not passed. Dates are valid through the end of that day (UTC), like calibration dates.
 *   a solution is usable on a day when it is Active, the day is not after its expiry date (which is never after any parent's), and
 *                                 nothing it was made from, at any depth, has been Rejected.
 *
 *   reagent-lots (result guard)   a result is saved only while every material linked to it (result_materials, not withdrawn) is
 *                                 usable: 400 naming the lot or solution and the date that blocks it. A lot rejected after it was
 *                                 linked therefore blocks the result as well.
 *   linkResultMaterials           records the materials a result was measured with, in the caller's transaction: each one must be
 *                                 usable now (400 naming it otherwise), one link per material and result, an audit entry per link, and
 *                                 an optional consumption row of the ledger (Used, with the result).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { results } from '../../../db/schema';
import { preparedSolutions, reagentItems, reagentLots, reagentTransactions, resultMaterials, type PreparedSolution, type ReagentLot } from '../../../db/schema/reagents';
import { writeAudit } from '../../../db/utils';
import { utcToday } from '../../../lib/validations/instruments';
import { lockRow, nextSequence, updateVersioned, type Executor, type Tx } from '../../core/tx';
import { BadRequestError, NotFoundError } from '../../http/errors';
import type { ResultGuard } from './index';
import { randomBytes } from 'crypto';

const DAY_MS = 86_400_000;

/** `day` + n calendar days, YYYY-MM-DD (UTC arithmetic, so no daylight-saving shift). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The in-use expiry a lot gets when it is opened on `openedDay`: never later than its expiry date. */
export function inUseExpiryOf(expiryDate: string, openedDay: string, shelfLifeDays: number | null | undefined): string {
  if (!shelfLifeDays) return expiryDate;
  const byShelfLife = addDays(openedDay, shelfLifeDays);
  return byShelfLife < expiryDate ? byShelfLife : expiryDate;
}

/** The last day a lot may be used, by its dates alone: min(expiry, in-use expiry). */
export const lotUseLimit = (lot: Pick<ReagentLot, 'expiryDate' | 'inUseExpiry'>): string =>
  lot.inUseExpiry && lot.inUseExpiry < lot.expiryDate ? lot.inUseExpiry : lot.expiryDate;

/** The last day a solution may be prepared to expire on, from one parent: a lot's use limit or a solution's expiry. */
export const parentLimit = (p: { kind: 'lot'; lot: Pick<ReagentLot, 'expiryDate' | 'inUseExpiry' | 'retestDate'> } | { kind: 'solution'; solution: Pick<PreparedSolution, 'expiryDate'> }): string => {
  if (p.kind === 'solution') return p.solution.expiryDate;
  const limit = lotUseLimit(p.lot);
  return p.lot.retestDate && p.lot.retestDate < limit ? p.lot.retestDate : limit;
};

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export interface MaterialState {
  id: string;
  kind: 'lot' | 'solution';
  /** "reagent lot RL-000001 (Methanol HPLC, supplier lot M-123)" or "prepared solution PS-000001 (0.1 M HCl)". */
  label: string;
  name: string;
  lotNumber: string | null;
  status: string;
  unit: string;
  /** The last day it may be used by its dates (lot: min(expiry, in-use expiry); solution: expiry). */
  useUntil: string;
  retestDate: string | null;
  usable: boolean;
  /** Why it may not be used, naming it and the date; null when usable. */
  blockedReason: string | null;
}

/** Why a lot may not be used on `today`, or null. Pure: the state of the lot row only. */
export function lotBlockedReason(lot: ReagentLot, label: string, today: string): string | null {
  const limit = lotUseLimit(lot);
  switch (lot.status) {
    case 'Quarantine': return `${label} is in Quarantine (received ${day(lot.receivedAt)}): it has not been released for use.`;
    case 'Rejected': return `${label} was Rejected on ${day(lot.closedAt)}: it must not be used.`;
    case 'Consumed': return `${label} was used up on ${day(lot.closedAt)}.`;
    case 'Disposed': return `${label} was disposed of on ${day(lot.closedAt)}.`;
    case 'Expired': return `${label} expired on ${limit}${limit !== lot.expiryDate ? ' (in-use expiry)' : ''}.`;
    case 'Approved': return `${label} has not been opened (released ${day(lot.releasedAt)}): open the lot before it is used.`;
  }
  if (today > lot.expiryDate) return `${label} expired on ${lot.expiryDate}.`;
  if (lot.inUseExpiry && today > lot.inUseExpiry) return `${label} passed its in-use expiry on ${lot.inUseExpiry} (opened ${day(lot.openedAt)}).`;
  if (lot.retestDate && today > lot.retestDate) return `${label} is past its retest date ${lot.retestDate}: it must be retested before use.`;
  return null;
}

export function solutionBlockedReason(s: PreparedSolution, label: string, today: string): string | null {
  switch (s.status) {
    case 'Discarded': return `${label} was discarded on ${day(s.closedAt)}.`;
    case 'Consumed': return `${label} was used up on ${day(s.closedAt)}.`;
    case 'Expired': return `${label} expired on ${s.expiryDate}.`;
  }
  if (today > s.expiryDate) return `${label} expired on ${s.expiryDate}.`;
  return null;
}

const lotLabel = (lot: ReagentLot, itemName: string) => `Reagent lot ${lot.id} (${itemName}, supplier lot ${lot.lotNumber})`;
const solutionLabel = (s: PreparedSolution) => `Prepared solution ${s.id} (${s.name})`;

/**
 * The state of each lot or solution id on `now` (ids that exist; an unknown id is simply absent from the map). A solution made, at any
 * depth, from a lot that has since been Rejected is not usable either.
 */
export async function materialStates(ex: Executor, ids: readonly string[], now = new Date()): Promise<Map<string, MaterialState>> {
  const out = new Map<string, MaterialState>();
  if (ids.length === 0) return out;
  const today = utcToday(now);
  const unique = [...new Set(ids)];

  const lots = await ex.select({ lot: reagentLots, itemName: reagentItems.name }).from(reagentLots)
    .innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId)).where(inArray(reagentLots.id, unique));
  for (const { lot, itemName } of lots) {
    const label = lotLabel(lot, itemName);
    const blockedReason = lotBlockedReason(lot, label, today);
    out.set(lot.id, {
      id: lot.id, kind: 'lot', label, name: itemName, lotNumber: lot.lotNumber, status: lot.status, unit: lot.unit,
      useUntil: lotUseLimit(lot), retestDate: lot.retestDate, usable: blockedReason === null, blockedReason,
    });
  }

  const solutions = await ex.select().from(preparedSolutions).where(inArray(preparedSolutions.id, unique));
  if (solutions.length) {
    // Every lot a solution was made from, at any depth, that is Rejected: the first one found blocks the solution.
    const rejected = await ex.execute(sql`
      WITH RECURSIVE tree(root, solution_id) AS (
        SELECT s.id, s.id FROM prepared_solutions s WHERE s.id IN (${sql.join(solutions.map(s => sql`${s.id}`), sql`, `)})
        UNION
        SELECT tree.root, c.parent_solution_id FROM tree JOIN prepared_solution_components c ON c.solution_id = tree.solution_id
         WHERE c.parent_solution_id IS NOT NULL
      )
      SELECT DISTINCT ON (tree.root) tree.root, l.id AS lot_id, l.closed_at
        FROM tree JOIN prepared_solution_components c ON c.solution_id = tree.solution_id JOIN reagent_lots l ON l.id = c.lot_id
       WHERE l.status = 'Rejected'
       ORDER BY tree.root, l.id`);
    const rejectedParent = new Map<string, { lotId: string; closedAt: string | Date | null }>(
      (rejected as any).rows.map((r: any) => [r.root, { lotId: r.lot_id, closedAt: r.closed_at }]));
    for (const s of solutions) {
      const label = solutionLabel(s);
      const parent = rejectedParent.get(s.id);
      const blockedReason = solutionBlockedReason(s, label, today)
        ?? (parent ? `${label} is made from reagent lot ${parent.lotId}, which was Rejected on ${day(parent.closedAt)}.` : null);
      out.set(s.id, {
        id: s.id, kind: 'solution', label, name: s.name, lotNumber: null, status: s.status, unit: s.unit,
        useUntil: s.expiryDate, retestDate: null, usable: blockedReason === null, blockedReason,
      });
    }
  }
  return out;
}

/** Throws 400 naming the first id that is unknown or not usable now (with every blocked material in `details`). */
export async function assertUsable(ex: Executor, ids: readonly string[], now = new Date(), path = 'lotIds'): Promise<Map<string, MaterialState>> {
  const states = await materialStates(ex, ids, now);
  const unknown = ids.find(id => !states.has(id));
  if (unknown) throw new NotFoundError(`Reagent lot or prepared solution ${unknown} was not found.`);
  const blocked = [...states.values()].filter(s => !s.usable);
  if (blocked.length) {
    throw new BadRequestError(blocked.map(b => b.blockedReason).join(' '), blocked.map(b => ({ path, id: b.id, message: b.blockedReason! })));
  }
  return states;
}

// ---- the ledger --------------------------------------------------------------------------------------------------------------

export type Holder = { lotId: string } | { solutionId: string };

/** The current balance of a lot or solution (numeric text), from its last ledger row; '0' when it has none. */
export async function balanceOf(ex: Executor, holder: Holder): Promise<string> {
  const where = 'lotId' in holder ? eq(reagentTransactions.lotId, holder.lotId) : eq(reagentTransactions.solutionId, holder.solutionId);
  const [row] = await ex.select({ b: reagentTransactions.balanceAfter }).from(reagentTransactions).where(where)
    .orderBy(sql`${reagentTransactions.seq} DESC`).limit(1);
  return row?.b ?? '0';
}

const num = (v: string | number) => Number(v);
/** A quantity as numeric text with at most 4 decimals (the ledger's scale). */
export const qty = (v: number) => String(Math.round(v * 10_000) / 10_000);

export interface AppendInput {
  holder: Holder;
  type: 'Receipt' | 'Prepared' | 'Consumed' | 'Used' | 'Disposed';
  /** Positive for Receipt and Prepared, negative otherwise (numeric text or a number). */
  delta: number;
  unit: string;
  reason: string;
  userId: string;
  label: string;
  resultId?: string | null;
  intoSolutionId?: string | null;
}

/**
 * Appends one ledger row and its audit entry. The caller holds the lot or solution row lock, so the balance cannot move meanwhile;
 * the counter (reagent_tx) serialises every writer of the ledger. A quantity larger than the balance is 400 with the balance, before
 * anything is written; the CHECK and the balance trigger refuse it anyway.
 */
export async function appendTransaction(tx: Tx, a: AppendInput) {
  const previous = await balanceOf(tx, a.holder);
  const [{ next, negative }] = (await tx.execute(sql`SELECT (${previous}::numeric + ${qty(a.delta)}::numeric)::text AS next,
      (${previous}::numeric + ${qty(a.delta)}::numeric) < 0 AS negative`) as any).rows;
  if (negative) {
    throw new BadRequestError(`${a.label} has ${num(previous)} ${a.unit} left: ${num(qty(-a.delta))} ${a.unit} cannot be taken from it.`,
      [{ path: 'quantity', message: `Only ${num(previous)} ${a.unit} left.` }]);
  }
  const seq = await nextSequence(tx, 'reagent_tx');
  const row = {
    id: `RTX-${String(seq).padStart(9, '0')}`, seq,
    lotId: 'lotId' in a.holder ? a.holder.lotId : null, solutionId: 'solutionId' in a.holder ? a.holder.solutionId : null,
    txType: a.type, qtyDelta: qty(a.delta), balanceAfter: next as string, unit: a.unit,
    resultId: a.resultId ?? null, intoSolutionId: a.intoSolutionId ?? null, reason: a.reason, performedBy: a.userId,
  };
  const [inserted] = await tx.insert(reagentTransactions).values(row).returning();
  const { performedAt: _p, ...stated } = inserted;
  await writeAudit(tx, a.userId, 'Create', 'ReagentTransaction', inserted.id, 'all', '', JSON.stringify(stated), a.reason);
  return inserted;
}

/** After a take from a lot or solution: a balance of 0 closes it (Consumed), with its audit entry. */
export async function closeIfEmpty(tx: Tx, holder: Holder, balanceAfter: string, userId: string, now = new Date()) {
  if (num(balanceAfter) !== 0) return;
  if ('lotId' in holder) {
    const lot = await lockRow(tx, reagentLots, holder.lotId);
    if (lot.status !== 'InUse') return;
    await updateVersioned(tx, reagentLots, lot.id, lot.version, { status: 'Consumed', closedBy: userId, closedAt: now, closeReason: 'Balance reached 0' });
    await writeAudit(tx, userId, 'StatusChange', 'ReagentLot', lot.id, 'status', lot.status, 'Consumed', 'The balance of the lot reached 0 (used up)');
  } else {
    const s = await lockRow(tx, preparedSolutions, holder.solutionId);
    if (s.status !== 'Active') return;
    await updateVersioned(tx, preparedSolutions, s.id, s.version, { status: 'Consumed', closedBy: userId, closedAt: now, closeReason: 'Balance reached 0' });
    await writeAudit(tx, userId, 'StatusChange', 'PreparedSolution', s.id, 'status', s.status, 'Consumed', 'The balance of the solution reached 0 (used up)');
  }
}

/** Locks the lot or solution row of an id (lots are RL-, solutions PS-); 404 when it is neither. */
export async function lockMaterial(tx: Tx, id: string): Promise<Holder> {
  const [lot] = await tx.select({ id: reagentLots.id }).from(reagentLots).where(eq(reagentLots.id, id)).for('update');
  if (lot) return { lotId: id };
  const [s] = await tx.select({ id: preparedSolutions.id }).from(preparedSolutions).where(eq(preparedSolutions.id, id)).for('update');
  if (s) return { solutionId: id };
  throw new NotFoundError(`Reagent lot or prepared solution ${id} was not found.`);
}

// ---- the usage-to-result link ------------------------------------------------------------------------------------------------

export interface LinkInput {
  sampleId: string;
  resultId: string;
  /** Lot (RL-) or prepared solution (PS-) ids. */
  materialIds: readonly string[];
  /** Quantity used per material id, in its unit (optional): written to the ledger as Used, with the result. */
  quantities?: Readonly<Record<string, number>>;
  userId: string;
  /** The result version the link belongs to (the version the save produced, or the current one). */
  resultVersion: number;
  now?: Date;
}

/**
 * Links materials to a result inside the caller's transaction. Each material is locked, then must be usable now (400 naming it and
 * the blocking date otherwise; nothing is written). A material already linked to the result (and not withdrawn) is not linked twice.
 */
export async function linkResultMaterials(tx: Tx, input: LinkInput) {
  const now = input.now ?? new Date();
  const ids = [...new Set(input.materialIds)].sort();
  const holders = new Map<string, Holder>();
  for (const id of ids) holders.set(id, await lockMaterial(tx, id)); // in id order: two savers cannot deadlock on the same lots
  const states = await assertUsable(tx, ids, now);

  const existing = await tx.select({ lotId: resultMaterials.lotId, solutionId: resultMaterials.solutionId }).from(resultMaterials)
    .where(and(eq(resultMaterials.resultId, input.resultId), isNull(resultMaterials.withdrawnAt)));
  const linked = new Set(existing.map(e => e.lotId ?? e.solutionId));
  const [result] = await tx.select({ parameter: results.parameter }).from(results).where(eq(results.id, input.resultId)).limit(1);

  const created: Array<typeof resultMaterials.$inferSelect> = [];
  for (const id of ids) {
    if (linked.has(id)) continue;
    const holder = holders.get(id)!;
    const state = states.get(id)!;
    const quantity = input.quantities?.[id];
    let transactionId: string | null = null;
    if (quantity !== undefined) {
      const t = await appendTransaction(tx, {
        holder, type: 'Used', delta: -quantity, unit: state.unit, userId: input.userId, label: state.label, resultId: input.resultId,
        reason: `Used for ${result?.parameter ?? 'result'} of sample ${input.sampleId} (result ${input.resultId})`,
      });
      transactionId = t.id;
      await closeIfEmpty(tx, holder, t.balanceAfter, input.userId, now);
    }
    const row = {
      id: `RM-${randomBytes(6).toString('hex')}`, resultId: input.resultId, sampleId: input.sampleId,
      lotId: 'lotId' in holder ? holder.lotId : null, solutionId: 'solutionId' in holder ? holder.solutionId : null,
      quantity: quantity === undefined ? null : qty(quantity), transactionId, resultVersion: input.resultVersion, linkedBy: input.userId, linkedAt: now,
    };
    const [inserted] = await tx.insert(resultMaterials).values(row).returning();
    await writeAudit(tx, input.userId, 'Create', 'ResultMaterial', inserted.id, 'all', '',
      JSON.stringify({ resultId: row.resultId, sampleId: row.sampleId, materialId: id, quantity: row.quantity, unit: quantity === undefined ? null : state.unit, transactionId, resultVersion: row.resultVersion }),
      `${state.label} recorded as used for ${result?.parameter ?? 'result'} of sample ${input.sampleId}`);
    created.push(inserted);
  }
  return created;
}

/** Ids of the materials linked to a result and not withdrawn. */
export async function linkedMaterialIds(ex: Executor, resultId: string): Promise<string[]> {
  const rows = await ex.select({ lotId: resultMaterials.lotId, solutionId: resultMaterials.solutionId }).from(resultMaterials)
    .where(and(eq(resultMaterials.resultId, resultId), isNull(resultMaterials.withdrawnAt)));
  return rows.map(r => (r.lotId ?? r.solutionId)!);
}

/** Result guard reagent-lots: every material linked to the result must be usable when the result is saved. */
export const reagentLotsUsable: ResultGuard = {
  name: 'reagent-lots',
  async check(ex, { resultId, now }) {
    const ids = await linkedMaterialIds(ex, resultId);
    if (ids.length === 0) return null;
    const blocked = [...(await materialStates(ex, ids, now)).values()].filter(s => !s.usable);
    return blocked.length ? `${blocked.map(b => b.blockedReason).join(' ')} The result cannot be saved with it.` : null;
  },
};
