// Domain: methods, calculation formulas, test plans, calculated results and system suitability (roadmap M18). Owned by
// r2-methods-calc. Shared by the server and the screens, so it imports nothing but zod, constants and the specification module.
//
// Every request schema is strict and carries no server-controlled field: id, revision, status, version, author, approver and
// dates are the server's. A Method, a CalcFormula and a TestPlan are Draft until an independent person signs them Effective; an
// Effective one is never edited (a new revision is drafted from it, and approving that revision supersedes it).
import { z } from 'zod';
import { RESULT_CHANGE_CODES } from '../../server/services/result-hooks/codes';
import { signatureFields } from './signatures';
import { decimalPlaces, isEffectiveDate, MAX_DECIMALS, MAX_PARAMETERS, parameterKey, specParameterSchema, type SpecParameter } from './specifications';

export const CONFIG_STATUSES = ['Draft', 'Effective', 'Superseded'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

// ---- the formula language: the allow-list (the engine is src/server/lib/calc.ts) ------------------------------------------------

export interface FormulaFunction { name: string; minArgs: number; maxArgs: number; aggregate: boolean; description: string }

export const FORMULA_FUNCTIONS: readonly FormulaFunction[] = [
  { name: 'mean', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'arithmetic mean of the values and replicates given' },
  { name: 'sd', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'sample standard deviation (n - 1), at least two values' },
  { name: 'rsd', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'relative standard deviation, 100 * sd / |mean|, in %' },
  { name: 'sum', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'sum of the values' },
  { name: 'count', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'number of values' },
  { name: 'min', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'smallest value' },
  { name: 'max', minArgs: 1, maxArgs: Infinity, aggregate: true, description: 'largest value' },
  { name: 'abs', minArgs: 1, maxArgs: 1, aggregate: false, description: 'absolute value' },
  { name: 'sqrt', minArgs: 1, maxArgs: 1, aggregate: false, description: 'square root (of a number that is not negative)' },
  { name: 'pow', minArgs: 2, maxArgs: 2, aggregate: false, description: 'pow(a, b) is a to the power b (also written a ^ b)' },
  { name: 'exp', minArgs: 1, maxArgs: 1, aggregate: false, description: 'e to the power of the value' },
  { name: 'ln', minArgs: 1, maxArgs: 1, aggregate: false, description: 'natural logarithm (of a positive number)' },
  { name: 'log10', minArgs: 1, maxArgs: 1, aggregate: false, description: 'base-10 logarithm (of a positive number)' },
  { name: 'if', minArgs: 3, maxArgs: 3, aggregate: false, description: 'if(condition, then, else): only the branch taken is calculated' },
];

const RESERVED = new Set<string>([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'constructor', '__proto__']);
/** Names a formula may never use: the object machinery of JavaScript, and anything starting with two underscores. */
export const isReservedName = (name: string): boolean => name.startsWith('__') || RESERVED.has(name);

const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FUNCTION_NAMES = new Set(FORMULA_FUNCTIONS.map(f => f.name));
export const inputNameSchema = z.string('An input name is required.').regex(INPUT_NAME, 'An input name starts with a letter and holds only letters, digits and _ (40 characters at most).')
  .refine(n => !isReservedName(n), 'This name is reserved and cannot be used for an input.')
  .refine(n => !FUNCTION_NAMES.has(n), 'This is the name of a function and cannot be used for an input.');

/** Codes of methods, formulas and test plans: what specifications and sst criteria refer to. */
export const codeSchema = z.string('A code is required.').trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/, 'A code holds letters, digits, ".", "_" and "-" (60 characters at most) and starts with a letter or digit.');

const text = (max: number, what: string) => z.string(`${what} must be text.`).trim().min(1, `${what} is required.`).max(max, `${what} is too long (${max} characters at most).`);
const optionalText = (max: number, what: string) => z.string(`${what} must be text.`).trim().max(max, `${what} is too long (${max} characters at most).`).nullish().transform(v => (v ? v : null));
/** For an edit: absent stays absent (nothing to change), '' or null clears the field. */
const editableText = (max: number, what: string) => z.string(`${what} must be text.`).trim().max(max, `${what} is too long (${max} characters at most).`).nullish()
  .transform(v => (v === undefined ? undefined : v ? v : null));
