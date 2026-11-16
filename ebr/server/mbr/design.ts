import { z } from 'zod';
import { FormulaError, parseFormula, refsOf } from './formula.js';

/**
 * A master batch record: phases of steps, in the order the batch runs them (E08#1). Every step has a key that is unique in
 * its phase; elsewhere a step is named `phase.step`. Validated when saved (E08#2): limits, units, the order of steps, and
 * every reference of a calculation.
 */
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'a key is lowercase letters, digits and _ (starting with a letter)');
const label = z.string().min(1).max(120);
const unit = z.string().min(1).max(20);
const base = { key, label, critical: z.boolean().default(false) };

export const Step = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('instruction'), text: z.string().min(1).max(4000) }),
  z.strictObject({ ...base, type: z.literal('data'), unit: z.string().max(20).default(''), min: z.number().optional(), max: z.number().optional(), decimals: z.number().int().min(0).max(6).default(2) }),
  z.strictObject({ ...base, type: z.literal('signature'), text: z.string().min(1).max(1000) }),
  z.strictObject({ ...base, type: z.literal('verified'), text: z.string().min(1).max(1000) }),
  z.strictObject({ ...base, type: z.literal('calculation'), formula: z.string().min(1).max(500), unit: z.string().max(20).default(''), min: z.number().optional(), max: z.number().optional(), decimals: z.number().int().min(0).max(6).default(2) }),
  z.strictObject({ ...base, type: z.literal('material'), material: z.string().min(1).max(60), quantity: z.number().positive(), unit, tolerancePct: z.number().min(0).max(50) }),
  z.strictObject({ ...base, type: z.literal('equipment'), objectKind: z.enum(['equipment', 'room']), objectCode: z.string().max(40).optional(), purpose: z.string().max(200).default('') }),
  z.strictObject({ ...base, type: z.literal('sample'), test: z.string().min(1).max(200), quantity: z.number().positive(), unit }),
]);
export type Step = z.infer<typeof Step>;
export const STEP_TYPES = ['instruction', 'data', 'signature', 'verified', 'calculation', 'material', 'equipment', 'sample'] as const;

export const Phase = z.strictObject({ key, label, steps: z.array(Step).min(1).max(200) });
export const Design = z.strictObject({
  batchSize: z.strictObject({ value: z.number().positive(), unit }),
  phases: z.array(Phase).min(1).max(50),
}).superRefine((d, ctx) => {
  const phases = new Set<string>(), numeric = new Set<string>();
  d.phases.forEach((ph, i) => {
    if (phases.has(ph.key)) ctx.addIssue({ code: 'custom', path: ['phases', i, 'key'], message: `two phases are called ${ph.key}` });
    phases.add(ph.key);
    const steps = new Set<string>();
    ph.steps.forEach((s, j) => {
      const at = ['phases', i, 'steps', j];
      const name = `${ph.key}.${s.key}`;
      if (steps.has(s.key)) ctx.addIssue({ code: 'custom', path: [...at, 'key'], message: `two steps of ${ph.key} are called ${s.key}` });
      steps.add(s.key);
      if ((s.type === 'data' || s.type === 'calculation') && s.min !== undefined && s.max !== undefined && s.min > s.max) ctx.addIssue({ code: 'custom', path: at, message: `${name}: the lower limit is above the upper limit` });
      if ((s.type === 'data' || s.type === 'calculation') && (s.min !== undefined || s.max !== undefined) && !s.unit) ctx.addIssue({ code: 'custom', path: [...at, 'unit'], message: `${name}: a value with limits needs a unit` });
      if (s.type === 'calculation') {
        try {
          // a calculation uses values recorded BEFORE it, in this order: the order of steps is part of the check
          for (const r of refsOf(parseFormula(s.formula))) {
            const full = r.includes('.') ? r : `${ph.key}.${r}`;
            if (!numeric.has(full)) ctx.addIssue({ code: 'custom', path: [...at, 'formula'], message: `${name}: the formula uses ${r}, which is not a data or calculation step before this one` });
          }
        } catch (e) {
          if (e instanceof FormulaError) ctx.addIssue({ code: 'custom', path: [...at, 'formula'], message: `${name}: ${e.message}` }); else throw e;
        }
      }
      if (s.type === 'data' || s.type === 'calculation') numeric.add(name);
    });
  });
});
export type Design = z.infer<typeof Design>;
