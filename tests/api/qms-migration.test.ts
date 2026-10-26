/**
 * Roadmap M27 (r2-qms), migration 0180_qms: the QMS tables, the change-control setting (off), seven signature meanings and the qms
 * permissions.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no seeded rows;
 *   * a new installation: the meanings, the permissions and their grants, the setting row (off), and the database's own refusals
 *     (classification and type checks, one automatic record per source, append-only links, comments and checks);
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/qms.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as qms from '../../src/db/schema/qms';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['qms_records', 'qms_actions', 'qms_links', 'qms_comments', 'qms_effectiveness_checks', 'qms_settings'];
const MEANINGS = ['QMS_ACTION_COMPLETION', 'QMS_APPROVAL', 'QMS_CLOSURE', 'QMS_EFFECTIVENESS', 'QMS_EMERGENCY_CHANGE', 'QMS_REJECTION', 'QMS_SETTING_CHANGE'];
const backup = async () => ({ file: 'qms-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0180_qms, in the range the roadmap reserves for the QMS', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0180_qms');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('qms-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code like 'QMS_%'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code like 'qms.%'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meanings, the permissions, the setting (off) and the database-level controls', async () => {
    const s = await scratchDb('qms-new');
    await migrate(s.pool, { dir: DIR });
    const meanings = (await s.pool.query(`select code, allowed_roles, requires_reason from signature_meanings where code like 'QMS_%' order by code`)).rows;
    expect(meanings.map(m => m.code)).toEqual(MEANINGS);
    expect(meanings.find(m => m.code === 'QMS_ACTION_COMPLETION').allowed_roles).toEqual(['Analyst', 'Reviewer', 'QA', 'Admin']);
    for (const m of meanings.filter(m => m.code !== 'QMS_ACTION_COMPLETION')) expect(m.allowed_roles, m.code).toEqual(['QA', 'Admin']);
    expect(meanings.filter(m => m.requires_reason).map(m => m.code)).toEqual(['QMS_CLOSURE', 'QMS_EMERGENCY_CHANGE', 'QMS_REJECTION', 'QMS_SETTING_CHANGE']);

    const grants = (await s.pool.query(`select role_id, permission_code from role_permissions where permission_code like 'qms.%' order by 1, 2`)).rows;
    expect(grants.map(g => `${g.role_id}:${g.permission_code}`)).toEqual([
      'role-admin:qms.approve', 'role-admin:qms.create', 'role-admin:qms.edit', 'role-admin:qms.settings', 'role-admin:qms.view',
      'role-analyst:qms.create', 'role-analyst:qms.edit', 'role-analyst:qms.view',
      'role-qa:qms.approve', 'role-qa:qms.create', 'role-qa:qms.edit', 'role-qa:qms.settings', 'role-qa:qms.view',
      'role-reviewer:qms.create', 'role-reviewer:qms.edit', 'role-reviewer:qms.view',
    ]);
    expect((await s.pool.query(`select id, change_control_required, version from qms_settings`)).rows).toEqual([{ id: 'default', change_control_required: false, version: 1 }]);

    const user = (await s.pool.query(`select id from users limit 1`)).rows[0]?.id
      ?? (await s.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'QA') returning id`)).rows[0].id;
    const rec = (id: string, extra = '') => s.pool.query(`insert into qms_records (id, type, title, state, created_by${extra ? ', origin, source_type, source_id' : ''}) values ($1, 'Deviation', 't', 'Draft', $2${extra})`, [id, user]);
    await rec('DEV-1');
    await expect(s.pool.query(`insert into qms_records (id, type, title, state, created_by) values ('X-1', 'Complaint', 't', 'Draft', $1)`, [user])).rejects.toThrow(/qms_records_type_check/);
    await expect(s.pool.query(`update qms_records set classification = 'Severe' where id = 'DEV-1'`)).rejects.toThrow(/qms_records_classification_check/);
    // One automatic record per source and type.
    await rec('DEV-2', `, 'auto:oos-confirmed', 'OOS', 'OOS-1'`);
    await expect(rec('DEV-3', `, 'auto:oos-confirmed', 'OOS', 'OOS-1'`)).rejects.toThrow(/qms_records_auto_source_uidx/);
    // Append-only.
    await s.pool.query(`insert into qms_links (id, record_id, relation, target_type, target_id, created_by) values ('L1', 'DEV-1', 'related', 'Batch', 'B1', $1)`, [user]);
    await s.pool.query(`insert into qms_comments (id, record_id, author_id, text) values ('C1', 'DEV-1', $1, 'x')`, [user]);
    await s.pool.query(`insert into qms_effectiveness_checks (id, record_id, result, evidence, record_version, checked_by) values ('E1', 'DEV-1', 'Effective', 'x', 1, $1)`, [user]);
    for (const table of ['qms_links', 'qms_comments', 'qms_effectiveness_checks']) {
      await expect(s.pool.query(`update ${table} set id = id`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`delete from ${table}`)).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`truncate ${table}`)).rejects.toThrow(/append-only/);
    }
  });

  it('src/db/schema/qms.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('qms-drift');
    await migrate(s.pool, { dir: DIR });
    // Only the qms_* tables: other tracks' tables of the same wave may be built by their migrations before their schema is exported.
    const statements = (await pushSchema({ ...qms }, drizzle(s.pool) as any, ['public'], ['qms_*'])).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0180 and changes no existing row', async () => {
    const s = await scratchDb('qms-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0180_qms').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by id) from specifications t) as specs,
             (select json_agg(t order by id) from users t) as users`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0180_qms');
    expect(await frozen()).toBe(rowsBefore);
    expect((await s.pool.query(`select count(*)::int as n from qms_records`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select change_control_required from qms_settings`)).rows).toEqual([{ change_control_required: false }]);
  });
});
