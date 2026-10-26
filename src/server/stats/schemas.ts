// Strict request schemas of trending (roadmap M39, r3-spc). Server-controlled fields (id, status, version, the computed limits, who
// signed what) are not keys of any schema, so a request that sends one is refused with 400. The route table uses the same schemas.
import { z } from 'zod';
import { SPC_RULE_SETS } from '../../db/schema/spc';
import { signatureFields } from '../../lib/validations/signatures';
import { SERIES_LIMIT_MAX } from './constants';

const text = (label: string, max = 200) =>
  z.string({ error: `${label} must be text.` }).trim().min(1, `${label} is required.`).max(max, `${label} is at most ${max} characters.`);
const reason = z.string({ error: 'A reason is required.' }).trim().min(5, 'A reason is required (at least 5 characters).').max(1000);
const expectedVersion = z.number({ error: 'expectedVersion is required (a number).' }).int().min(1);
const ruleSet = z.enum(SPC_RULE_SETS, { error: `ruleSet must be one of ${SPC_RULE_SETS.join(', ')}.` });

/** A calendar day or an instant. A day as `from` starts at 00:00:00.000 UTC; as `to` it ends at 23:59:59.999 UTC. */
const when = (label: string, end: boolean) => z.union([
  z.iso.date({ error: `${label} must be a date (YYYY-MM-DD) or a date and time.` }).transform(d => `${d}${end ? 'T23:59:59.999' : 'T00:00:00.000'}Z`),
  z.iso.datetime({ offset: true, error: `${label} must be a date (YYYY-MM-DD) or a date and time.` }),
]);
const bool = z.enum(['true', 'false'], { error: 'Must be true or false.' }).transform(v => v === 'true');

export const seriesQuerySchema = z.object({
  productId: text('productId', 64),
  parameter: text('parameter', 200),
  from: when('from', false).optional(),
  to: when('to', true).optional(),
  includeUnapproved: bool.optional(),
  ruleSet: ruleSet.optional(),
  limit: z.string().regex(/^\d{1,4}$/, 'limit must be a whole number.').transform(Number).pipe(z.number().int().min(10).max(SERIES_LIMIT_MAX)).optional(),
}).strict();

export const parametersQuerySchema = z.object({ productId: text('productId', 64) }).strict();

export const baselineQuerySchema = z.object({ productId: text('productId', 64), parameter: text('parameter', 200) }).strict();

export const baselineCreateSchema = z.object({
  productId: text('productId', 64),
  parameter: text('parameter', 200),
  from: when('from', false).optional(),
  to: when('to', true).optional(),
  ruleSet: ruleSet.default('nelson'),
  /** Points left out of the baseline, each named and justified. */
  exclusions: z.array(z.object({ resultId: text('resultId', 64), reason }).strict()).max(200).default([]),
  /** The revision of the Approved baseline the caller saw (0: there is none): a baseline set by someone else meanwhile is a 409. */
  expectedRevision: z.number({ error: 'expectedRevision is required (a number; 0 when there is no baseline yet).' }).int().min(0),
  reason,
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();

export const alertQuerySchema = z.object({
  status: z.enum(['Open', 'Acknowledged']).optional(),
  productId: text('productId', 64).optional(),
}).strict();

export const alertAcknowledgeSchema = z.object({ note: text('note', 1000).refine(v => v.length >= 5, 'Describe the assessment (at least 5 characters).'), expectedVersion }).strict();

export const emptyBodySchema = z.object({}).strict();

export const stabilityTrendQuerySchema = z.object({
  productId: text('productId', 64),
  parameter: text('parameter', 200),
  conditionCode: text('conditionCode', 64).optional(),
}).strict();
