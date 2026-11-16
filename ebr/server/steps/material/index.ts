import { HttpError } from '../../core/errors.js';
import type { BatchHook, StepHandler } from '../../batch/steps.js';

type Lot = { id: string; material_code: string; lot_number: string; status: string; expiry_date: string; expired: boolean };

/**
 * The material (dispensing) step (E12). The operator scans or types the lot and enters the weight. The lot must be of the
 * material the recipe names, released by QA and not expired: otherwise the step is REFUSED (a wrong lot must not be used).
 * A weight outside the tolerance is accepted but raised as an exception, with a comment.
 */
export const handlers: StepHandler[] = [{
  type: 'material',
  record: async (input, def, ctx) => {
    if (def.type !== 'material') throw new Error('wrong handler');
    const extra = Object.keys(input).filter(k => k !== 'lot' && k !== 'weight');
    if (extra.length) throw new HttpError(400, 'unexpected_input', `Only "lot" and "weight" are accepted, not ${extra.join(', ')}.`);
    if (typeof input.lot !== 'string' || !input.lot.trim()) throw new HttpError(400, 'lot_required', `${def.label}: scan or type the lot number.`);
    if (typeof input.weight !== 'number' || !Number.isFinite(input.weight) || input.weight <= 0) throw new HttpError(400, 'weight_required', `${def.label}: the weight is required.`);
    const lots = (await ctx.c.query<Lot>(`SELECT id, material_code, lot_number, status, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, expiry_date < current_date AS expired
       FROM material_lots WHERE lower(lot_number) = lower($1)`, [input.lot.trim()])).rows;
    const lot = lots.find(l => l.material_code === def.material);
    if (!lot) throw new HttpError(409, lots.length ? 'wrong_material' : 'unknown_lot', lots.length ? `Lot ${input.lot} is ${lots.map(l => l.material_code).join(', ')}, not ${def.material} (${def.label}). Do not use it.` : `Lot ${input.lot} is not known.`);
    if (lot.status !== 'released') throw new HttpError(409, 'lot_not_released', `Lot ${lot.lot_number} is ${lot.status}: only a lot released by QA can be used.`);
    if (lot.expired) throw new HttpError(409, 'lot_expired', `Lot ${lot.lot_number} expired on ${lot.expiry_date}: it cannot be used.`);
    const weight = Math.round(input.weight * 1000) / 1000;
    const lo = def.quantity * (1 - def.tolerancePct / 100), hi = def.quantity * (1 + def.tolerancePct / 100);
    const exceptions = weight < lo || weight > hi
      ? [{ kind: 'out_of_tolerance', message: `${def.label}: ${weight} ${def.unit} is outside ${def.quantity} ${def.unit} ± ${def.tolerancePct}% (${+lo.toFixed(3)} to ${+hi.toFixed(3)})` }] : [];
    return { value: { material: def.material, lot: lot.lot_number, lotId: lot.id, weight, unit: def.unit, target: def.quantity, tolerancePct: def.tolerancePct, value: weight }, number: weight, exceptions };
  },
}];

/** E12#3: a batch that dispensed materials is closed only after its yield and reconciliation are recorded. */
export const onBatchComplete: BatchHook = async ({ c, batch }) => {
  const uses = (await c.query("SELECT 1 FROM batch_steps WHERE batch_id = $1 AND definition->>'type' = 'material'", [batch.id])).rowCount;
  if (!uses) return;
  const done = (await c.query('SELECT 1 FROM batch_reconciliations WHERE batch_id = $1', [batch.id])).rowCount;
  if (!done) throw new HttpError(409, 'reconciliation_required', 'Record the yield and the material reconciliation before closing the batch.');
};
