/**
 * Migration 0280_tat (roadmap M34): the four tables are empty after the migration (the defaults live in code, so nothing is written
 * without an audit entry), and the database itself refuses a value the application would refuse.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample } from '../helpers/fixtures';

let t: TestApp;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
beforeAll(async () => { t = await startTestApp(); await t.auth('analyst1@gxp.com'); });

describe('0280_tat', () => {
  it('creates empty tables and writes no constants', async () => {
    for (const table of ['business_calendar', 'business_holidays', 'tat_sla_rules', 'sample_tat']) {
      expect(await sql(`SELECT count(*)::int AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
    expect((await sql("SELECT id FROM schema_migrations WHERE id LIKE '0280%'")).length).toBe(1);
  });

  it('refuses a second calendar row, a priority that does not exist, a rule of 0 days, a malformed holiday and a clock with a start but no due date', async () => {
    const s = await registerSample(t);
    await sql("INSERT INTO business_calendar (id, weekend_days, time_zone, updated_by) VALUES ('default', '{0,6}', 'UTC', 'usr-qa')");
    await expect(sql("INSERT INTO business_calendar (id, weekend_days, time_zone, updated_by) VALUES ('other', '{0,6}', 'UTC', 'usr-qa')")).rejects.toThrow(/business_calendar_id_check/);
    await expect(sql("UPDATE business_calendar SET weekend_days = '{0,1,2,3,4,5,6}'")).rejects.toThrow(/business_calendar_weekend_check/);
    await expect(sql("UPDATE business_calendar SET weekend_days = '{7}'")).rejects.toThrow(/business_calendar_weekend_check/);
    await expect(sql("INSERT INTO tat_sla_rules (id, business_days, updated_by) VALUES ('Whenever', 3, 'usr-qa')")).rejects.toThrow(/tat_sla_rules_priority_check/);
    await expect(sql("INSERT INTO tat_sla_rules (id, business_days, updated_by) VALUES ('Urgent', 0, 'usr-qa')")).rejects.toThrow(/tat_sla_rules_days_check/);
    await expect(sql("INSERT INTO business_holidays (id, holiday_date, name, created_by) VALUES ('h', '25/12/2026', 'x', 'usr-qa')")).rejects.toThrow(/business_holidays_date_check/);
    await expect(sql("INSERT INTO sample_tat (id, priority, set_by) VALUES ($1, 'Whenever', 'usr-qa')", [s.id])).rejects.toThrow(/sample_tat_priority_check/);
    await expect(sql("INSERT INTO sample_tat (id, started_at, set_by) VALUES ($1, now(), 'usr-qa')", [s.id])).rejects.toThrow(/sample_tat_clock_check/);
    await expect(sql("INSERT INTO sample_tat (id, set_by) VALUES ('SMP-NOPE', 'usr-qa')")).rejects.toThrow(/sample_tat_id_samples_id_fk/);
  });
});
