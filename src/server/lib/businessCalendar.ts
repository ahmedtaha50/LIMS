/**
 * The business calendar (roadmap M34, r2-tat-kpi): which days count towards a turnaround-time commitment.
 *
 * A due date is N business days after the receipt of the sample, at the same clock time, in the calendar's time zone. A business day
 * is a day that is neither a weekend day nor a holiday. Counting starts the day after the receipt, so a sample received on a weekend
 * with a 1-day commitment is due on the next business day. Pure functions: no database, no clock.
 *
 * Weekend days use the JavaScript numbering: 0 Sunday ... 6 Saturday.
 */

export interface CalendarConfig {
  weekendDays: readonly number[];
  /** IANA time zone name, e.g. 'UTC' or 'Africa/Cairo'. */
  timeZone: string;
  /** Holidays as YYYY-MM-DD local dates. */
  holidays: readonly string[];
}

/** Used until an administrator saves a calendar. A conservative default (Saturday and Sunday, UTC, no holidays). */
export const DEFAULT_CALENDAR: CalendarConfig = { weekendDays: [0, 6], timeZone: 'UTC', holidays: [] };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true; } catch { return false; }
}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }
function partsOf(instant: Date, timeZone: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as unknown as Parts;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ymd = (p: { year: number; month: number; day: number }) => `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;

/** The calendar date (YYYY-MM-DD) of an instant in the time zone. */
export function localDate(instant: Date, timeZone: string): string { return ymd(partsOf(instant, timeZone)); }

/** Offset of the zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetAt(instant: Date, timeZone: string): number {
  const p = partsOf(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the zone's wall clock reads the given local date and time. A time skipped by a clock change moves forward. */
function zonedInstant(p: Parts, ms: number, timeZone: string): Date {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, ms);
  let guess = naive - offsetAt(new Date(naive), timeZone);
  guess = naive - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
}

const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function isBusinessDay(date: string, cfg: Pick<CalendarConfig, 'weekendDays' | 'holidays'>): boolean {
  return !cfg.weekendDays.includes(dayOfWeek(date)) && !cfg.holidays.includes(date);
}

/** The instant N business days after `start`, at the same local clock time. */
export function addBusinessDays(start: Date, days: number, cfg: CalendarConfig): Date {
  if (!Number.isInteger(days) || days < 0) throw new Error('The number of business days must be a whole number of at least 0.');
  if (!isValidTimeZone(cfg.timeZone)) throw new Error(`Unknown time zone '${cfg.timeZone}'.`);
  if (new Set(cfg.weekendDays).size >= 7) throw new Error('Every day of the week is a weekend day: no business day exists.');
  if (days === 0) return new Date(start.getTime());

  const local = partsOf(start, cfg.timeZone);
  const ms = ((start.getTime() % 1000) + 1000) % 1000;
  let cursor = Date.UTC(local.year, local.month - 1, local.day);
  let remaining = days;
  // Every week holds at least one business day unless the holidays fill it; a calendar with a year of holidays still ends.
  for (let guard = 0; remaining > 0 && guard < 366 * 20; guard++) {
    cursor += 86_400_000;
    const c = new Date(cursor);
    if (isBusinessDay(ymd({ year: c.getUTCFullYear(), month: c.getUTCMonth() + 1, day: c.getUTCDate() }), cfg)) remaining--;
  }
  if (remaining > 0) throw new Error('No business day was found within twenty years: check the holidays.');
  const c = new Date(cursor);
  return zonedInstant({ year: c.getUTCFullYear(), month: c.getUTCMonth() + 1, day: c.getUTCDate(), hour: local.hour, minute: local.minute, second: local.second }, ms, cfg.timeZone);
}
