/**
 * Roadmap M07 (r1-esign), backup and restore: the catalog of signature meanings and the new signature columns survive a backup
 * and a restore into an empty database. A restore builds the structure by replaying the migrations and then loads the rows of the
 * backup, so a migration that seeds rows on a replay makes every restore fail with a duplicate key (found by the first full run).
 */
import { describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../../src/server/backup';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations } from '../../src/server/migrate';
import { ROOT, runInitDb, scratchDb, tempDir } from '../upgrade/helpers';
import path from 'path';

const PASSPHRASE = 'esign-backup-passphrase-123';

describe('signature_meanings and a restore', () => {
  it('a script built from the migrations creates the structure and no catalog rows', async () => {
    const s = await scratchDb('esign-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(path.join(ROOT, 'drizzle'))));
    expect((await s.pool.query('select count(*)::int as n from signature_meanings')).rows[0].n).toBe(0);
    expect((await s.pool.query(`select count(*)::int as n from information_schema.columns where table_name = 'signatures' and column_name = 'entity_type'`)).rows[0].n).toBe(1);
  });

  it('the installer seeds the catalog, and a backup restores into an empty database with exactly the same catalog and signatures', async () => {
    const source = await scratchDb('esign-source');
    const run = runInitDb(source);
    expect(run.status, run.stderr).toBe(0);
    const seeded = (await source.pool.query('select count(*)::int as n from signature_meanings')).rows[0].n;
    expect(seeded).toBeGreaterThanOrEqual(12);
    // One signature with every new column, so the restore has something to carry.
    await source.pool.query(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-BK', 'm', 1, '2026-01-01', 'Active', '[]')`);
    await source.pool.query(
      `INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id, entity_type, entity_id, meaning_code, signer_name, signer_role, auth_method, hash_version)
       VALUES ('sig-bk', NULL, 'u', 'text', 'why', 2, $1, 'adt-1', 'Specification', 'SPEC-BK', 'SPECIFICATION_APPROVAL', 'Name', 'QA', 'password+totp', 2)`, ['a'.repeat(64)]);

    const dir = tempDir('esign-bk');
    const backup = await createBackup(source.pool, PASSPHRASE, dir);
    expect(backup.verified).toBe(true);

    const target = await scratchDb('esign-target');
    const restored = await restoreBackup(backup.file, PASSPHRASE, target.pool);
    expect(restored).toMatchObject({ chainIntact: true, countsMatch: true, problems: [] });

    const dump = async (pool: typeof source.pool, q: string) => JSON.stringify((await pool.query(q)).rows);
    for (const q of [
      'select * from signature_meanings order by code',
      `select id, sample_id, meaning, record_version, content_hash, audit_entry_id, entity_type, entity_id, meaning_code, signer_name, signer_role, auth_method, hash_version from signatures order by id`,
    ]) expect(await dump(target.pool, q), q).toBe(await dump(source.pool, q));
  });
});