const expectedVersion = z.number('expectedVersion must be a number.').int().min(1, 'expectedVersion must be a positive whole number.');
const finiteNumber = z.number('A value must be a number.').refine(Number.isFinite, 'A value must be a finite number.');

/** The values of a formula's inputs: a number, or a list of replicate numbers. */
export const inputValuesSchema = z.record(inputNameSchema, z.union([finiteNumber, z.array(finiteNumber).max(1000, 'At most 1000 replicates.')]));

// ---- methods -------------------------------------------------------------------------------------------------------------------

const NUMERIC_KINDS = ['RANGE', 'NMT', 'NLT'] as const;

/** One system suitability criterion of a method: a formula over the injections of the run and the limit it must meet. */
export const sstCriterionSchema = z.object({
  name: text(200, 'The criterion name'),
  formulaCode: codeSchema,
  limit_kind: z.enum(NUMERIC_KINDS, { error: 'A system suitability limit is RANGE, NMT or NLT.' }),
  lower: finiteNumber.nullish().transform(v => v ?? null),
  upper: finiteNumber.nullish().transform(v => v ?? null),
  decimals: z.number('Decimals must be a whole number.').int().min(0).max(MAX_DECIMALS),
  replicates: z.number('Replicates must be a whole number.').int().min(1, 'At least one replicate.').max(100).nullish().transform(v => v ?? null),
}).strict().superRefine((c, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message: `${c.name}: ${message}` });
  const needsLower = c.limit_kind !== 'NMT';
  const needsUpper = c.limit_kind !== 'NLT';
  if (needsLower !== (c.lower !== null)) issue('lower', needsLower ? 'the lower limit is required.' : 'an NMT limit has no lower limit.');
  if (needsUpper !== (c.upper !== null)) issue('upper', needsUpper ? 'the upper limit is required.' : 'an NLT limit has no upper limit.');
  if (c.lower !== null && c.upper !== null && c.lower > c.upper) issue('lower', 'the lower limit is above the upper limit.');
  for (const l of [c.lower, c.upper]) if (l !== null && decimalPlaces(l) > c.decimals) issue('decimals', `the limit ${l} has more decimals than the ${c.decimals} declared.`);
});
export type SstCriterion = z.infer<typeof sstCriterionSchema>;

const sstCriteria = z.array(sstCriterionSchema).max(20, 'At most 20 system suitability criteria.').superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((c, i) => {
    if (seen.has(parameterKey(c.name))) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate criterion: ${c.name}.` });
    seen.add(parameterKey(c.name));
  });
});

const methodFields = {
  title: text(200, 'The title'),
  description: optionalText(4000, 'The description'),
  instrumentType: optionalText(100, 'The instrument type'),
  requiredTrainingModule: optionalText(200, 'The training module'),
  sstCriteria: sstCriteria.optional(),
};

/** POST /methods: revision 1 of a new method, a Draft. */
export const methodCreateSchema = z.object({ code: codeSchema, ...methodFields }).strict();

/** PUT /methods/:id: a Draft only, against the version the editor saw. */
export const methodUpdateSchema = z.object({
  title: methodFields.title.optional(),
  description: editableText(4000, 'The description'),
  instrumentType: editableText(100, 'The instrument type'),
  requiredTrainingModule: editableText(200, 'The training module'),
  sstCriteria: methodFields.sstCriteria,
  expectedVersion,
}).strict().refine(v => Object.keys(v).some(k => k !== 'expectedVersion'), { message: 'There is nothing to change.' });

/** POST /methods/:id/revise, /calc/formulas/:id/revise, /test-plans/:id/revise: the next revision, cloned from an Effective one. */
export const reviseSchema = z.object({}).strict();

const { meaningCode: _meaningCode, ...credentialFields } = signatureFields;
/** POST .../approve: the e-signature on the version the approver saw. The meaning is the server's (one per record type). */
export const configApproveSchema = z.object({ ...credentialFields, expectedVersion }).strict();

// ---- calculation formulas ------------------------------------------------------------------------------------------------------

export const formulaInputSchema = z.object({
  name: inputNameSchema,
  label: optionalText(200, 'The label'),
  unit: optionalText(30, 'The unit'),
  replicates: z.boolean('Say whether the input takes replicates (true or false).'),
}).strict();
export type FormulaInput = z.infer<typeof formulaInputSchema>;

/** A test case: inputs, the decimals the result is rounded to, and the value calculated by hand (outside the system). */
export const formulaTestCaseSchema = z.object({
  name: text(200, 'The test case name'),
  inputs: inputValuesSchema,
  decimals: z.number('Decimals must be a whole number.').int().min(0).max(MAX_DECIMALS).nullable(),
  expected: z.string('The expected value is the text of the hand-calculated result.').trim().regex(/^-?\d+(\.\d+)?$/, 'The expected value is a number written with digits (for example 0.71).'),
}).strict();
export type FormulaTestCase = z.infer<typeof formulaTestCaseSchema>;

const formulaFields = {
  name: text(200, 'The name'),
  expression: z.string('The expression is required.').trim().min(1, 'The expression is required.').max(2000, 'The expression is too long (2000 characters at most).'),
  inputs: z.array(formulaInputSchema).min(1, 'A formula has at least one input.').max(50, 'At most 50 inputs.').superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((inp, i) => {
      if (seen.has(inp.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate input: ${inp.name}.` });
      seen.add(inp.name);
    });
  }),
  unit: optionalText(30, 'The unit'),
  testCases: z.array(formulaTestCaseSchema).max(50, 'At most 50 test cases.'),
};

