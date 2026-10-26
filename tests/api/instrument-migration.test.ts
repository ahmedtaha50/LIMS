/**
 * Roadmap M21 (r2-instrument-integration), migration 0260_instrument_data: capture profiles, captured files, staged values, result
 * sources and the usage log.
 *
 *   * a script built from the migrations (what a restore starts from): structure only, no meaning or permission row;
 *   * a new installation: the approval meaning, the two permissions and their grants (quality unit only), and the database's own
 *     refusals (append-only tables, the file register that changes only where the file went, approval and decision consistency);
 *   * a v0.1.0 installation upgrades with no existing row changed;
 *   * src/db/schema/instrument-data.ts declares exactly what the migrations build (no drift).
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as instrumentData from '../../src/db/schema/instrument-data';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const TABLES = ['instrument_profiles', 'instrument_profile_revisions', 'instrument_files', 'instrument_import_rows', 'result_sources', 'instrument_usage_log'];
const backup = async () => ({ file: 'instrument-test.bak', sha256: 'a'.repeat(64), verified: true });

describe('the migration file', () => {
  it('is 0260_instrument_data, in the range reserved for this track (0260 to 0269)', () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain('0260_instrument_data');
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('instrument-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'INSTRUMENT_PROFILE_APPROVAL'`)).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from permissions where code like 'instrument.profile.%'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the meaning, the permissions (quality unit only) and the database-level controls', async () => {
    const s = await scratchDb('instrument-new');
    await migrate(s.pool, { dir: DIR });
    const [meaning] = (await s.pool.query(`select allowed_roles, requires_reason, training_exempt from signature_meanings where code = 'INSTRUMENT_PROFILE_APPROVAL'`)).rows;
    expect(meaning).toEqual({ allowed_roles: ['QA', 'Admin'], requires_reason: false, training_exempt: false });
    const grants = (await s.pool.query(`select permission_code, role_id from role_permissions where permission_code like 'instrument.profile.%' order by 1, 2`)).rows;
    expect(grants).toEqual([
      { permission_code: 'instrument.profile.approve', role_id: 'role-admin' }, { permission_code: 'instrument.profile.approve', role_id: 'role-qa' },
      { permission_code: 'instrument.profile.manage', role_id: 'role-admin' }, { permission_code: 'instrument.profile.manage', role_id: 'role-qa' },
    ]);

    const q = (text: string, params: unknown[] = []) => s.pool.query(text, params);
    await q(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'Analyst'), ('u2', 'u2', 'V', 'QA')`);
    await q(`insert into instruments (id, name, type, status, calibration_due_date, last_calibration_date) values ('I1', 'B', 'Balance', 'Active', '2099-01-01', '2026-01-01')`);
    const profile = (id: string, over: Record<string, string> = {}) => q(
      `insert into instrument_profiles (id, instrument_id, name, parser, watch_dir, status, approved_by, created_by) values ($1, 'I1', $1, $2, '/x', $3, $4, 'u1')`,
      [id, over.parser ?? 'generic-csv', over.status ?? 'Draft', over.approvedBy ?? null]);
    await expect(profile('P0', { parser: 'excel' })).rejects.toThrow(/instrument_profiles_parser_check/);
    await expect(profile('P0', { status: 'Active' })).rejects.toThrow(/instrument_profiles_status_check/);
    await expect(profile('P0', { status: 'Approved' })).rejects.toThrow(/instrument_profiles_approval_check/);
    await expect(profile('P0', { approvedBy: 'u2' })).rejects.toThrow(/instrument_profiles_approval_check/);
    await profile('P1');
    await profile('P2', { status: 'Approved', approvedBy: 'u2' });
    await expect(q(`insert into instrument_profiles (id, instrument_id, name, parser, watch_dir, created_by) values ('P3', 'I1', 'P1', 'ph-csv', '/y', 'u1')`)).rejects.toThrow(/instrument_profiles_name_uidx/);

    const file = (id: string, sha: string) => q(
      `insert into instrument_files (id, profile_id, instrument_id, file_name, source, sha256, bytes, parse_status, received_by) values ($1, 'P2', 'I1', 'f.csv', 'watch', $2, 10, 'Parsed', 'u1')`, [id, sha]);
    await expect(file('F0', 'not-a-hash')).rejects.toThrow(/instrument_files_sha256_check/);
    await file('F1', 'a'.repeat(64));
    await expect(file('F2', 'a'.repeat(64))).rejects.toThrow(/instrument_files_sha256_uidx/);
    await q(`insert into instrument_import_rows (id, file_id, line_no, parameter, value) values ('R1', 'F1', 2, 'Assay', '99.0')`);
    await expect(q(`update instrument_import_rows set state = 'Accepted' where id = 'R1'`)).rejects.toThrow(/instrument_import_rows_decision_check/);
    await expect(q(`update instrument_import_rows set state = 'Pending', decided_by = 'u1' where id = 'R1'`)).rejects.toThrow(/instrument_import_rows_decision_check/);
    await q(`update instrument_import_rows set state = 'Rejected', decided_by = 'u1', decided_at = now(), decision_reason = 'no' where id = 'R1'`);
    await q(`insert into instrument_usage_log (id, instrument_id, event, file_id, user_id) values ('U1', 'I1', 'DataCaptured', 'F1', 'u1')`);
    await expect(q(`insert into instrument_usage_log (id, instrument_id, event, user_id) values ('U2', 'I1', 'Used', 'u1')`)).rejects.toThrow(/instrument_usage_log_event_check/);
    await q(`insert into samples (id, material, batch, state, created_by) values ('S1', 'M', 'B', 'Testing', 'u1')`);
    await q(`insert into results (id, sample_id, parameter, value) values ('RES1', 'S1', 'Assay', '99.0')`);
    await expect(q(`insert into result_sources (id, result_id, result_version, source, file_id, import_row_id, sha256, accepted_by) values ('RS0', 'RES1', 2, 'balance', 'F1', 'R1', $1, 'u1')`, ['a'.repeat(64)])).rejects.toThrow(/result_sources_source_check/);
    await q(`insert into result_sources (id, result_id, result_version, source, file_id, import_row_id, sha256, accepted_by) values ('RS1', 'RES1', 2, 'instrument', 'F1', 'R1', $1, 'u1')`, ['a'.repeat(64)]);
    await q(`insert into instrument_profile_revisions (id, profile_id, version, snapshot, changed_by) values ('V1', 'P1', 1, '{}', 'u1')`);

    for (const table of ['instrument_profile_revisions', 'instrument_usage_log', 'result_sources']) {
      await expect(q(`update ${table} set id = id`), table).rejects.toThrow(/append-only/);
      await expect(q(`delete from ${table}`), table).rejects.toThrow(/append-only/);
      await expect(q(`truncate ${table}`), table).rejects.toThrow(/append-only/);
    }
    await expect(q(`delete from instrument_files`)).rejects.toThrow(/only the disposition/);
    await expect(q(`update instrument_files set file_name = 'g.csv'`)).rejects.toThrow(/only the disposition/);
    await q(`update instrument_files set disposition = 'Processed', version = version + 1`);
  });

  it('src/db/schema/instrument-data.ts declares exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('instrument-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...instrumentData }, drizzle(s.pool) as any, ['public'], TABLES)).statementsToExecute;
    expect(statements).toEqual([]);
  });
});

describe('an installation made by v0.1.0', () => {
  it('upgrades through 0260 and changes no existing row', async () => {
    const s = await scratchDb('instrument-v010');
    await loadV010(s);
    const before = loadMigrations(DIR).map(f => f.id).filter(id => id < '0260_instrument_data').pop()!;
    await migrate(s.pool, { dir: DIR, upTo: before, backup });
    const frozen = async () => JSON.stringify((await s.pool.query(`
      select (select json_agg(t order by id) from samples t) as samples, (select json_agg(t order by id) from results t) as results,
             (select json_agg(t order by id) from instruments t) as instruments, (select json_agg(t order by sequence) from audit_trail t where action <> 'SCHEMA_MIGRATED') as audit`)).rows[0]);
    const rowsBefore = await frozen();
    const report = await migrate(s.pool, { dir: DIR, upTo: '0260_instrument_data', backup });
    expect(report.applied.map((a: any) => a.id ?? a)).toContain('0260_instrument_data');
    expect(await frozen()).toBe(rowsBefore);
    for (const table of TABLES) expect((await s.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
  });
});
