/**
 * The pull calendar of a stability study (roadmap M31; ICH Q1A(R2) testing frequency). Pure functions on calendar dates
 * (YYYY-MM-DD): no time zone and no clock, so the same study gives the same dates on every PC.
 *
 *   due date      the start date plus the month point on the calendar, always counted from the start date (never chained). A day the
 *                 target month does not have is read as that month's last day: 31 January + 1 month = 28 February (29 in a leap year).
 *   pull window   the due date minus and plus the protocol's window in days; it never opens before the study starts.
 *   status        before the window: Scheduled; inside it: Due (overdue after the due day); after it closes, not pulled: Missed.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const fmt = (y: number, m1: number, d: number) => `${pad(y, 4)}-${pad(m1)}-${pad(d)}`;

/** Splits a calendar date, refusing one that does not exist (2026-02-30, 2026-13-01). */
export function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`"${date}" is not a calendar date (YYYY-MM-DD).`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new RangeError(`${date} does not exist.`);
  return { y, m: mo, d };
}

export function addMonths(date: string, months: number): string {
  if (!Number.isInteger(months) || months < 0) throw new RangeError(`${months} is not a whole number of months.`);
  const { y, m, d } = parseDate(date);
  const index = (m - 1) + months;
  const ty = y + Math.floor(index / 12), tm = (index % 12) + 1;
  return fmt(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export interface PlannedTimepoint {
  conditionId: string;
  conditionCode: string;
  month: number;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
}

/** One timepoint per condition and month point, in condition order and then month order. */
export function buildTimepoints(input: { startDate: string; months: readonly number[]; conditions: ReadonlyArray<{ id: string; code: string }>; windowDays: number }): PlannedTimepoint[] {
  parseDate(input.startDate);
  const months = [...input.months].sort((a, b) => a - b);
  return input.conditions.flatMap(c => months.map(month => {
    const dueDate = addMonths(input.startDate, month);
    const open = addDays(dueDate, -input.windowDays);
    return {
      conditionId: c.id, conditionCode: c.code, month, dueDate,
      windowStart: open < input.startDate ? input.startDate : open,
      windowEnd: addDays(dueDate, input.windowDays),
    };
  }));
}

export type CalendarStatus = 'Scheduled' | 'Due' | 'Missed';

/** Where a timepoint that has not been pulled stands on `today` (ISO date strings compare as dates). */
export function scheduledStatus(today: string, tp: { windowStart: string; dueDate: string; windowEnd: string }): { status: CalendarStatus; overdue: boolean } {
  if (today > tp.windowEnd) return { status: 'Missed', overdue: true };
  if (today >= tp.windowStart) return { status: 'Due', overdue: today > tp.dueDate };
  return { status: 'Scheduled', overdue: false };
}
