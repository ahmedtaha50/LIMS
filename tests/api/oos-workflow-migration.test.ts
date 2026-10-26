/**
 * Roadmap M26 (r2-oos-workflow), migration 0210_oos_workflow: the workflow columns of oos_investigations, the settings, the checklist
 * templates, tasks, retest plans and retests, three signature meanings and two permissions.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * a new installation: the settings row (the conservative defaults), two checklist templates, the meanings, the permissions and
 *     their grants, and the database's own refusals (checks, one plan per investigation, append-only plans and retests);
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/oos.ts declares exactly what the migrations build (no drift);
 *   * src/server/oos/protections.ts installs the same append-only triggers as the migration.
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as oos from '../../src/db/schema/oos';
import { oosProtections } from '../../src/server/oos/protections';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['oos_settings', 'oos_checklist_templates', 'oos_tasks', 'oos_retest_plans', 'oos_retests'];
const MEANINGS = ['OOS_INVALIDATION', 'OOS_RETEST_AUTHORISATION', 'OOS_SETTING_CHANGE'];
const backup = async () => ({ file: 'oos-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0210_oos_workflow, in the range reserved for this track', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0210_oos_workflow');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('oosw-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = any($1)`, [MEANINGS])).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the defaults, the templates, the meanings, the permissions and the database-level controls', async () => {
    const s = await scratchDb('oosw-new');
    await migrate(s.pool, { dir: DIR });
    expect((await s.pool.query(`select id, retest_analyst_must_differ, max_retests, phase1_due_days, phase2_due_days, version from oos_settings`)).rows)
      .toEqual([{ id: 'default', retest_analyst_must_differ: true, max_retests: 2, phase1_due_days: 10, phase2_due_days: 30, version: 1 }]);
    const templates = (await s.pool.query(`select code, phase, version, active, jsonb_array_length(items) as n from oos_checklist_templates order by code`)).rows;
    expect(templates.map(r => [r.code, r.phase, r.version, r.active])).toEqual([['OOS-PHASE-I', 'Phase I', 1, true], ['OOS-PHASE-II', 'Phase II', 1, true]]);
    for (const r of templates) expect(r.n).toBeGreaterThanOrEqual(5);

    const meanings = (await s.pool.query(`select code, allowed_roles, requires_reason from signature_meanings where code = any($1) order by code`, [MEANINGS])).rows;
    expect(meanings.map(m => m.code)).toEqual(MEANINGS);
    for (const m of meanings) expect(m.allowed_roles, m.code).toEqual(['QA', 'Admin']);
    expect(meanings.filter(m => m.requires_reason).map(m => m.code)).toEqual(['OOS_INVALIDATION', 'OOS_SETTING_CHANGE']);
    const grants = (await s.pool.query(`select role_id || ':' || permission_code as g from role_permissions where permission_code in ('oos.approve', 'oos.settings') order by 1`)).rows.map(r => r.g);
    expect(grants).toEqual(['role-admin:oos.approve', 'role-admin:oos.settings', 'role-qa:oos.approve', 'role-qa:oos.settings']);

    // the database's own refusals
    const user = (await s.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA') on conflict do nothing returning id`)).rows[0]?.id ?? 'u1';
    await s.pool.query(`insert into samples (id, material, batch, state, created_by) values ('S1', 'M', 'B', 'Testing', $1)`, [user]);
    await s.pool.query(`insert into results (id, sample_id, parameter) values ('R1', 'S1', 'Assay')`);
    await s.pool.query(`insert into oos_investigations (id, sample_id, result_id, parameter, date_raised, status) values ('O1', 'S1', 'R1', 'Assay', '2026-01-01', 'Open')`);
    await expect(s.pool.query(`update oos_settings set max_retests = 0`)).rejects.toThrow(/oos_settings_max_retests_check/);
    await expect(s.pool.query(`insert into oos_tasks (id, oos_id, phase, title, status, created_by) values ('T0', 'O1', 'Phase I', 't', 'Maybe', $1)`, [user])).rejects.toThrow(/oos_tasks_status_check/);
    const planRow = (id: string) => s.pool.query(`insert into oos_retest_plans (id, oos_id, retest_of, basis, justification, max_retests, approved_by) values ($1, 'O1', 'R1', 'Assignable cause', 'j', 2, $2)`, [id, user]);
    await planRow('P1');
    await expect(planRow('P2')).rejects.toThrow(/oos_retest_plans_oos_id_unique|duplicate key/);
    await s.pool.query(`insert into oos_retests (id, plan_id, oos_id, retest_of, seq, value, is_oos, analyst_id, reason) values ('X1', 'P1', 'O1', 'R1', 1, '99', false, $1, 'r')`, [user]);
    await expect(s.pool.query(`insert into oos_retests (id, plan_id, oos_id, retest_of, seq, value, is_oos, analyst_id, reason) values ('X2', 'P1', 'O1', 'R1', 1, '99', false, $1, 'r')`, [user])).rejects.toThrow(/duplicate key/);
    for (const table of ['oos_retests', 'oos_retest_plans']) {
      await expect(s.pool.query(`update ${table} set id = id`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`truncate ${table} cascade`)).rejects.toThrow(/append-only/);
    }
  });

  it('src/db/schema/oos.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('oosw-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...oos }, drizzle(s.pool) as any, ['public'], ['oos_*'])).statementsToExecute;
    expect(statements).toEqual([]);
  });

  it('the protection set installs the same triggers as the migration, and is idempotent', async () => {
    const s = await scratchDb('oosw-protect');
    await migrate(s.pool, { dir: DIR });
    const triggers = async () => (await s.pool.query(`select tgname from pg_trigger where tgname like 'gxp_oos_%' order by 1`)).rows.map(r => r.tgname);
    const before = await triggers();
    expect(before).toEqual(['gxp_oos_retest_plans_row_guard', 'gxp_oos_retest_plans_truncate_guard', 'gxp_oos_retests_row_guard', 'gxp_oos_retests_truncate_guard']);
    for (const st of oosProtections.statements) await s.pool.query(st);
    for (const st of oosProtections.statements) await s.pool.query(st);
    expect(await triggers()).toEqual(before);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0210 and changes no existing row', async () => {
    const s = await scratchDb('oosw-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0210_oos_workflow').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from oos_investigations t) as oos, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from samples t) as samples`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0210_oos_workflow');
    // the new columns are null on the old rows, so the JSON of the old rows only gains keys with null values
    const after = JSON.parse(await frozen());
    const strip = (rows: any[] | null) => (rows ?? []).map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
    const was = JSON.parse(rowsBefore);
    expect(strip(after.oos)).toEqual(strip(was.oos));
    expect(JSON.stringify([after.results, after.signatures, after.samples])).toBe(JSON.stringify([was.results, was.signatures, was.samples]));
  });
});
