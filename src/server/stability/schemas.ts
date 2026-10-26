/**
 * Request schemas of the stability programme (roadmap M31). Strict: an unknown key is a 400. Server-controlled fields (id, status,
 * revision, version, createdBy, approvedBy, the timepoint dates and states, the pull sample) are never accepted; a status moves only
 * through its own route. The route table (src/server/authz/routeTable.ts) names the same schemas as `body`.
 */
import { z } from 'zod';
import { calendarDate } from '../../lib/validations/instruments';
import { STABILITY_CHAMBER_STATUSES, STABILITY_CONDITION_CATEGORIES, STABILITY_CONDITION_STATUSES } from '../../db/schema/stability';

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);
const code = (label: string) => text(label, 40).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${label}: letters, digits, '.', '_' and '-' only.`);
const id = (label: string) => text(label, 80);
const expectedVersion = z.number({ error: 'expectedVersion is required (a number).' }).int().min(1);
const reason = text('The reason', 500).refine(r => r.length >= 5, 'The reason must say why (at least 5 characters).');
/** A number of degrees or percent, sent as a number; stored exactly (numeric). */
const measure = (label: string, min: number, max: number) => z.number({ error: `${label} must be a number.` }).finite().min(min, `${label} is at least ${min}.`).max(max, `${label} is at most ${max}.`);

/** Month points of a protocol: whole months 0 (the initial test) to 120, ascending, no repeats, at most 30. */
export const monthPointsSchema = z.array(z.number({ error: 'A month point is a whole number of months.' }).int('Month points are whole months.').min(0, 'Month points start at 0 (the initial test).').max(120, 'Month points end at 120.'), { error: 'The month points must be a list of months.' })
  .min(1, 'At least one month point is required.').max(30, 'At most 30 month points.')
  .refine(p => p.every((m, i) => i === 0 || m > p[i - 1]), 'Month points must be in ascending order without repeats.');

// ---- storage conditions and chambers ------------------------------------------------------------------------------------------

const humidity = {
  humidityRh: measure('Relative humidity', 0, 100).nullable().optional(),
  humidityToleranceRh: measure('The humidity tolerance', 0, 50).nullable().optional(),
};
const bothOrNeither = (v: { humidityRh?: number | null; humidityToleranceRh?: number | null }) => (v.humidityRh == null) === (v.humidityToleranceRh == null);
const HUMIDITY_PAIR = 'Give the relative humidity and its tolerance together, or neither (humidity not controlled).';

export const conditionCreateSchema = z.object({
  code: code('Code'),
  name: text('Name'),
  category: z.enum(STABILITY_CONDITION_CATEGORIES, { error: `Category must be one of ${STABILITY_CONDITION_CATEGORIES.join(', ')}.` }),
  temperatureC: measure('Temperature', -100, 100),
  temperatureToleranceC: measure('The temperature tolerance', 0, 20),
  ...humidity,
}).strict().refine(bothOrNeither, HUMIDITY_PAIR);

/** The code is the identity a protocol names: never changed. A change is audited with its reason. */
export const conditionUpdateSchema = z.object({
  name: text('Name').optional(),
  category: z.enum(STABILITY_CONDITION_CATEGORIES, { error: `Category must be one of ${STABILITY_CONDITION_CATEGORIES.join(', ')}.` }).optional(),
  temperatureC: measure('Temperature', -100, 100).optional(),
  temperatureToleranceC: measure('The temperature tolerance', 0, 20).optional(),
  ...humidity,
  status: z.enum(STABILITY_CONDITION_STATUSES, { error: `Status must be one of ${STABILITY_CONDITION_STATUSES.join(', ')}.` }).optional(),
  reason,
  expectedVersion,
}).strict();

export const chamberCreateSchema = z.object({
  code: code('Code'),
  name: text('Name'),
  conditionId: id('The condition'),
  location: text('Location').nullable().optional(),
}).strict();

export const chamberUpdateSchema = z.object({
  name: text('Name').optional(),
  location: text('Location').nullable().optional(),
  status: z.enum(STABILITY_CHAMBER_STATUSES, { error: `Status must be one of ${STABILITY_CHAMBER_STATUSES.join(', ')}.` }).optional(),
  reason,
  expectedVersion,
}).strict();

// ---- protocols ----------------------------------------------------------------------------------------------------------------

const protocolFields = {
  title: text('Title'),
  testPlanCode: code('The test plan code'),
  conditionIds: z.array(id('A condition'), { error: 'The conditions must be a list of condition ids.' }).min(1, 'At least one storage condition is required.').max(10, 'At most 10 conditions.')
    .refine(c => new Set(c).size === c.length, 'A condition is listed twice.'),
  monthPoints: monthPointsSchema,
  windowDays: z.number({ error: 'The pull window is a whole number of days.' }).int('The pull window is a whole number of days.').min(0).max(60, 'The pull window is at most 60 days either side.'),
};

/** POST /stability/protocols: revision 1 of a new code, a Draft. */
export const protocolCreateSchema = z.object({ code: code('Code'), productId: id('The product'), ...protocolFields }).strict();

/** PUT /stability/protocols/:id: a Draft only. The code and the product never change (a new protocol is a new code). */
export const protocolUpdateSchema = z.object({
  title: protocolFields.title.optional(),
  testPlanCode: protocolFields.testPlanCode.optional(),
  conditionIds: protocolFields.conditionIds.optional(),
  monthPoints: protocolFields.monthPoints.optional(),
  windowDays: protocolFields.windowDays.optional(),
  expectedVersion,
}).strict();

export const protocolReviseSchema = z.object({}).strict();

/** POST /stability/protocols/:id/approve: STABILITY_PROTOCOL_APPROVAL; the meaning is the server's. */
export const protocolApproveSchema = z.object({
  password: z.string({ error: 'Password is required to sign.' }).min(1, 'Password is required to sign.'),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
  reason: z.string().trim().max(500).optional(),
  expectedVersion,
}).strict();

// ---- studies and pulls --------------------------------------------------------------------------------------------------------

/**
 * POST /stability: a study of one batch under an Approved protocol revision. The product, batch text, conditions and month points
 * come from the protocol and the batch (server). `chambers` names, per condition of the protocol, the chamber the samples are kept in.
 */
export const studyCreateSchema = z.object({
  protocolId: id('The protocol'),
  batchId: id('The batch'),
  startDate: calendarDate('Start date'),
  chambers: z.record(z.string(), id('A chamber'), { error: 'chambers maps a condition id to a chamber id.' }).optional(),
}).strict();

/**
 * PUT /stability/:id: only the end of a study, with its reason. Product, batch and condition are no longer edited (M31): they come from
 * the protocol and the batch, and a wrong study is aborted and started again.
 */
export const studyCloseSchema = z.object({
  status: z.enum(['Completed', 'Aborted'], { error: 'Status must be Completed or Aborted (a study is started Ongoing by the server).' }),
  reason,
  expectedVersion,
}).strict();

/** POST /stability/timepoints/:id/pull: the timepoint's version; everything else is the server's. */
export const pullSchema = z.object({ expectedVersion }).strict();