/** POST /calc/formulas: revision 1 of a new formula, a Draft. The expression is compiled on the server (400 if it is refused). */
export const formulaCreateSchema = z.object({ code: codeSchema, ...formulaFields }).strict();

export const formulaUpdateSchema = z.object({
  name: formulaFields.name.optional(),
  expression: formulaFields.expression.optional(),
  inputs: formulaFields.inputs.optional(),
  unit: editableText(30, 'The unit'),
  testCases: formulaFields.testCases.optional(),
  expectedVersion,
}).strict().refine(v => Object.keys(v).some(k => k !== 'expectedVersion'), { message: 'There is nothing to change.' });

/** POST /calc/evaluate: tries an expression; nothing is written. */
export const calcEvaluateSchema = z.object({
  expression: formulaFields.expression,
  inputs: inputValuesSchema,
  decimals: z.number().int().min(0).max(MAX_DECIMALS).nullish().transform(v => v ?? null),
}).strict();

/**
 * POST /calc/samples/:id/results/:resultId: the raw inputs of a calculated result. Never the value: the server calculates it.
 * Like PUT /samples/:id/results/:resultId, replacing a value that is OOS names its open investigation (oosId) and a coded reason.
 */
export const calcEntrySchema = z.object({
  inputs: inputValuesSchema,
  reason: z.string('The reason must be text.').trim().min(5, 'A clear reason is required for auditing (ALCOA+)').max(1000, 'The reason is too long (1000 characters at most).'),
  expectedVersion,
  instrumentId: z.string().trim().min(1).max(100).optional(),
  oosId: z.string().min(1).max(100).optional(),
  // The coded reason of a recalculation (roadmap M20): required when the result already has a value.
  reasonCode: z.enum(RESULT_CHANGE_CODES, { error: `reasonCode must be one of ${RESULT_CHANGE_CODES.join(', ')}.` }).optional(),
}).strict();

/** POST /calc/samples/:id/sst: one system suitability run of a method for the sample, with the inputs of every criterion. */
export const sstRunSchema = z.object({
  methodCode: codeSchema,
  criteria: z.array(z.object({ name: text(200, 'The criterion name'), inputs: inputValuesSchema }).strict()).min(1, 'Record the inputs of every system suitability criterion.').max(20),
  reason: optionalText(1000, 'The reason'),
  instrumentId: z.string().trim().min(1).max(100).optional(),
}).strict();

// ---- test plans ----------------------------------------------------------------------------------------------------------------

const testPlanFields = {
  name: text(200, 'The name'),
  material: text(200, 'The material'),
  purpose: text(60, 'The purpose'),
  parameters: z.array(text(200, 'A parameter name')).min(1, 'A test plan names at least one parameter.').max(MAX_PARAMETERS),
};
/** POST /test-plans: which parameters of the material's specification a kind of sample (release, stability, ...) is tested for. */
export const testPlanCreateSchema = z.object({ code: codeSchema, ...testPlanFields }).strict();
export const testPlanUpdateSchema = z.object({
  name: testPlanFields.name.optional(),
  purpose: testPlanFields.purpose.optional(),
  parameters: testPlanFields.parameters.optional(),
  expectedVersion,
}).strict().refine(v => Object.keys(v).some(k => k !== 'expectedVersion'), { message: 'There is nothing to change.' });

