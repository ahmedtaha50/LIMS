/**
 * Roadmap M09 (r1-authz): migration 0040 installs the default matrix, and only when the migration runner executes it.
 *
 * A restore builds an empty database from the same SQL (src/server/boot/schemaSql.ts, an empty journal) and then loads the
 * backup's own rows. If the SQL seeded constants there, the backup's rows would collide with them. The seed is therefore guarded
 * by the journal (see the header of drizzle/0040_authz.sql); these tests are the proof that both paths work.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX, PERMISSIONS, ROLE_NAMES, SOD_RULES } from '../../src/lib/permissions';
import { createBackup, restoreBackup } from '../../src/server/backup';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, scratchDb, tempDir } from '../upgrade/helpers';

const DIR = path.join(ROOT, 'drizzle');
const count = async (pool: import('pg').Pool, table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const MATRIX_TABLES = ['roles', 'permissions', 'role_permissions', 'sod_rules', 'user_roles'] as const;
const GRANTS = ROLE_NAMES.reduce((n, r) => n + DEFAULT_MATRIX[r].length, 0);

describe('migration 0040_authz', () => {
  it('is a file of this track, after identity and audit and before the later tracks', () => {
    const ids = loadMigrations(DIR).map(f => f.id);
    expect(ids).toContain('0040_authz');
    expect(ids.indexOf('0040_authz')).toBeGreaterThan(ids.indexOf('0030_audit_v2'));
  });

  it('installs the default matrix when the runner executes it', async () => {
    const s = await scratchDb('authz-run');
    await migrate(s.pool, { dir: DIR });
    expect(await count(s.pool, 'roles')).toBe(ROLE_NAMES.length);
    expect(await count(s.pool, 'permissions')).toBe(PERMISSIONS.length);
    expect(await count(s.pool, 'role_permissions')).toBe(GRANTS);
    expect(await count(s.pool, 'sod_rules')).toBe(SOD_RULES.length);
    expect(await count(s.pool, 'user_roles')).toBe(0);
    // Running the runner again changes nothing.
    await migrate(s.pool, { dir: DIR });
    expect(await count(s.pool, 'role_permissions')).toBe(GRANTS);
  });

  it('creates the structure and no rows when a restore builds the schema from the same SQL', async () => {
    const s = await scratchDb('authz-sql');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of MATRIX_TABLES) expect(await count(s.pool, table), table).toBe(0);
  });

  it('a backup of an installed database restores into a database built that way, matrix included, table by table', async () => {
    const source = await scratchDb('authz-src');
    await migrate(source.pool, { dir: DIR });
    await source.pool.query(
      `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ('usr-a', 'a', 'A', 'Admin', 'a@example.test', 'x', true)`);
    const dir = tempDir('bplims-authz-backup');
    const backup = await createBackup(source.pool, 'authz-test-passphrase-123', dir);

    const target = await scratchDb('authz-restore');
    const result = await restoreBackup(backup.file, 'authz-test-passphrase-123', target.pool, buildSchemaSql(loadMigrations(DIR)));
    expect(result).toMatchObject({ chainIntact: true, countsMatch: true, hashesMatch: true });
    for (const table of MATRIX_TABLES) expect(await count(target.pool, table), table).toBe(await count(source.pool, table));
    const grants = (db: import('pg').Pool) => db.query(`SELECT id FROM role_permissions ORDER BY id`).then(r => r.rows.map(x => x.id));
    expect(await grants(target.pool)).toEqual(await grants(source.pool));
  });

  it('keeps the guards the matrix relies on: one pending request per user, a known status, no duplicate grant', async () => {
    const s = await scratchDb('authz-constraints');
    await migrate(s.pool, { dir: DIR });
    await s.pool.query(`INSERT INTO users (id, uid, name, role, email, password_hash) VALUES ('usr-c', 'c', 'C', 'Analyst', 'c@example.test', 'x')`);
    const insert = (id: string, status: string) => s.pool.query(
      `INSERT INTO user_roles (id, user_id, role_id, previous_role, status, requested_by, request_reason, request_meaning, request_record_version, request_signature_hash)
       VALUES ($1, 'usr-c', 'role-qa', 'Analyst', $2, 'usr-c', 'reason', 'meaning', 1, 'hash')`, [id, status]);
    await insert('urq-1', 'Pending');
    await expect(insert('urq-2', 'Pending')).rejects.toThrow(/user_roles_one_pending_per_user_idx|duplicate key/);
    await expect(insert('urq-3', 'Maybe')).rejects.toThrow(/user_roles_status_check|violates check/);
    await insert('urq-4', 'Rejected'); // history is not limited
    await expect(s.pool.query(`INSERT INTO role_permissions (id, role_id, permission_code) VALUES ('dup', 'role-qa', 'spec.approve')`)).rejects.toThrow(/duplicate key/);
  });
});
