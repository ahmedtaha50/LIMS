/**
 * Roadmap M20 (r2-raw-data), migration 0120_raw_data: result versions, the attachment register and review checklists.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no meaning, permission or version row;
 *   * a new installation: the reintegration meaning, the permission and its grants, and the database's own refusals
 *     (append-only tables, coded reasons only, a sha256 that is a sha256);
 *   * a v0.1.0 installation upgrades with no existing row changed, and every result that holds a value gets its first version
 *     (code MIGRATED), so the history of a result starts at the value it had at the upgrade;
 *   * src/db/schema/rawdata.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as rawdata from '../../src/db/schema/rawdata';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['result_versions', 'attachments', 'review_checklists'];
const backup = async () => ({ file: 'rawdata-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0120_raw_data, in the range the roadmap reserves for this track (drizzle/012*)', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0120_raw_data');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('rawdata-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'REINTEGRATION_APPROVAL'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code = 'result.reintegration.approve'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meaning, the permission (quality unit only) and the database-level controls', async () => {
    const s = await scratchDb('rawdata-new');
    await migrate(s.pool, { dir: DIR });
    const [meaning] = (await s.pool.query(`select allowed_roles, requires_reason, training_exempt from signature_meanings where code = 'REINTEGRATION_APPROVAL'`)).rows;
    expect(meaning).toEqual({ allowed_roles: ['QA', 'Admin'], requires_reason: true, training_exempt: false });
    const grants = (await s.pool.query(`select role_id from role_permissions where permission_code = 'result.reintegration.approve' order by 1`)).rows;
    expect(grants.map(g => g.role_id)).toEqual(['role-admin', 'role-qa']);

    const user = (await s.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'Analyst') returning id`)).rows[0].id;
    await s.pool.query(`insert into samples (id, material, batch, state, created_by) values ('S1', 'M', 'B', 'Testing', $1)`, [user]);
    await s.pool.query(`insert into results (id, sample_id, parameter, value) values ('R1', 'S1', 'Assay', '99.0')`);
    const version = (code: string, id = 'V1') => s.pool.query(
      `insert into result_versions (id, result_id, sample_id, result_version, value, is_oos, change_code, reason, entered_by)
       values ($1, 'R1', 'S1', 2, '99.0', false, $2, 'entry', $3)`, [id, code, user]);
    await expect(version('BECAUSE_I_SAID_SO')).rejects.toThrow(/result_versions_change_code_check/);
    await version('INITIAL_ENTRY');
    await expect(version('TRANSCRIPTION_ERROR', 'V2')).rejects.toThrow(/result_versions_result_version_uidx/);

    const attach = (sha: string, id = 'A1') => s.pool.query(
      `insert into attachments (id, sample_id, file_name, media_type, kind, bytes, sha256, uploaded_by) values ($1, 'S1', 'f.pdf', 'application/pdf', 'pdf', 4, $2, $3)`, [id, sha, user]);
    await expect(attach('not-a-hash')).rejects.toThrow(/attachments_sha256_check/);
    await attach('a'.repeat(64));
    await s.pool.query(`insert into review_checklists (id, sample_id, sample_version, items, attestations, server_items_passed, recorded_by)
      values ('C1', 'S1', 3, '[]', '{}', true, $1)`, [user]);

    for (const table of TABLES) {
      await expect(s.pool.query(`update ${table} set id = id`), table).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`delete from ${table}`), table).rejects.toThrow(/append-only/);
      await expect(s.pool.query(`truncate ${table}`), table).rejects.toThrow(/append-only/);
    }
  });

  it('src/db/schema/rawdata.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('rawdata-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...rawdata }, drizzle(s.pool) as any, ['public'], TABLES)).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0120, changes no existing row, and gives every entered result its first version', async () => {
    const s = await scratchDb('rawdata-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0120_raw_data').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from signatures t) as signatures, (select json_agg(t order by sequence) from audit_trail t where action <> 'SCHEMA_MIGRATED') as audit`)).rows[0]);
    const rowsBefore = await frozen();
    const entered = (await s.pool.query(`select id, sample_id, version, value, is_oos, entered_by from results where value is not null and value <> '' order by id`)).rows;
    expect(entered.length).toBeGreaterThan(0);

    const report = await migrate(s.pool, { dir: DIR, upTo: '0120_raw_data', backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0120_raw_data');
    expect(await frozen()).toBe(rowsBefore);

    const versions = (await s.pool.query(`select result_id, sample_id, result_version, value, is_oos, change_code, entered_by from result_versions order by result_id`)).rows;
    expect(versions).toEqual(entered.map(r => ({
      result_id: r.id, sample_id: r.sample_id, result_version: r.version, value: r.value, is_oos: r.is_oos, change_code: 'MIGRATED', entered_by: r.entered_by,
    })));
    expect((await s.pool.query(`select count(*)::int as n from attachments`)).rows[0].n).toBe(0);
  });
});
