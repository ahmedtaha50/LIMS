/**
 * Roadmap M13 (r1-quality-fixes), migration 0070: what it adds, how it behaves under the three ways a schema is built.
 *
 *   * the installer (the migration runner): structure, the limits and the VERIFICATION meaning are seeded, the history table is guarded;
 *   * a script made from the migrations (what a restore builds before it loads the rows of a backup): structure only, no rows, so
 *     the rows of the backup do not collide with a seed (the failure that r1-esign found in its own first version);
 *   * an installation made by v0.1.0: every instrument and environmental record is kept as it was, with the new columns empty.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../../src/server/backup';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations } from '../../src/server/migrate';
import { ROOT, loadV010, runInitDb, scratchDb, tableExists, tempDir } from '../upgrade/helpers';

const PASSPHRASE = 'quality-fixes-passphrase-123';
const MY_TABLES = ['calibration_history', 'env_limits', 'env_excursions'];

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and the columns and seeds nothing', async () => {
    const s = await scratchDb('qf-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(path.join(ROOT, 'drizzle'))));
    for (const table of MY_TABLES) expect(await tableExists(s.pool, table), table).toBe(true);
    expect((await s.pool.query('select count(*)::int as n from env_limits')).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from signature_meanings where code = 'VERIFICATION'`)).rows[0].n).toBe(0);
    const cols = (t: string) => s.pool.query(`select column_name from information_schema.columns where table_name = $1`, [t]).then(r => r.rows.map(x => x.column_name));
    expect(await cols('instruments')).toContain('version');
    expect(await cols('env_records')).toEqual(expect.arrayContaining(['sample_type', 'limit_alert', 'limit_action']));
  });
});

describe('the installer', () => {
  it('seeds the limits and the meaning, guards the history table, and a backup restores everything it wrote', async () => {
    const source = await scratchDb('qf-source');
    const run = runInitDb(source);
    expect(run.status, run.stderr).toBe(0);
    expect((await source.pool.query('select count(*)::int as n from env_limits')).rows[0].n).toBe(14);
    expect((await source.pool.query(`select allowed_roles, requires_reason, training_exempt, active from signature_meanings where code = 'VERIFICATION'`)).rows)
      .toEqual([{ allowed_roles: ['Reviewer', 'QA', 'Admin'], requires_reason: false, training_exempt: false, active: true }]);

    // The guard is installed by the migration itself and survives the registry's own pass.
    await source.pool.query(`INSERT INTO users (id, uid, name, role, email, password_hash) VALUES ('u-qf', 'qf', 'QF', 'QA', 'qf@example.test', 'x')`);
    await source.pool.query(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INST-QF', 'Balance', 'Weighing', 'Active', '2030-01-01', '2026-01-01')`);
    await source.pool.query(`INSERT INTO calibration_history (id, instrument_id, performed_by, previous_due_date, new_due_date, status_before, status_after, instrument_version, reason) VALUES ('CAL-QF', 'INST-QF', 'u-qf', '2030-01-01', '2031-01-01', 'Active', 'Active', 2, 'Routine')`);
    await expect(source.pool.query(`UPDATE calibration_history SET reason = 'x'`)).rejects.toThrow(/not permitted/);
    await expect(source.pool.query(`DELETE FROM calibration_history`)).rejects.toThrow(/not permitted/);
    await expect(source.pool.query(`TRUNCATE calibration_history`)).rejects.toThrow(/not permitted/);
    await source.pool.query(`INSERT INTO env_records (id, location, grade, date, viable_count, non_viable_count, status, tested_by, sample_type, limit_alert, limit_action) VALUES ('ENV-QF', 'Room', 'Grade A', '2026-02-02', 1, 0, 'Action', 'u-qf', 'Air', NULL, 0)`);
    await source.pool.query(`INSERT INTO env_excursions (id, env_record_id, level, grade, sample_type, viable_count, limit_value, status, opened_by) VALUES ('EXC-QF', 'ENV-QF', 'Action', 'Grade A', 'Air', 1, 0, 'Open', 'u-qf')`);

    const dir = tempDir('qf-bk');
    const backup = await createBackup(source.pool, PASSPHRASE, dir);
    expect(backup.verified).toBe(true);
    const target = await scratchDb('qf-target');
    const restored = await restoreBackup(backup.file, PASSPHRASE, target.pool);
    expect(restored).toMatchObject({ chainIntact: true, countsMatch: true, problems: [] });

    const dump = async (pool: typeof source.pool, q: string) => JSON.stringify((await pool.query(q)).rows);
    for (const q of [
      'select * from env_limits order by id', 'select * from calibration_history order by id', 'select * from env_excursions order by id',
      'select id, version from instruments order by id', 'select id, sample_type, limit_alert, limit_action from env_records order by id',
      `select * from signature_meanings where code = 'VERIFICATION'`,
    ]) expect(await dump(target.pool, q), q).toBe(await dump(source.pool, q));
    await expect(target.pool.query(`DELETE FROM calibration_history`)).rejects.toThrow(/not permitted/);
  }, 120_000);
});

describe('an installation made by v0.1.0', () => {
  it('keeps every instrument and environmental record unchanged; the new columns start at their defaults', async () => {
    const s = await scratchDb('qf-v010');
    await loadV010(s);
    const legacy = async (q: string) => JSON.stringify((await s.pool.query(q)).rows);
    const instrumentsBefore = await legacy('select id, name, type, status, calibration_due_date, last_calibration_date from instruments order by id');
    const envBefore = await legacy('select id, location, grade, date, viable_count, non_viable_count, status, tested_by, version from env_records order by id');
    const stabilityBefore = await legacy('select * from stability_studies order by id');
    const run = runInitDb(s, { MIGRATION_BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: tempDir('qf-up-backups') });
    expect(run.status, run.stderr).toBe(0);

    expect(await legacy('select id, name, type, status, calibration_due_date, last_calibration_date from instruments order by id')).toBe(instrumentsBefore);
    expect(await legacy('select id, location, grade, date, viable_count, non_viable_count, status, tested_by, version from env_records order by id')).toBe(envBefore);
    expect(await legacy('select * from stability_studies order by id')).toBe(stabilityBefore);
    expect((await s.pool.query('select distinct version from instruments')).rows).toEqual([{ version: 1 }]);
    expect((await s.pool.query('select count(*)::int as n from env_records where sample_type is not null or limit_alert is not null or limit_action is not null')).rows[0].n).toBe(0);
    expect((await s.pool.query('select count(*)::int as n from calibration_history')).rows[0].n).toBe(0);
    expect((await s.pool.query('select count(*)::int as n from env_limits')).rows[0].n).toBe(14);
    // The fixture holds a record whose grade a v0.1.0 server stored as "A": it is kept as written, and still readable.
    expect((await s.pool.query(`select grade from env_records where id = 'ENV-fb37397b'`)).rows[0].grade).toBe('A');
  }, 120_000);
});
