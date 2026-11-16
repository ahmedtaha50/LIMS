import { HttpError } from '../../core/errors.js';
import { evaluate, FormulaError, parseFormula } from '../../mbr/formula.js';
import type { Step } from '../../mbr/design.js';
import type { RaisedException, StepHandler } from '../../batch/steps.js';

const noInput = (input: Record<string, unknown>, what: string) => {
  if (Object.keys(input).length) throw new HttpError(400, 'unexpected_input', `${what} takes no value: ${Object.keys(input).join(', ')} is not accepted.`);
};
const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;
function limits(def: Extract<Step, { type: 'data' | 'calculation' }>, v: number): RaisedException[] {
  const out = (def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max);
  return out ? [{ kind: def.type === 'calculation' ? 'calculation_out_of_limits' : 'out_of_limits', message: `${def.label}: ${v}${def.unit ? ' ' + def.unit : ''} is outside ${def.min ?? '-∞'} to ${def.max ?? '∞'}${def.unit ? ' ' + def.unit : ''}` }] : [];
}

/** The step types every recipe uses: instructions, signatures, verified steps, recorded values and calculations. */
export const handlers: StepHandler[] = [
  { type: 'instruction', record: async (input) => { noInput(input, 'An instruction'); return { value: { done: true }, exceptions: [] }; } },
  { type: 'signature', record: async (input) => { noInput(input, 'A signature step'); return { value: { done: true }, exceptions: [] }; } },
  { type: 'verified', record: async (input) => { noInput(input, 'A verified step'); return { value: { done: true }, exceptions: [] }; } },
  {
    type: 'data',
    record: async (input, def) => {
      if (def.type !== 'data') throw new Error('wrong handler');
      const keys = Object.keys(input);
      if (keys.some(k => k !== 'value')) throw new HttpError(400, 'unexpected_input', `Only "value" is accepted, not ${keys.filter(k => k !== 'value').join(', ')}.`);
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) throw new HttpError(400, 'invalid_value', `${def.label}: a number is required.`);
      const v = round(input.value, def.decimals);
      return { value: { value: v, unit: def.unit }, number: v, exceptions: limits(def, v) };
    },
  },
  {
    // E11#3: a calculated value is computed here from the recorded values; a value sent by the client is refused
    type: 'calculation',
    record: async (input, def, ctx) => {
      if (def.type !== 'calculation') throw new Error('wrong handler');
      if (Object.keys(input).length) throw new HttpError(400, 'calculated_on_server', `${def.label} is calculated by the server; a value cannot be entered.`);
      const tree = parseFormula(def.formula);
      const scoped = new Map(ctx.numbers);
      for (const [k, v] of ctx.numbers) if (k.startsWith(ctx.phaseKey + '.')) scoped.set(k.slice(ctx.phaseKey.length + 1), v);
      let v: number;
      try { v = round(evaluate(tree, scoped), def.decimals); }
      catch (e) { if (e instanceof FormulaError) throw new HttpError(409, 'cannot_calculate', `${def.label} cannot be calculated: ${e.message}.`); throw e; }
      return { value: { value: v, unit: def.unit, formula: def.formula }, number: v, exceptions: limits(def, v) };
    },
  },
];
