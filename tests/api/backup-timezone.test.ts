/**
 * Acceptance (M14): under TZ=Africa/Cairo, backup then restore leaves signatures.timestamp, results.entered_at and
 * samples.created_at byte-identical.
 *
 * The backup and the restore run in a child process whose clock, PG session zone and libpq options are all Cairo, which is
 * what a lab PC looks like. "Byte-identical" is compared as the text PostgreSQL prints in a UTC session, microseconds
 * included: the v1 backup read these columns through a JavaScript Date (milliseconds only, local-time parsing of naive values).
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootDatabase } from '../../src/server/boot';
import { ROOT, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const CHILD = `
import pg from 'pg';
import { createBackup, restoreBackup, verifyBackup } from ${JSON.stringify(path.join(ROOT, 'src/server/backup.ts'))};
const cfg = (database) => ({ host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, database });
const src = new pg.Pool(cfg(process.env.SRC_DB)), dst = new pg.Pool(cfg(process.env.DST_DB));
const zone = (await src.query('show timezone')).rows[0].TimeZone;
const b = await createBackup(src, 'cairo-backup-passphrase', process.env.OUT_DIR);
const v = await verifyBackup(b.file, 'cairo-backup-passphrase');
const r = await restoreBackup(b.file, 'cairo-backup-passphrase', dst);
console.log(JSON.stringify({ offset: new Date('2026-10-13T13:16:51Z').getTimezoneOffset(), zone, verified: b.verified && v.ok, r }));
await src.end(); await dst.end();
`;

const COLUMNS = `
  select (select string_agg(created_at::text, '|' order by id) from samples) as sample_created_at,
         (select string_agg(entered_at::text, '|' order by id) from results) as result_entered_at,
         (select string_agg(timestamp::text, '|' order by id) from signatures) as signature_timestamp,
         (select string_agg(timestamp::text || timestamp_str, '|' order by sequence) from audit_trail) as audit_timestamps`;

let src: Scratch;
beforeAll(async () => {
  src = await scratchDb('tz-src');
  await bootDatabase({ migrate: true, pool: src.pool, dir: path.join(ROOT, 'drizzle'), backup: null });
  await src.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'Analyst')`);
  await src.pool.query(`insert into samples (id, material, batch, state, created_by, created_at) values
    ('S1', 'M', 'B', 'Testing', 'u1', '2026-03-29 00:30:00.000001+00'),   -- inside the spring-forward gap of a Cairo-like zone
    ('S2', 'M', 'B', 'Testing', 'u1', '2026-10-13 13:16:51.889123+00')`);
  await src.pool.query(`insert into results (id, sample_id, parameter, entered_at) values ('R1', 'S1', 'P', '2026-10-13 13:16:51.889123+00'), ('R2', 'S2', 'P', '2026-10-30 22:59:59.999999+00')`);
  await src.pool.query(`insert into signatures (id, sample_id, signer_id, meaning, reason, timestamp, record_version, content_hash, audit_entry_id)
                        values ('G1', 'S1', 'u1', 'Authorship', 'r', '2026-10-13 13:16:51.889123+00', 1, 'h', 'a'), ('G2', 'S2', 'u1', 'Approval', 'r', '2026-12-31 23:59:59.000001+00', 1, 'h', 'a')`);
});

describe('backup then restore on a PC whose clock is Cairo', () => {
  it('leaves signatures.timestamp, results.entered_at and samples.created_at byte-identical (microseconds included)', async () => {
    const dst = await scratchDb('tz-dst');
    const out = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', CHILD], {
      cwd: ROOT, encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        TZ: 'Africa/Cairo', PGTZ: 'Africa/Cairo', PGOPTIONS: '-c timezone=Africa/Cairo',
        ...src.env, SRC_DB: src.name, DST_DB: dst.name, OUT_DIR: tempDir('bplims-tz'),
      },
    });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    const result = JSON.parse(out.stdout.trim().split('\n').pop()!);
    expect(result.offset).toBe(-180);                  // the child really ran in Cairo (UTC+3 in October)
    expect(result.zone).toBe('Africa/Cairo');           // ... and so did its PostgreSQL session
    expect(result.verified).toBe(true);
    expect(result.r).toMatchObject({ chainIntact: true, countsMatch: true });

    const read = async (pool: Scratch['pool']) => {
      const c = await pool.connect();
      try { await c.query("set time zone 'UTC'"); return (await c.query(COLUMNS)).rows[0]; } finally { c.release(); }
    };
    const before = await read(src.pool);
    const after = await read(dst.pool);
    expect(before.sample_created_at).toBe('2026-03-29 00:30:00.000001+00|2026-10-13 13:16:51.889123+00');
    expect(after).toEqual(before);
  });
});
