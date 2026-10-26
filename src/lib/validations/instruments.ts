import { z } from 'zod';
import { signatureFields } from './signatures';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD (2030-02-30 is not one). */
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** A calendar date, YYYY-MM-DD, as the date inputs of the screens send it. Shared by the equipment, reagent, EM and stability schemas. */
export const calendarDate = (label: string) =>
  z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be a date (YYYY-MM-DD).`) })
    .refine(isCalendarDate, `${label} must be a real calendar date (YYYY-MM-DD).`);

/** Today's date in UTC, YYYY-MM-DD: the day boundaries of due dates and expiry dates. */
export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/**
 * Whether a calibration (or an expiry) is still current: a due date is valid through the END of that day (UTC), so an instrument due
 * today may be used today and is out of calibration from 00:00 UTC the next day. A value that is not a date is treated as expired:
 * an instrument whose due date cannot be read is not shown as fit for use. Accepts YYYY-MM-DD or an ISO timestamp (its UTC date).
 */
export function calibrationState(dueDate: string, now = new Date()): { expired: boolean; daysRemaining: number } {
  const day = typeof dueDate === 'string' ? dueDate.slice(0, 10) : '';
  if (!isCalendarDate(day)) return { expired: true, daysRemaining: Number.NEGATIVE_INFINITY };
  const due = Date.parse(`${day}T00:00:00Z`);
  const today = Date.parse(`${utcToday(now)}T00:00:00Z`);
  const daysRemaining = Math.round((due - today) / DAY_MS);
  return { expired: daysRemaining < 0, daysRemaining };
}

const text = (label: string, max = 200) => z.string({ error: iss => (iss.input === undefined ? `${label} is required.` : `${label} must be text.`) })
  .trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);

/** POST /instruments. The status starts Active; the last calibration is what the registrar states (from the certificate), not "now". */
export const instrumentSchema = z.object({
  name: text('Instrument name'),
  type: text('Instrument type', 100),
  calibrationDueDate: calendarDate('Calibration due date'),
  lastCalibrationDate: calendarDate('Last calibration date'),
}).strict();

/**
 * POST /instruments/:id/calibrate: the new due date and the signer's credentials. The calibration is performed now (the server's
 * clock); the new due date must be after today. The meaning (CALIBRATION) is the server's.
 */
export const calibrateSchema = z.object({
  newDueDate: calendarDate('New due date'),
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();
