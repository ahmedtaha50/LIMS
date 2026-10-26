// Domain: specifications (roadmap M11). Owned by r1-spec. Shared by the server and the screen, so it imports nothing but zod.
//
// A specification is a list of parameters, each with the limit a result is judged against:
//
//   RANGE     lower and upper                 98.0 - 102.0 %
//   NMT       upper only (not more than)      NMT 0.5 %
//   NLT       lower only (not less than)      NLT 98.0 %
//   TEXT      an acceptance text              "White to off-white powder"
//   PRESENCE  an acceptance text              "Absent in 10 g"
//
// `decimals` is the number of decimal places the limit is written to: a result is rounded to it before it is compared (USP general
// notices 7.20, applied by the evaluator of r1-results-oos). It is required for a numeric limit, and the limit must not be written
// with more decimals than it declares (97.96 against "NLT 98.0" is rounded to 98.0 and passes; a limit of 98.05 declared with one
// decimal would be ambiguous, so it is refused).
//
// Rows written by v0.1.0 hold {name, min, max, unit?}. They are never rewritten (a signature covers them); normalizeParameters()
// reads either shape as the new one, with decimals null (nobody declared them), and toStoredParameters() writes the new shape plus
// min and max beside it for the code that still reads only those (registration, until r1-results-oos moves it to resolveActiveSpec).
import { z } from 'zod';
import { signatureFields } from './signatures';

export const LIMIT_KINDS = ['RANGE', 'NMT', 'NLT', 'TEXT', 'PRESENCE'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** A parameter as the API, the screen and the evaluator see it. */
export interface SpecParameter {
  name: string;
  unit: string;
  limit_kind: LimitKind;
  lower: number | null;
  upper: number | null;
  /** Decimal places of the limit; null only for a TEXT or PRESENCE limit, or for a limit written by v0.1.0 that nobody has re-declared. */
  decimals: number | null;
  /** The acceptance text of a TEXT or PRESENCE limit. */
  text: string | null;
}

/** What is kept in specifications.parameters: the parameter plus the old reader's min and max. */
export type StoredSpecParameter = SpecParameter & { min: number | null; max: number | null };

export const MAX_PARAMETERS = 100;
export const MAX_DECIMALS = 10;

const isNumericKind = (k: LimitKind) => k === 'RANGE' || k === 'NMT' || k === 'NLT';

/** Decimal places a number is written with: 98 -> 0, 0.005 -> 3, 1e-7 -> 7. */
export function decimalPlaces(n: number): number {
  const m = /^\d+(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(Math.abs(n)));
  if (!m) return 0;
  return Math.max(0, (m[1]?.length ?? 0) - (m[2] ? Number(m[2]) : 0));
}

/** YYYY-MM-DD and a day that exists (not 2026-02-30, not year 0000). */
export function isEffectiveDate(s: unknown): s is string {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The key by which two parameter names are "the same": case, spacing and the ends do not make a different parameter. */
export const parameterKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

const nullableNumber = z.number('A limit must be a number.').nullish().transform(v => v ?? null);

export const specParameterSchema = z.object({
  name: z.string('Parameter name is required.').trim().min(1, 'Parameter name is required.').max(200, 'Parameter name is too long (200 characters at most).'),
  unit: z.string('Unit must be text.').trim().max(30, 'Unit is too long (30 characters at most).').default(''),
  limit_kind: z.enum(LIMIT_KINDS, { error: `Limit kind must be one of ${LIMIT_KINDS.join(', ')}.` }),
  lower: nullableNumber,
  upper: nullableNumber,
  decimals: z.number('Decimals must be a whole number.').int('Decimals must be a whole number.')
    .min(0, 'Decimals cannot be negative.').max(MAX_DECIMALS, `Decimals cannot be more than ${MAX_DECIMALS}.`).nullish().transform(v => v ?? null),
  text: z.string('Acceptance text must be text.').trim().max(500, 'Acceptance text is too long (500 characters at most).').nullish().transform(v => (v ? v : null)),
}).strict().superRefine((p, ctx) => {
  const where = p.name || 'A parameter';
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message: `${where}: ${message}` });
  const kind = p.limit_kind;
  if (!isNumericKind(kind)) {
    if (p.lower !== null || p.upper !== null || p.decimals !== null) issue('limit_kind', `a ${kind} limit has no numeric limits or decimals.`);
    if (p.text === null) issue('text', `an acceptance text is required for a ${kind} limit.`);
    return;
  }
  if (p.text !== null) issue('text', `an acceptance text is not used by a ${kind} limit.`);
  const needsLower = kind === 'RANGE' || kind === 'NLT';
  const needsUpper = kind === 'RANGE' || kind === 'NMT';
  if (needsLower && p.lower === null) issue('lower', `the lower limit is required for a ${kind} limit.`);
  if (!needsLower && p.lower !== null) issue('lower', `the lower limit is not used by an ${kind} limit.`);
  if (needsUpper && p.upper === null) issue('upper', `the upper limit is required for a ${kind} limit.`);
  if (!needsUpper && p.upper !== null) issue('upper', `the upper limit is not used by an ${kind} limit.`);
  if (p.lower !== null && p.upper !== null && p.lower > p.upper) issue('lower', `the lower limit (${p.lower}) is above the upper limit (${p.upper}).`);
  if (p.decimals === null) {
    issue('decimals', `decimals is required for a ${kind} limit (it sets how results are rounded before they are compared).`);
  } else {
    for (const limit of [p.lower, p.upper]) {
      if (limit !== null && decimalPlaces(limit) > p.decimals) issue('decimals', `the limit ${limit} has more decimals than the ${p.decimals} declared.`);
    }
  }
});

