/**
 * Roadmap M34 (r2-tat-kpi): the business calendar. A due date is N business days after the receipt, at the same clock time,
 * counting days that are neither weekend nor holiday in the calendar's time zone.
 */
import { describe, expect, it } from 'vitest';
import { addBusinessDays, isBusinessDay, localDate, type CalendarConfig } from '../../src/server/lib/businessCalendar';

const FRI_SAT: CalendarConfig = { weekendDays: [5, 6], timeZone: 'UTC', holidays: [] };
const SAT_SUN: CalendarConfig = { weekendDays: [0, 6], timeZone: 'UTC', holidays: [] };
const at = (iso: string) => new Date(iso);

describe('addBusinessDays', () => {
  // 2026-10-22 is a Thursday.
  it.each([
    ['Thursday 16:00, 2 business days, Fri-Sat weekend: due Monday 16:00 (acceptance M34)', '2026-10-22T16:00:00Z', 2, FRI_SAT, '2026-10-26T16:00:00.000Z'],
    ['Thursday 16:00, 1 business day, Fri-Sat weekend: Sunday', '2026-10-22T16:00:00Z', 1, FRI_SAT, '2026-10-25T16:00:00.000Z'],
    ['Thursday 16:00, 2 business days, Sat-Sun weekend: Monday', '2026-10-22T16:00:00Z', 2, SAT_SUN, '2026-10-26T16:00:00.000Z'],
    ['Friday 09:30, 1 business day, Sat-Sun weekend: Monday', '2026-10-23T09:30:00Z', 1, SAT_SUN, '2026-10-26T09:30:00.000Z'],
    ['received on a Saturday, 1 business day, Sat-Sun weekend: Monday (counting starts at the next business day)', '2026-10-24T10:00:00Z', 1, SAT_SUN, '2026-10-26T10:00:00.000Z'],
    ['zero business days: the receipt itself', '2026-10-24T10:00:00Z', 0, SAT_SUN, '2026-10-24T10:00:00.000Z'],
    ['a holiday is skipped', '2026-10-22T16:00:00Z', 2, { ...SAT_SUN, holidays: ['2026-10-26'] }, '2026-10-27T16:00:00.000Z'],
    ['a holiday on the weekend changes nothing', '2026-10-22T16:00:00Z', 2, { ...SAT_SUN, holidays: ['2026-10-24'] }, '2026-10-26T16:00:00.000Z'],
    ['ten business days is two calendar weeks', '2026-10-19T08:00:00Z', 10, SAT_SUN, '2026-11-02T08:00:00.000Z'],
    ['no weekend at all: calendar days', '2026-10-22T16:00:00Z', 3, { weekendDays: [], timeZone: 'UTC', holidays: [] }, '2026-10-25T16:00:00.000Z'],
  ])('%s', (_name, start, days, cfg, expected) => {
    expect(addBusinessDays(at(start), days, cfg).toISOString()).toBe(expected);
  });

  it('counts days in the calendar time zone: 22:30 UTC on Thursday is already Friday in Cairo', () => {
    const cairo: CalendarConfig = { weekendDays: [5, 6], timeZone: 'Africa/Cairo', holidays: [] };
    const start = at('2026-10-22T22:30:00Z'); // Friday 01:30 or 00:30 in Cairo, a weekend day
    expect(localDate(start, 'Africa/Cairo')).toBe('2026-10-23');
    const due = addBusinessDays(start, 1, cairo); // next business day is Sunday 2026-10-25, same local clock time
    expect(localDate(due, 'Africa/Cairo')).toBe('2026-10-25');
    expect(due.getTime() - start.getTime()).toBe(2 * 86_400_000); // no DST change between those dates in Cairo
  });

  it('keeps the local clock time across a daylight-saving change', () => {
    const berlin: CalendarConfig = { weekendDays: [0, 6], timeZone: 'Europe/Berlin', holidays: [] };
    // Friday 2026-10-23 10:00 Berlin (CEST, UTC+2) + 3 business days = Wednesday 2026-10-28 10:00 Berlin (CET, UTC+1) = 09:00 UTC
    const due = addBusinessDays(at('2026-10-23T08:00:00Z'), 3, berlin);
    expect(due.toISOString()).toBe('2026-10-28T09:00:00.000Z');
  });

  it('refuses a negative or fractional count and an unknown time zone', () => {
    expect(() => addBusinessDays(at('2026-10-22T16:00:00Z'), -1, SAT_SUN)).toThrow();
    expect(() => addBusinessDays(at('2026-10-22T16:00:00Z'), 1.5, SAT_SUN)).toThrow();
    expect(() => addBusinessDays(at('2026-10-22T16:00:00Z'), 1, { ...SAT_SUN, timeZone: 'Mars/Olympus' })).toThrow();
  });

  it('refuses a calendar where every day of the week is a weekend (the count could never finish)', () => {
    expect(() => addBusinessDays(at('2026-10-22T16:00:00Z'), 1, { weekendDays: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC', holidays: [] })).toThrow();
  });
});

describe('isBusinessDay', () => {
  it('is false on a weekend day and on a holiday', () => {
    expect(isBusinessDay('2026-10-23', FRI_SAT)).toBe(false); // Friday
    expect(isBusinessDay('2026-10-25', FRI_SAT)).toBe(true);  // Sunday
    expect(isBusinessDay('2026-10-26', { ...FRI_SAT, holidays: ['2026-10-26'] })).toBe(false);
  });
});
