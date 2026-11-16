import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { sign, type PasswordCheck } from '../esign/index.js';

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };
const signer = (a: Ctx['actor']) => ({ userId: a.userId, username: a.username, displayName: a.displayName ?? a.username });
const audit = (x: Ctx, action: string, entity: string, id: string, v: { oldValue?: unknown; newValue?: unknown; reason?: string | null } = {}) =>
  writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action, entity, entityId: id, requestId: x.requestId, ...v });
/** Yield limits of the site until they are set per product (an open decision): percent of the theoretical batch size. */
export const yieldLimits = () => ({ min: Number(process.env.EBR_YIELD_MIN_PCT ?? 95), max: Number(process.env.EBR_YIELD_MAX_PCT ?? 102) });

type LotRow = { id: string; material_code: string; lot_number: string; status: string; expiry_date: string; created_by: string; decided_by: string | null; version: number };
const lotView = (l: LotRow) => ({ id: l.id, material: l.material_code, lotNumber: l.lot_number, status: l.status, expiry: l.expiry_date, createdBy: l.created_by, decidedBy: l.decided_by, version: l.version });
const LOT = "SELECT id, material_code, lot_number, status, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, created_by, decided_by, version FROM material_lots";

export async function listMaterials(pool: Pool) {
  const m = (await pool.query<{ code: string; name: string; unit: string }>('SELECT code, name, unit FROM materials ORDER BY code')).rows;
  const lots = (await pool.query<LotRow>(`${LOT} ORDER BY material_code, lot_number`)).rows;
  return m.map(x => ({ ...x, lots: lots.filter(l => l.material_code === x.code).map(lotView) }));
}
export async function createMaterial(x: Ctx, input: { code: string; name: string; unit: string }) {
  const r = await x.c.query('INSERT INTO materials (code, name, unit) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [input.code, input.name, input.unit]);
  if (!r.rowCount) throw new HttpError(409, 'code_taken', `Material ${input.code} exists.`);
  await audit(x, 'material.created', 'material', input.code, { newValue: input });
  return input;
}
export async function receiveLot(x: Ctx, code: string, input: { lotNumber: string; expiry: string }) {
  if (!(await x.c.query('SELECT 1 FROM materials WHERE code = $1', [code])).rowCount) throw notFound(`No material ${code}.`);
  const r = await x.c.query<{ id: string }>('INSERT INTO material_lots (material_code, lot_number, expiry_date, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id', [code, input.lotNumber, input.expiry, x.actor.username]);
  if (!r.rows[0]) throw new HttpError(409, 'lot_exists', `Lot ${input.lotNumber} of ${code} exists.`);
  await audit(x, 'material_lot.received', 'material_lot', r.rows[0].id, { newValue: { material: code, ...input, status: 'quarantine' } });
  return lotView((await x.c.query<LotRow>(`${LOT} WHERE id = $1`, [r.rows[0].id])).rows[0]!);
}
/** QA decides a lot: released (usable) or rejected, with a signature. */
export async function decideLot(x: Ctx, id: string, decision: 'released' | 'rejected', input: { version: number; password: string; reason?: string | undefined }) {
  const l = (await x.c.query<LotRow>(`${LOT} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!l) throw notFound('No such lot.');
  if (l.version !== input.version) throw conflict();
  if (l.status !== 'quarantine') throw new HttpError(409, 'lot_decided', `Lot ${l.lot_number} is already ${l.status}.`);
  if (decision === 'rejected' && !input.reason) throw new HttpError(400, 'reason_required', 'A rejection needs a reason.');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: decision === 'released' ? 'released' : 'rejected', entity: 'material_lot', entityId: id, recordVersion: l.version, record: lotView(l), comment: input.reason ?? null, requestId: x.requestId });
  await x.c.query('UPDATE material_lots SET status = $2, decided_by = $3, decided_at = now(), version = version + 1 WHERE id = $1', [id, decision, x.actor.username]);
  await audit(x, `material_lot.${decision}`, 'material_lot', id, { oldValue: { status: 'quarantine' }, newValue: { status: decision }, reason: input.reason ?? null });
  return lotView((await x.c.query<LotRow>(`${LOT} WHERE id = $1`, [id])).rows[0]!);
}

/**
 * E12#3: yield (output against the theoretical batch size) and material reconciliation (dispensed against the recipe's
 * targets), once per batch, signed; every difference beyond its limit becomes an exception of the batch.
 */
export async function reconcile(x: Ctx, batchId: string, input: { outputQuantity: number; password: string }) {
  const b = (await x.c.query<{ id: string; batch_number: string; status: string; batch_size: { value: number; unit: string } }>('SELECT id, batch_number, status, batch_size FROM batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
  if (!b) throw notFound('No such batch.');
  if (b.status !== 'in_progress') throw new HttpError(409, 'batch_state', `Batch ${b.batch_number} is ${b.status}: the reconciliation is made while it is in progress.`);
  if ((await x.c.query("SELECT 1 FROM batch_steps WHERE batch_id = $1 AND state <> 'done'", [batchId])).rowCount) throw new HttpError(409, 'steps_missing', 'Every step must be recorded before the reconciliation.');
  if ((await x.c.query('SELECT 1 FROM batch_reconciliations WHERE batch_id = $1', [batchId])).rowCount) throw new HttpError(409, 'already_reconciled', 'This batch is already reconciled.');
  const steps = (await x.c.query<{ definition: { label: string; material: string; quantity: number; unit: string; tolerancePct: number }; value: { weight: number } }>(
    "SELECT definition, value FROM batch_steps WHERE batch_id = $1 AND definition->>'type' = 'material' ORDER BY seq", [batchId])).rows;
  const byMaterial = new Map<string, { material: string; unit: string; target: number; dispensed: number; tolerancePct: number }>();
  for (const s of steps) {
    const m = byMaterial.get(s.definition.material) ?? { material: s.definition.material, unit: s.definition.unit, target: 0, dispensed: 0, tolerancePct: s.definition.tolerancePct };
    m.target += s.definition.quantity; m.dispensed += s.value.weight; m.tolerancePct = Math.min(m.tolerancePct, s.definition.tolerancePct);
    byMaterial.set(m.material, m);
  }
  const materials = [...byMaterial.values()].map(m => ({ ...m, target: +m.target.toFixed(3), dispensed: +m.dispensed.toFixed(3), differencePct: +((100 * (m.dispensed - m.target)) / m.target).toFixed(2) }));
  const yieldPct = +((100 * input.outputQuantity) / b.batch_size.value).toFixed(2);
  const lim = yieldLimits();
  const exceptions = [
    ...(yieldPct < lim.min || yieldPct > lim.max ? [{ kind: 'yield_out_of_limits', message: `Yield ${yieldPct}% (${input.outputQuantity} of ${b.batch_size.value} ${b.batch_size.unit}) is outside ${lim.min}% to ${lim.max}%` }] : []),
    ...materials.filter(m => Math.abs(m.differencePct) > m.tolerancePct).map(m => ({ kind: 'reconciliation_difference', message: `Material ${m.material}: ${m.dispensed} ${m.unit} dispensed against ${m.target} ${m.unit} (${m.differencePct}%, limit ±${m.tolerancePct}%)` })),
  ];
  const record = { batchId, outputQuantity: input.outputQuantity, unit: b.batch_size.unit, theoretical: b.batch_size.value, yieldPct, materials };
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'performed', entity: 'batch_reconciliation', entityId: batchId, recordVersion: 1, record, requestId: x.requestId });
  await x.c.query('INSERT INTO batch_reconciliations (batch_id, output_quantity, unit, theoretical, yield_pct, materials, recorded_by, recorded_at, signature_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [batchId, input.outputQuantity, b.batch_size.unit, b.batch_size.value, yieldPct, JSON.stringify(materials), x.actor.username, sig.signedAt, sig.id]);
  for (const e of exceptions) await x.c.query("INSERT INTO batch_exceptions (batch_id, step_id, kind, message, comment, raised_by) VALUES ($1, NULL, $2, $3, 'raised by the reconciliation', $4)", [batchId, e.kind, e.message, x.actor.username]);
  await audit(x, 'batch.reconciled', 'batch', batchId, { newValue: { ...record, exceptions } });
  return { ...record, exceptions };
}
