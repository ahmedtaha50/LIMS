// Strict request schemas of the environmental monitoring programme (roadmap M32, r2-em). Server-controlled fields (id, status,
// version, unit, grade and room of a result, the limits used, who recorded or approved what) are not keys of any schema, so a
// request that sends one is refused with 400. The route table (src/server/authz/routeTable.ts) uses the same schemas as `body`.
import { z } from 'zod';
import { CLEANROOM_GRADES, normalizeGrade } from '../../lib/validations/env';
import { calendarDate } from '../../lib/validations/instruments';
import { signatureFields } from '../../lib/validations/signatures';
import { EM_METHODS, ISO_CLASSES, isViable, OCCUPANCY_STATES } from './constants';

const text = (label: string, max = 200) =>
  z.string({ error: `${label} must be text.` }).trim().min(1, `${label} is required.`).max(max, `${label} is at most ${max} characters.`);
const reason = z.string({ error: 'A reason is required.' }).trim().min(5, 'A reason is required (at least 5 characters).').max(1000);
const expectedVersion = z.number({ error: 'expectedVersion is required (a number).' }).int().min(1);
const grade = z.string({ error: 'Grade must be text.' }).transform((v, ctx) => {
  const g = normalizeGrade(v);
  if (!g) { ctx.addIssue({ code: 'custom', message: `Grade must be one of ${CLEANROOM_GRADES.join(', ')}.` }); return z.NEVER; }
  return g;
});
const method = z.enum(EM_METHODS, { error: `Method must be one of ${EM_METHODS.join(', ')}.` });
const occupancy = z.enum(OCCUPANCY_STATES, { error: `Occupancy must be one of ${OCCUPANCY_STATES.join(', ')}.` });
/** A count or a limit: a whole number of 0 or more. The screen's inputs send digits in a string. */
const count = (label: string) => z.union([
  z.number().int().min(0).max(999_999_999),
  z.string().regex(/^\d{1,9}$/).transform(Number),
], { error: `${label} must be a whole number of 0 or more.` });
const instant = (label: string) => z.iso.datetime({ offset: true, error: `${label} must be a date and time (ISO 8601).` });
const room = text('Room', 100);
const pointCode = z.string({ error: 'Code must be text.' }).trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/, 'Code is 1 to 40 letters, digits, spaces, dots, dashes, slashes or underscores.');

// ---- sampling points -----------------------------------------------------------------------------------------------------------

export const pointCreateSchema = z.object({ code: pointCode, room, description: text('Description', 300), grade }).strict();

export const pointUpdateSchema = z.object({
  room: room.optional(), description: text('Description', 300).optional(), grade: grade.optional(), reason, expectedVersion,
}).strict().refine(b => b.room !== undefined || b.description !== undefined || b.grade !== undefined, { message: 'Nothing to change.' });

export const pointRetireSchema = z.object({ reason, expectedVersion }).strict();

// ---- limit profiles ------------------------------------------------------------------------------------------------------------

const profileFields = {
  grade, method, occupancy,
  isoClass: z.enum(ISO_CLASSES, { error: `ISO class must be one of ${ISO_CLASSES.join(', ')}.` }).nullable().optional(),
  alertLimit: count('Alert limit').nullable().optional(),
  actionLimit: count('Action limit'),
  source: text('Source', 500),
};

function checkLimits(p: { method?: string; isoClass?: string | null; alertLimit?: number | null; actionLimit?: number }, ctx: z.RefinementCtx) {
  if (p.alertLimit != null && p.actionLimit !== undefined && p.alertLimit > p.actionLimit) {
    ctx.addIssue({ code: 'custom', path: ['alertLimit'], message: 'The alert limit cannot be above the action limit.' });
  }
  if (p.method !== undefined && !isViable(p.method) && !p.isoClass) {
    ctx.addIssue({ code: 'custom', path: ['isoClass'], message: 'A particle limit names the ISO class it is taken from.' });
  }
}

export const profileCreateSchema = z.object(profileFields).strict().superRefine(checkLimits);

export const profileUpdateSchema = z.object({
  isoClass: profileFields.isoClass, alertLimit: profileFields.alertLimit, actionLimit: count('Action limit').optional(),
  source: text('Source', 500).optional(), reason: reason.optional(), expectedVersion,
}).strict().refine(b => ['isoClass', 'alertLimit', 'actionLimit', 'source'].some(k => k in b), { message: 'Nothing to change.' });

