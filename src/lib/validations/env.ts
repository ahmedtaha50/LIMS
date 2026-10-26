import { z } from 'zod';
import { calendarDate } from './instruments';

/** The status vocabulary of an environmental monitoring result, shared by the server and the screen. */
export const ENV_STATUSES = ['Pass', 'Alert', 'Action'] as const;
export type EnvStatus = (typeof ENV_STATUSES)[number];

export const CLEANROOM_GRADES = ['Grade A', 'Grade B', 'Grade C', 'Grade D'] as const;
export const ENV_SAMPLE_TYPES = ['Air', 'Settle plate', 'Contact plate', 'Glove print'] as const;

/** "D", "Grade D" and "grade d" are the same grade; it is stored as "Grade D". Anything else is not a cleanroom grade. */
export function normalizeGrade(value: string): string | null {
  const m = /^(?:grade\s+)?([abcd])$/i.exec(value.trim());
  return m ? `Grade ${m[1].toUpperCase()}` : null;
}

const grade = z.string({ error: 'Grade must be text.' }).transform((v, ctx) => {
  const g = normalizeGrade(v);
  if (!g) { ctx.addIssue({ code: 'custom', message: `Grade must be one of ${CLEANROOM_GRADES.join(', ')}.` }); return z.NEVER; }
  return g;
});

const sampleType = z.enum(ENV_SAMPLE_TYPES, { error: `Sample type must be one of ${ENV_SAMPLE_TYPES.join(', ')}.` });

/** A count is a whole number of 0 or more; the screen's inputs send it as digits in a string. */
const count = (label: string) => z.union([
  z.number().int().min(0),
  z.string().regex(/^\d{1,9}$/).transform(Number),
], { error: `${label} must be a whole number of 0 or more.` });

const location = z.string({ error: 'Location must be text.' }).trim().min(1, 'Location is required.').max(200);

/** POST /env-records. Status, limits and the excursion are the server's: they follow from the grade, the sample type and env_limits. */
export const envRecordSchema = z.object({
  location,
  grade,
  sampleType,
  date: calendarDate('Sampling date'),
  viableCount: count('Viable count'),
  nonViableCount: count('Non-viable count'),
}).strict();

/** PUT /env-records/:id: a correction by QA, with a reason and the version it corrects. */
export const envRecordUpdateSchema = z.object({
  location: location.optional(),
  grade: grade.optional(),
  sampleType: sampleType.optional(),
  viableCount: count('Viable count').optional(),
  nonViableCount: count('Non-viable count').optional(),
  reason: z.string({ error: 'A reason for the correction is required.' }).trim().min(5, 'A reason for the correction is required (at least 5 characters).').max(1000),
  expectedVersion: z.number({ error: 'expectedVersion is required (a number).' }).int().min(1),
}).strict();
