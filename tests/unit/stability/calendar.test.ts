/**
 * Roadmap M31 (r2-stability), the pull calendar: a timepoint per (condition, month point), its due date the start date plus the
 * months on the calendar (a day that the month does not have is its last day), and its pull window around the due date.
 * Pure date arithmetic on calendar dates (YYYY-MM-DD): no time zone and no clock is involved.
 */
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, buildTimepoints, scheduledStatus } from '../../../src/server/stability/calendar';

describe('calendar arithmetic', () => {
  it('adds months on the calendar, the last day of a shorter month standing for a day it does not have', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-03-31', 6)).toBe('2026-09-30');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
    expect(addMonths('2026-05-10', 0)).toBe('2026-05-10');
    expect(addMonths('2026-12-31', 120)).toBe('2036-12-31');
  });

  it('counts each point from the start date, so a short month does not shift the later points', () => {
    // Chained (Jan 31 -> Feb 28 -> Mar 28) would drift; from the start every point is the last day of its month.
    expect([1, 2, 3].map(m => addMonths('2026-01-31', m))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('adds and subtracts days across month and year ends and 29 February', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-01-03', -7)).toBe('2025-12-27');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });

  it('refuses a date that does not exist', () => {
    expect(() => addMonths('2026-02-30', 1)).toThrow();
    expect(() => addDays('2026-13-01', 1)).toThrow();
  });
});

describe('the timepoints of a study', () => {
  const conditions = [{ id: 'C-LT', code: 'LT-25-60' }, { id: 'C-ACC', code: 'ACC-40-75' }];

  it('8 month points x 2 conditions give 16 timepoints with the right due dates and windows (acceptance M31.1)', () => {
    const months = [0, 1, 2, 3, 6, 9, 12, 13];
    const tps = buildTimepoints({ startDate: '2027-11-30', months, conditions, windowDays: 7 });
    expect(tps).toHaveLength(16);
    const due = (code: string) => tps.filter(t => t.conditionCode === code).map(t => [t.month, t.dueDate]);
    const expected = [
      [0, '2027-11-30'], [1, '2027-12-30'], [2, '2028-01-30'], [3, '2028-02-29'], // 29 Feb 2028: leap year, from a 30th
      [6, '2028-05-30'], [9, '2028-08-30'], [12, '2028-11-30'], [13, '2028-12-30'],
    ];
    expect(due('LT-25-60')).toEqual(expected);
    expect(due('ACC-40-75')).toEqual(expected);
    const feb = tps.find(t => t.conditionCode === 'LT-25-60' && t.month === 3)!;
    expect(feb).toMatchObject({ conditionId: 'C-LT', windowStart: '2028-02-22', windowEnd: '2028-03-07' });
    // The window never opens before the study starts.
    expect(tps.find(t => t.month === 0)).toMatchObject({ windowStart: '2027-11-30', windowEnd: '2027-12-07' });
    expect(new Set(tps.map(t => `${t.conditionId}:${t.month}`)).size).toBe(16);
  });

  it('a study started on 31 January: every monthly point is the last day of a short month, 29 February in a leap year', () => {
    const tps = buildTimepoints({ startDate: '2028-01-31', months: [1, 2, 3, 4, 5, 6, 7, 8], conditions, windowDays: 0 });
    expect(tps.filter(t => t.conditionId === 'C-ACC').map(t => t.dueDate)).toEqual(
      ['2028-02-29', '2028-03-31', '2028-04-30', '2028-05-31', '2028-06-30', '2028-07-31', '2028-08-31', '2028-09-30']);
    expect(tps.every(t => t.windowStart === t.dueDate && t.windowEnd === t.dueDate)).toBe(true);
  });
});

describe('Scheduled, Due and Missed follow the calendar, not a person', () => {
  const tp = { windowStart: '2026-03-08', dueDate: '2026-03-15', windowEnd: '2026-03-22' };
  it('is Scheduled before the window opens, Due inside it (overdue after the due day) and Missed after it closes', () => {
    expect(scheduledStatus('2026-03-07', tp)).toEqual({ status: 'Scheduled', overdue: false });
    expect(scheduledStatus('2026-03-08', tp)).toEqual({ status: 'Due', overdue: false });
    expect(scheduledStatus('2026-03-15', tp)).toEqual({ status: 'Due', overdue: false });
    expect(scheduledStatus('2026-03-16', tp)).toEqual({ status: 'Due', overdue: true });
    expect(scheduledStatus('2026-03-22', tp)).toEqual({ status: 'Due', overdue: true });
    expect(scheduledStatus('2026-03-23', tp)).toEqual({ status: 'Missed', overdue: true });
    expect(scheduledStatus('2027-01-01', tp)).toEqual({ status: 'Missed', overdue: true });
  });
});
