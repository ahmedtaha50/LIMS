import { z } from 'zod';
import { calendarDate } from './instruments';

/** The one status vocabulary of a stability study, shared by the server and the screen. Completed and Aborted are final. */
export const STABILITY_STATUSES = ['Ongoing', 'Completed', 'Aborted'] as const;
export const STABILITY_FINAL_STATUSES: readonly string[] = ['Completed', 'Aborted'];
export type StabilityStatus = (typeof STABILITY_STATUSES)[number];

/** The pull points used when a protocol states none (the long-standing default). */
export const DEFAULT_PULL_POINTS = [1, 3, 6, 9, 12];

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);

/** Months from the start of the study, as the protocol lists them: whole months 1..120, ascending, no repeats, at most 24. */
export const pullPointsSchema = z.array(z.number().int('Pull points are whole months.').min(1).max(120), { error: 'Pull points must be a list of months.' })
  .min(1, 'At least one pull point is required.').max(24, 'At most 24 pull points.')
  .refine(p => p.every((m, i) => i === 0 || m > p[i - 1]), 'Pull points must be in ascending order without repeats.');

/** POST /stability. The status starts Ongoing (server). */
export const stabilitySchema = z.object({
  product: text('Product'),
  batch: text('Batch'),
  condition: text('Storage condition', 100),
  startDate: calendarDate('Start date'),
  pullPoints: pullPointsSchema.optional(),
}).strict();

/** PUT /stability/:id. A finished study (Completed, Aborted) is locked; the route answers 423. */
export const stabilityUpdateSchema = z.object({
  product: text('Product').optional(),
  batch: text('Batch').optional(),
  condition: text('Storage condition', 100).optional(),
  status: z.enum(STABILITY_STATUSES, { error: `Status must be one of ${STABILITY_STATUSES.join(', ')}.` }).optional(),
  expectedVersion: z.number({ error: 'expectedVersion is required (a number).' }).int().min(1),
}).strict();
