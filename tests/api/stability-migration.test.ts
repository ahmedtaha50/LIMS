/**
 * Roadmap M31 (r2-stability), migration 0240_stability:
 *   * a script built from the migrations (what a restore starts from) creates the tables and seeds nothing;
 *   * the runner installs the ICH Q1A(R2) conditions, the meaning, the two permissions and their grants, and the database's refusals;
 *   * a v0.1.0 installation upgrades with no existing row changed (its stability studies stay as they were: legacy, no link);
 *   * src/db/schema/stability.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import { stabilityStudies } from '../../src/db/schema/equipment';
import * as stability from '../../src/db/schema/stability';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['stability_conditions', 'stability_chambers', 'stability_protocols', 'stability_study_links', 'stability_timepoints'];
const backup = async () => ({ file: 'stability-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0240_stability, in the range reserved for this track (0240 to 0249)', () => {
    const ids = loadMigrations(DIR).map(f => f.id).filter(id => id.includes('stability'));
    expect(ids).toEqual(['0240_stability']);
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('stab-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'STABILITY_PROTOCOL_APPROVAL'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the ICH Q1A(R2) conditions, the meaning, the permissions and the grants', async () => {
    const s = await scratchDb('stab-new');
    await migrate(s.pool, { dir: DIR });
    const conditions = (await s.pool.query(`select code, category, temperature_c::text t, temperature_tolerance_c::text tt, humidity_rh::text h, humidity_tolerance_rh::text ht, status, origin from stability_conditions order by code collate "C"`)).rows;
    expect(conditions.map(c => [c.code, c.category, c.t, c.tt, c.h, c.ht])).toEqual([
      ['ACC-25-60', 'Accelerated', '25', '2', '60', '5'],
      ['ACC-40-75', 'Accelerated', '40', '2', '75', '5'],
      ['INT-30-65', 'Intermediate', '30', '2', '65', '5'],
      ['LT-25-60', 'Long-term', '25', '2', '60', '5'],
      ['LT-30-65', 'Long-term', '30', '2', '65', '5'],
      ['LT-5', 'Long-term', '5', '3', null, null],
      ['LT-M20', 'Long-term', '-20', '5', null, null],
    ]);
    expect(new Set(conditions.map(c => `${c.status}/${c.origin}`))).toEqual(new Set(['Active/installed']));
    const meaning = (await s.pool.query(`select allowed_roles, requires_reason from signature_meanings where code = 'STABILITY_PROTOCOL_APPROVAL'`)).rows;
    expect(meaning).toEqual([{ allowed_roles: ['QA', 'Admin'], requires_reason: false }]);
    const grants = (await s.pool.query(`select role_id || ':' || permission_code as g from role_permissions where permission_code like 'stability.%' and permission_code in ('stability.manage', 'stability.approve') order by (role_id || ':' || permission_code) collate "C"`)).rows.map(r => r.g);
    expect(grants).toEqual(['role-admin:stability.approve', 'role-admin:stability.manage', 'role-qa:stability.approve', 'role-qa:stability.manage', 'role-reviewer:stability.manage']);
    expect((await s.pool.query(`select code, position from permissions where code in ('stability.manage', 'stability.approve') order by position`)).rows)
      .toEqual([{ code: 'stability.manage', position: 240 }, { code: 'stability.approve', position: 241 }]);
  });

  it('refuses what the rules forbid: an unknown status, a window outside 0..60 days, a due date outside its window, a second Draft or Approved revision, one sample on two timepoints', async () => {
    const s = await scratchDb('stab-checks');
    await migrate(s.pool, { dir: DIR });
    const q = (text: string, p: unknown[] = []) => s.pool.query(text, p);
    await q(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA')`);
    await q(`insert into products (id, code, name, status) values ('P1', 'P1', 'Product 1', 'Active')`);
    await q(`insert into product_batches (id, product_id, batch_no, status) values ('B1', 'P1', 'B-1', 'Quarantine')`);
    await expect(q(`insert into stability_conditions (id, code, name, category, temperature_c, temperature_tolerance_c, humidity_rh) values ('C', 'X', 'x', 'Long-term', 25, 2, 60)`)).rejects.toThrow(/stability_conditions_humidity_check/);
    await expect(q(`insert into stability_conditions (id, code, name, category, temperature_c, temperature_tolerance_c) values ('C', 'X', 'x', 'Hot', 25, 2)`)).rejects.toThrow(/stability_conditions_category_check/);
    await expect(q(`insert into stability_conditions (id, code, name, category, temperature_c, temperature_tolerance_c) values ('C', 'lt-25-60', 'x', 'Long-term', 25, 2)`)).rejects.toThrow(/duplicate key/);
    const protocol = (id: string, rev: number, status: string, windowDays = 7) => q(`insert into stability_protocols (id, code, title, product_id, test_plan_code, conditions, month_points, window_days, revision, status) values ($1, 'SP-1', 't', 'P1', 'TP', '[]', '[0]', $2, $3, $4)`, [id, windowDays, rev, status]);
    await expect(protocol('SP-X', 1, 'Draft', 61)).rejects.toThrow(/stability_protocols_window_check/);
    await expect(protocol('SP-X', 1, 'Active')).rejects.toThrow(/stability_protocols_status_check/);
    await protocol('SP-A', 1, 'Approved');
    await expect(protocol('SP-B', 2, 'Approved')).rejects.toThrow(/duplicate key/);
    await protocol('SP-C', 2, 'Draft');
    await expect(protocol('SP-D', 3, 'Draft')).rejects.toThrow(/duplicate key/);
    await q(`insert into stability_studies (id, product, batch, condition, pull_points, start_date, status) values ('STB-1', 'Product 1', 'B-1', 'LT-25-60', '[0]', '2026-01-01', 'Ongoing')`);
    await q(`insert into samples (id, material, batch, state, created_by) values ('S1', 'Product 1', 'B-1', 'Logged', 'u1')`);
    const tp = (id: string, month: number, due: string, status = 'Scheduled', sample: string | null = null) => q(`insert into stability_timepoints (id, study_id, condition_id, condition_code, month, due_date, window_start, window_end, status, sample_id) values ($1, 'STB-1', 'STC-LT-25-60', 'LT-25-60', $2, $3, '2026-01-01', '2026-01-08', $4, $5)`, [id, month, due, status, sample]);
    await expect(tp('T0', 0, '2026-02-01')).rejects.toThrow(/stability_timepoints_window_check/);
    await expect(tp('T0', 0, '2026-01-01', 'Late')).rejects.toThrow(/stability_timepoints_status_check/);
    await tp('T0', 0, '2026-01-01', 'Pulled', 'S1');
    await expect(tp('T0b', 0, '2026-01-01')).rejects.toThrow(/duplicate key/); // the same (study, condition, month) twice
    await expect(tp('T1', 1, '2026-01-01', 'Pulled', 'S1')).rejects.toThrow(/duplicate key/); // one sample, one timepoint
  });

  it('src/db/schema/stability.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('stab-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...stability, stabilityStudies }, drizzle(s.pool) as any, ['public'], ['stability_*'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0240 and changes no existing row; its studies stay legacy studies (no protocol link, no timepoints)', async () => {
    const s = await scratchDb('stab-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0240_stability').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    // the v0.1.0 fixture has no study: one written the v0.1.0 way (free text, fixed pull points)
    await s.pool.query(`insert into stability_studies (id, product, batch, condition, pull_points, start_date, status, version) values ('STB-LEGACY', 'Paracetamol 500 mg', 'B-OLD', '25C/60%RH', '[1,3,6,9,12]', '2025-06-01', 'Ongoing', 3)`);
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from stability_studies t) as studies, (select json_agg(t order by id) from samples t) as samples,
             (select json_agg(t order by id) from results t) as results, (select json_agg(t order by id) from signatures t) as signatures`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0240_stability');
    expect(await frozen()).toBe(rowsBefore);
    expect(JSON.parse(await frozen()).studies).toHaveLength(1);
    expect((await s.pool.query(`select (select count(*) from stability_study_links)::int l, (select count(*) from stability_timepoints)::int t`)).rows[0]).toEqual({ l: 0, t: 0 });
  });
});
