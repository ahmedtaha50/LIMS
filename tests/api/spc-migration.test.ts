/**
 * Roadmap M39 (r3-spc), migration 0320_spc:
 *   * a script built from the migrations (what a restore starts from) creates the tables and seeds nothing;
 *   * the runner installs the meaning, the two permissions and their grants, and the database's refusals hold;
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/spc.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as spc from '../../src/db/schema/spc';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['spc_baselines', 'spc_alerts'];
const backup = async () => ({ file: 'spc-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0320_spc, in the range reserved for this track (0320 to 0329)', () => {
    expect(loadMigrations(DIR).map(f => f.id).filter(id => id.includes('spc'))).toEqual(['0320_spc']);
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('spc-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'SPC_BASELINE_APPROVAL'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meaning, the permissions and the grants', async () => {
    const s = await scratchDb('spc-new');
    await migrate(s.pool, { dir: DIR });
    expect((await s.pool.query(`select allowed_roles, requires_reason from signature_meanings where code = 'SPC_BASELINE_APPROVAL'`)).rows)
      .toEqual([{ allowed_roles: ['QA', 'Admin'], requires_reason: true }]);
    const grants = (await s.pool.query(`select role_id || ':' || permission_code as g from role_permissions where permission_code in ('spc.view', 'spc.manage') order by (role_id || ':' || permission_code) collate "C"`)).rows.map(r => r.g);
    expect(grants).toEqual(['role-admin:spc.manage', 'role-admin:spc.view', 'role-analyst:spc.view', 'role-qa:spc.manage', 'role-qa:spc.view', 'role-reviewer:spc.view']);
    expect((await s.pool.query(`select code, position from permissions where code in ('spc.view', 'spc.manage') order by position`)).rows)
      .toEqual([{ code: 'spc.view', position: 320 }, { code: 'spc.manage', position: 321 }]);
  });

  it('refuses what the rules forbid: a second Approved baseline, a repeated revision, a thin reason, a repeated alert finding', async () => {
    const s = await scratchDb('spc-checks');
    await migrate(s.pool, { dir: DIR });
    const q = (text: string, p: unknown[] = []) => s.pool.query(text, p);
    await q(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA')`);
    await q(`insert into products (id, code, name, status) values ('P1', 'P1', 'Product 1', 'Active')`);
    const base = (id: string, rev: number, status: string, reason = 'Initial limits', ruleSet = 'nelson', n = 20) => q(
      `insert into spc_baselines (id, product_id, parameter, revision, status, rule_set, n, cl, mr_bar, sigma, ucl, lcl, data_from, data_to, result_ids, exclusions, data_hash, reason, created_by)
       values ($1, 'P1', 'Assay', $2, $3, $4, $5, 100, 0.5, 0.44, 101.3, 98.7, now(), now(), '[]', '[]', 'h', $6, 'u1')`, [id, rev, status, ruleSet, n, reason]);
    await expect(base('B0', 1, 'Draft')).rejects.toThrow(/spc_baselines_status_check/);
    await expect(base('B0', 1, 'Approved', 'Initial limits', 'shewhart')).rejects.toThrow(/spc_baselines_rule_set_check/);
    await expect(base('B0', 1, 'Approved', 'x ')).rejects.toThrow(/spc_baselines_reason_check/);
    await expect(base('B0', 1, 'Approved', 'Initial limits', 'nelson', 1)).rejects.toThrow(/spc_baselines_n_check/);
    await base('B1', 1, 'Approved');
    await expect(base('B2', 2, 'Approved')).rejects.toThrow(/duplicate key/); // one Approved baseline per attribute
    await expect(base('B3', 1, 'Superseded')).rejects.toThrow(/duplicate key/); // a revision number is used once
    await base('B4', 2, 'Superseded');
    await q(`insert into samples (id, material, batch, state, created_by) values ('S1', 'Product 1', 'B-1', 'Approved', 'u1')`);
    await q(`insert into results (id, sample_id, parameter, value) values ('R1', 'S1', 'Assay', '100.0')`);
    const alert = (id: string, severity = 'violation') => q(
      `insert into spc_alerts (id, baseline_id, product_id, parameter, result_id, sample_id, batch, rule, severity, value, z, detail, detected_by) values ($1, 'B1', 'P1', 'Assay', 'R1', 'S1', 'B-1', 'N1', $2, 100, 0, 'd', 'u1')`, [id, severity]);
    await expect(alert('A0', 'info')).rejects.toThrow(/spc_alerts_severity_check/);
    await alert('A1');
    await expect(alert('A2')).rejects.toThrow(/duplicate key/);
  });

  it('src/db/schema/spc.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('spc-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...spc }, drizzle(s.pool) as any, ['public'], ['spc_*'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0320 and changes no existing row', async () => {
    const s = await scratchDb('spc-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0320_spc').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0320_spc');
    expect(await frozen()).toBe(rowsBefore);
    expect((await s.pool.query(`select (select count(*) from spc_baselines)::int b, (select count(*) from spc_alerts)::int a`)).rows[0]).toEqual({ b: 0, a: 0 });
  });
});