export const specParametersSchema = z.array(specParameterSchema)
  .max(MAX_PARAMETERS, `A specification can have at most ${MAX_PARAMETERS} parameters.`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((p, i) => {
      const key = parameterKey(p.name);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate parameter name: ${p.name}.` });
      seen.add(key);
    });
  });

// ---- request schemas -----------------------------------------------------------------------------------------------------------

const material = z.string('Material is required.').trim().min(1, 'Material is required.').max(200, 'Material is too long (200 characters at most).');
const effectiveDate = z.string('The effective date is required.').refine(isEffectiveDate, 'The effective date must be a real date written YYYY-MM-DD.');

/**
 * POST /specifications: a Draft. No `version`, `revision_label`, `status`, `id`, author or parameters: the server assigns the first
 * five, and parameters are edited on the Draft (PUT). `reviseFrom` clones the parameters of an existing revision of the same material.
 */
export const specificationSchema = z.object({
  material,
  effectiveDate,
  reviseFrom: z.string().trim().min(1).max(100).optional(),
}).strict();

/** PUT /specifications/:id: the limits and/or the effective date of a Draft, against the version the editor saw. */
export const specificationUpdateSchema = z.object({
  parameters: specParametersSchema.optional(),
  effectiveDate: effectiveDate.optional(),
  expectedVersion: z.number('expectedVersion must be a number.').int().min(1, 'expectedVersion must be a positive whole number.'),
}).strict().refine(v => v.parameters !== undefined || v.effectiveDate !== undefined, { message: 'There is nothing to change: send parameters or an effective date.' });

const { meaningCode: _meaningCode, ...credentialFields } = signatureFields;
/**
 * POST /specifications/:id/approve: the electronic signature (password, authenticator code, reason) on the version the approver saw.
 * There is no meaning field: approving a specification has one meaning, and the server chooses it from the catalog.
 * `exceptionReason` is the QA exception that lets the approval replace a revision while samples of the material are still in progress.
 */
export const specificationApproveSchema = z.object({
  ...credentialFields,
  expectedVersion: z.number('expectedVersion must be a number.').int().min(1, 'expectedVersion must be a positive whole number.'),
  exceptionReason: z.string().trim().min(10, 'The exception needs a reason of at least 10 characters.').max(1000).optional(),
}).strict();

// ---- reading and writing the stored shape ----------------------------------------------------------------------------------------

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function normalizeOne(raw: unknown): SpecParameter {
  const o: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = typeof o.name === 'string' ? o.name : '';
  const unit = typeof o.unit === 'string' ? o.unit : '';
  if (typeof o.limit_kind === 'string' && (LIMIT_KINDS as readonly string[]).includes(o.limit_kind)) {
    return {
      name, unit, limit_kind: o.limit_kind as LimitKind, lower: numberOrNull(o.lower), upper: numberOrNull(o.upper),
      decimals: intOrNull(o.decimals), text: typeof o.text === 'string' && o.text ? o.text : null,
    };
  }
  // v0.1.0: {name, min, max, unit?}
  const min = numberOrNull(o.min);
  const max = numberOrNull(o.max);
  const limit_kind: LimitKind = min !== null && max !== null ? 'RANGE' : min !== null ? 'NLT' : max !== null ? 'NMT' : 'TEXT';
  return { name, unit, limit_kind, lower: min, upper: max, decimals: null, text: null };
}

/** The parameters of a stored specification, in the new shape whatever shape they were written in. */
export function normalizeParameters(raw: unknown): SpecParameter[] {
  return Array.isArray(raw) ? raw.map(normalizeOne) : [];
}

/** The shape written to specifications.parameters: the parameter plus min and max for readers that know only those. */
export function toStoredParameters(params: readonly SpecParameter[]): StoredSpecParameter[] {
  return params.map(p => ({
    ...p,
    min: p.limit_kind === 'RANGE' || p.limit_kind === 'NLT' ? p.lower : null,
    max: p.limit_kind === 'RANGE' || p.limit_kind === 'NMT' ? p.upper : null,
  }));
}
