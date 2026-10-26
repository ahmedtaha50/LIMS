/**
 * The application's own connections run in UTC whatever the environment or the database default asks for, and a backup taken
 * and restored on a machine whose zone is Cairo does not move any time.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../../src/server/backup';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { bootDatabase } from '../../src/server/boot';
import { loadMigrations } from '../../src/server/migrate';
import { ROOT, scratchDb, tempDir } from './helpers';

describe('application connections', () => {
  it('are UTC even if PGOPTIONS (the libpq way of saying PGTZ) asks for Cairo', async () => {
    const s = await scratchDb('tzpool');
    Object.assign(process.env, s.env, { PGOPTIONS: '-c timezone=Africa/Cairo' });
    const { createPool } = await import('../../src/db/index');
    const pool = createPool();
    try {
      expect((await pool.query('show timezone')).rows[0].TimeZone).toBe('UTC');
      // Control: a plain node-postgres pool does obey PGOPTIONS, so the UTC above is the application's doing, not an accident.
      expect((await s.pool.query('show timezone')).rows[0].TimeZone).toBe('Africa/Cairo');
    } finally {
      delete process.env.PGOPTIONS;
      await pool.end();
    }
  });
});

describe('backup and restore on a machine in Cairo', () => {
  const originalTz = process.env.TZ;
  afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

  it('moves no timestamp: signatures.timestamp, results.entered_at and samples.created_at come back as the same instants', async () => {
    const source = await scratchDb('cairo-src');
    await bootDatabase({ migrate: true, pool: source.pool, backup: null });
    await source.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'Analyst')`);
    await source.pool.query(`insert into samples (id, material, batch, state, created_by, created_at) values ('S1', 'M', 'B', 'Testing', 'u1', '2026-03-29T00:30:00Z')`); // inside the DST gap of a Cairo-like zone
    await source.pool.query(`insert into results (id, sample_id, parameter, entered_at) values ('R1', 'S1', 'P', '2026-10-13T13:16:51.889Z')`);
    await source.pool.query(`insert into signatures (id, sample_id, signer_id, meaning, reason, timestamp, record_version, content_hash, audit_entry_id)
                             values ('G1', 'S1', 'u1', 'Authorship', 'r', '2026-10-13T13:16:51.889Z', 1, 'h', 'a')`);

    process.env.TZ = 'Africa/Cairo';
    expect(new Date('2026-10-13T13:16:51.889Z').getTimezoneOffset()).toBe(-180); // the process really is in Cairo now

    const dir = tempDir('bplims-cairo');
    const backup = await createBackup(source.pool, 'cairo-backup-passphrase', dir);
    expect(backup.verified).toBe(true);
    const target = await scratchDb('cairo-dst');
    const restored = await restoreBackup(backup.file, 'cairo-backup-passphrase', target.pool, buildSchemaSql(loadMigrations(path.join(ROOT, 'drizzle'))));
    expect(restored).toMatchObject({ chainIntact: true, countsMatch: true });

    const instants = (pool: typeof source.pool) => pool.query(`
      select (select extract(epoch from created_at) from samples where id = 'S1') as sample_created,
             (select extract(epoch from entered_at) from results where id = 'R1') as result_entered,
             (select extract(epoch from timestamp) from signatures where id = 'G1') as signed`);
    expect((await instants(target.pool)).rows[0]).toEqual((await instants(source.pool)).rows[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