/** The meaning is the server's (EM_LIMIT_APPROVAL), never the client's. */
export const profileApproveSchema = z.object({
  password: signatureFields.password, totpCode: signatureFields.totpCode, reason: signatureFields.reason, expectedVersion,
}).strict();

// ---- results -------------------------------------------------------------------------------------------------------------------

export const resultCreateSchema = z.object({
  pointId: text('Sampling point', 64),
  method, occupancy,
  sampledOn: calendarDate('Sampling date'),
  count: count('Count'),
  mediaLot: text('Media lot', 100).optional(),
  incubationStartedAt: instant('Incubation start').optional(),
  incubationEndedAt: instant('Incubation end').optional(),
  incubationConditions: text('Incubation conditions', 200).optional(),
  organism: text('Organism', 200).optional(),
}).strict().superRefine((b, ctx) => {
  if (isViable(b.method)) {
    if (!b.mediaLot) ctx.addIssue({ code: 'custom', path: ['mediaLot'], message: 'A viable result names the media lot.' });
    if (!b.incubationStartedAt) ctx.addIssue({ code: 'custom', path: ['incubationStartedAt'], message: 'A viable result gives the start of incubation.' });
    if (!b.incubationEndedAt) ctx.addIssue({ code: 'custom', path: ['incubationEndedAt'], message: 'A viable result is read after incubation: give its end.' });
    if (b.incubationStartedAt && b.incubationEndedAt && Date.parse(b.incubationEndedAt) <= Date.parse(b.incubationStartedAt)) {
      ctx.addIssue({ code: 'custom', path: ['incubationEndedAt'], message: 'Incubation ends after it starts.' });
    }
    if (b.organism && b.count === 0) ctx.addIssue({ code: 'custom', path: ['organism'], message: 'An organism is identified only on a plate with growth.' });
  } else {
    for (const k of ['mediaLot', 'incubationStartedAt', 'incubationEndedAt', 'incubationConditions', 'organism'] as const) {
      if (b[k] !== undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'A particle count has no media, incubation or organism.' });
    }
  }
});

/** PUT /em/results/:id: a correction by QA (env.correct), with a reason and the version it corrects. */
export const resultCorrectionSchema = z.object({
  count: count('Count').optional(),
  sampledOn: calendarDate('Sampling date').optional(),
  mediaLot: text('Media lot', 100).optional(),
  organism: text('Organism', 200).optional(),
  reason, expectedVersion,
}).strict().refine(b => ['count', 'sampledOn', 'mediaLot', 'organism'].some(k => k in b), { message: 'Nothing to correct.' });

/** POST /em/results/:id/identification: the organism of a plate with growth, recorded once (a later change is a correction). */
export const identificationSchema = z.object({ organism: text('Organism', 200), expectedVersion }).strict();

// ---- batch rooms, trends ---------------------------------------------------------------------------------------------------------

export const batchRoomCreateSchema = z.object({
  productBatchId: text('Batch', 64), room, fromDate: calendarDate('From'), toDate: calendarDate('To'),
}).strict().refine(b => b.fromDate <= b.toDate, { path: ['toDate'], message: 'The window ends on or after the day it starts.' });

export const batchRoomUpdateSchema = z.object({
  room: room.optional(), fromDate: calendarDate('From').optional(), toDate: calendarDate('To').optional(), reason, expectedVersion,
}).strict().refine(b => b.room !== undefined || b.fromDate !== undefined || b.toDate !== undefined, { message: 'Nothing to change.' });

export const trendAcknowledgeSchema = z.object({ acknowledgement: reason, expectedVersion }).strict();

export const emptyBodySchema = z.object({}).strict();

/** Query of GET /em/results and GET /em/heatmap. */
export const resultQuerySchema = z.object({
  pointId: z.string().max(64).optional(),
  room: z.string().max(100).optional(),
  status: z.enum(['Pass', 'Alert', 'Action']).optional(),
  from: calendarDate('From').optional(),
  to: calendarDate('To').optional(),
}).strict();

export const heatmapQuerySchema = z.object({
  weeks: z.string().regex(/^\d{1,2}$/).transform(Number).refine(n => n >= 1 && n <= 52, 'weeks is 1 to 52.').optional(),
}).strict();