// ---- specification parameters bound to a method and a formula --------------------------------------------------------------------

/** What a specification parameter adds to its limit: the method it is tested by, the formula, the replicates and the stage. */
export interface ParameterBinding {
  method_code?: string;
  formula_code?: string;
  replicates?: number;
  stage?: string;
}
export type BoundSpecParameter = SpecParameter & ParameterBinding;

export const BINDING_KEYS = ['method_code', 'formula_code', 'replicates', 'stage'] as const;

const bindingSchema = z.object({
  method_code: codeSchema.nullish(),
  formula_code: codeSchema.nullish(),
  replicates: z.number('Replicates must be a whole number.').int('Replicates must be a whole number.').min(1, 'Replicates must be at least 1.').max(100, 'At most 100 replicates.').nullish(),
  stage: z.string('The stage must be text.').trim().max(60, 'The stage is too long (60 characters at most).').nullish(),
}).strict();

/** A parameter of a specification with its binding. The limit is validated by the specification's own schema (r1-spec). */
export const boundSpecParameterSchema = z.looseObject({}).transform((raw, ctx): BoundSpecParameter => {
  const limitPart: Record<string, unknown> = {};
  const bindingPart: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) ((BINDING_KEYS as readonly string[]).includes(k) ? bindingPart : limitPart)[k] = v;
  const limit = specParameterSchema.safeParse(limitPart);
  const binding = bindingSchema.safeParse(bindingPart);
  const issues: Array<{ path: (string | number)[]; message: string }> = [limit, binding]
    .flatMap(r => (r.success ? [] : r.error.issues.map(i => ({ path: i.path.map(p => (typeof p === 'number' ? p : String(p))), message: i.message }))));
  if (limit.success && binding.success) {
    const name = limit.data.name;
    const numeric = (NUMERIC_KINDS as readonly string[]).includes(limit.data.limit_kind);
    if (binding.data.formula_code && !numeric) issues.push({ path: ['formula_code'], message: `${name}: a formula calculates a number; a ${limit.data.limit_kind} limit has none.` });
    if (binding.data.replicates != null && !binding.data.formula_code) issues.push({ path: ['replicates'], message: `${name}: replicates are the determinations a formula combines; name the formula.` });
  }
  if (issues.length) {
    for (const i of issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
    return z.NEVER;
  }
  const out: BoundSpecParameter = { ...(limit.data as SpecParameter) };
  const b = binding.data!;
  if (b.method_code) out.method_code = b.method_code;
  if (b.formula_code) out.formula_code = b.formula_code;
  if (b.replicates != null) out.replicates = b.replicates;
  if (b.stage) out.stage = b.stage;
  return out;
});

export const boundSpecParametersSchema = z.array(boundSpecParameterSchema)
  .max(MAX_PARAMETERS, `A specification can have at most ${MAX_PARAMETERS} parameters.`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((p, i) => {
      const key = parameterKey(p.name);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate parameter name: ${p.name}.` });
      seen.add(key);
    });
  });

/** PUT /specifications/:id with bound parameters (same keys as r1-spec's specificationUpdateSchema, which the route table names). */
export const specificationUpdateWithBindingSchema = z.object({
  parameters: boundSpecParametersSchema.optional(),
  effectiveDate: z.string('The effective date is required.').refine(isEffectiveDate, 'The effective date must be a real date written YYYY-MM-DD.').optional(),
  expectedVersion,
}).strict().refine(v => v.parameters !== undefined || v.effectiveDate !== undefined, { message: 'There is nothing to change: send parameters or an effective date.' });

/** The binding stored beside a parameter in specifications.parameters (v0.1.0 and R1 rows have none). */
export function bindingOf(raw: unknown): ParameterBinding {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: ParameterBinding = {};
  if (typeof o.method_code === 'string' && o.method_code) out.method_code = o.method_code;
  if (typeof o.formula_code === 'string' && o.formula_code) out.formula_code = o.formula_code;
  if (typeof o.replicates === 'number' && Number.isInteger(o.replicates)) out.replicates = o.replicates;
  if (typeof o.stage === 'string' && o.stage) out.stage = o.stage;
  return out;
}
