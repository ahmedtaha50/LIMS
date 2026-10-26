/**
 * Acceptance (M14): a database full of attachments backs up with a flat memory profile (target: peak RSS under 300 MB for 5 GB).
 * Opt-in because it needs minutes and disk:   BACKUP_SCALE_MB=2048 npx vitest run tests/api/backup-scale.test.ts
 *
 * The attachment text goes into results.attachment_data, built inside PostgreSQL (about 1 MB of incompressible-looking hex
 * per row). The backup, its verification and a restore into an empty database each run in their own child process so that
 * its peak RSS (process.resourceUsage().maxRSS) is measured in isolation; the restored database must hash identically.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootDatabase } from '../../src/server/boot';
import { ROOT, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const MB = Number(process.env.BACKUP_SCALE_MB || 0);
const LIMIT_MB = 300;

const CHILD = `
import pg from 'pg';
import { createBackup, restoreBackup, verifyBackup } from ${JSON.stringify(path.join(ROOT, 'src/server/backup.ts'))};
const cfg = (database) => ({ host: process.env.SQL_HOST, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, database });
const mode = process.env.MODE;
const out = {};
if (mode === 'backup') {
  const pool = new pg.Pool(cfg(process.env.SRC_DB));
  const t0 = Date.now(); const b = await createBackup(pool, 'scale-test-passphrase', process.env.OUT_DIR);
  Object.assign(out, { file: b.file, bytes: b.bytes, verified: b.verified, seconds: (Date.now() - t0) / 1000 });
  await pool.end();
} else if (mode === 'verify') {
  const r = await verifyBackup(process.env.FILE, 'scale-test-passphrase'); out.ok = r.ok;
} else {
  const pool = new pg.Pool(cfg(process.env.DST_DB));
  const r = await restoreBackup(process.env.FILE, 'scale-test-passphrase', pool); Object.assign(out, r);
  await pool.end();
}
out.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
console.log(JSON.stringify(out));
`;

describe.skipIf(!MB)(`backup of a ${MB} MB attachment database`, () => {
  let src: Scratch;
  beforeAll(async () => {
    src = await scratchDb('scale-src');
    await bootDatabase({ migrate: true, pool: src.pool, dir: path.join(ROOT, 'drizzle'), backup: null });
    await src.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U', 'Analyst')`);
    await src.pool.query(`insert into samples (id, material, batch, state, created_by) values ('S0', 'M', 'B', 'Testing', 'u1')`);
    for (let done = 0; done < MB; done += 50) {            // 50 rows of about 1 MB per statement
      await src.pool.query(`insert into results (id, sample_id, parameter, attachment_name, attachment_data)
                            select 'R' || ($1::int + g), 'S0', 'P', 'a.bin', (select string_agg(md5(random()::text || h), '') from generate_series(1, 32768) h) from generate_series(1, 50) g`, [done]);
    }
  }, 3_600_000);

  // Asynchronous: a synchronous child would block the worker for minutes and Vitest would lose contact with it.
  const run = async (env: Record<string, string>) => {
    const r = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', CHILD], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...src.env, ...env } });
    expect(r.stderr).toBe('');
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  it('backs up, verifies and restores with peak RSS under 300 MB and an identical result', async () => {
    const dir = tempDir('bplims-scale');
    const b = await run({ MODE: 'backup', SRC_DB: src.name, OUT_DIR: dir });
    console.log(`backup: ${(b.bytes / 1e6).toFixed(0)} MB file in ${b.seconds} s, peak RSS ${b.peakRssMb} MB`);
    expect(b.verified).toBe(true);
    expect(b.peakRssMb).toBeLessThan(LIMIT_MB);

    const v = await run({ MODE: 'verify', FILE: b.file });
    console.log(`verify: peak RSS ${v.peakRssMb} MB`);
    expect(v.ok).toBe(true);
    expect(v.peakRssMb).toBeLessThan(LIMIT_MB);

    const dst = await scratchDb('scale-dst');
    const r = await run({ MODE: 'restore', FILE: b.file, DST_DB: dst.name });
    console.log(`restore: peak RSS ${r.peakRssMb} MB`);
    expect(r).toMatchObject({ chainIntact: true, countsMatch: true, hashesMatch: true });
    expect(r.peakRssMb).toBeLessThan(LIMIT_MB);
    const sum = (p: Scratch['pool']) => p.query(`select count(*)::int as n, md5(string_agg(md5(attachment_data), '' order by id)) as h from results`);
    expect((await sum(dst.pool)).rows[0]).toEqual((await sum(src.pool)).rows[0]);
  }, 3_600_000);
});
