/**
 * The running server enforces the schema contract at start-up (roadmap M04 acceptance: "refuses to start on an unknown newer
 * schema"; a database that was not migrated is refused as well, never silently used). Real child processes: the production
 * entry (src/server/obs/entry.ts -> server.ts) against real databases. The server only checks (bootDatabase({ migrate: false })):
 * it never changes the schema of a validated database by merely starting; the installer (init-db) or the migration CLI does.
 */
import { spawn, type ChildProcess } from 'child_process';
import { scryptSync } from 'crypto';
import net from 'net';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootDatabase } from '../../src/server/boot';
import { loadMigrations } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, type Scratch } from './helpers';

const ENTRY = path.join('src', 'server', 'obs', 'entry.ts');
const SECRET = 's'.repeat(48);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

const procs: ChildProcess[] = [];
afterEach(() => { for (const p of procs.splice(0)) p.kill('SIGKILL'); });

function startServer(s: Scratch, port: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: ROOT,
    // Only what the product reads: no PG* variables from the developer's shell.
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '', ...s.env, JWT_SECRET: SECRET, PORT: String(port), DIST_DIR: path.join(ROOT, 'does-not-exist') },
  });
  procs.push(child);
  const log = { out: '' };
  child.stdout!.on('data', d => { log.out += d; });
  child.stderr!.on('data', d => { log.out += d; });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, log, exited };
}

async function waitFor(url: string, exited: Promise<number | null>, ms = 30_000): Promise<Response | null> {
  let done = false;
  void exited.then(() => { done = true; });
  for (const until = Date.now() + ms; Date.now() < until && !done;) {
    try { return await fetch(url); } catch { await sleep(250); }
  }
  return null;
}

describe('server start-up and the schema contract', () => {
  it('refuses to start on a v0.1.0 database that has not been migrated, and says what to run', async () => {
    const s = await scratchDb('start_legacy');
    await loadV010(s);
    const port = await freePort();
    const server = startServer(s, port);
    const code = await Promise.race([server.exited, sleep(40_000).then(() => 'still running' as const)]);
    expect(code, server.log.out).toBe(1);
    expect(server.log.out).toMatch(/v0\.1\.0 installation that has not been migrated/);
    expect(server.log.out).toMatch(/init-db|migrate-cli/);
    // The v0.1.0 database was not touched by the attempt.
    expect((await s.pool.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t).toBeNull();
  }, 60_000);

  it('refuses to start on a database that is empty', async () => {
    const s = await scratchDb('start_empty');
    const server = startServer(s, await freePort());
    const code = await Promise.race([server.exited, sleep(40_000).then(() => 'still running' as const)]);
    expect(code, server.log.out).toBe(1);
    expect(server.log.out).toMatch(/no schema yet/);
  }, 60_000);

  it('refuses to start on a schema that is newer than this build (downgrade guard) and leaves it untouched', async () => {
    const s = await scratchDb('start_newer');
    await bootDatabase({ migrate: true, pool: s.pool, backup: null });
    await s.pool.query(`insert into schema_migrations (id, sha256, app_version) values ('9999_from_a_newer_build', repeat('0', 64), '9.9.9')`);
    const server = startServer(s, await freePort());
    const code = await Promise.race([server.exited, sleep(40_000).then(() => 'still running' as const)]);
    expect(code, server.log.out).toBe(1);
    expect(server.log.out).toMatch(/9999_from_a_newer_build/);
    expect((await s.pool.query('select count(*)::int as n from schema_migrations')).rows[0].n).toBe(loadMigrations().length + 1);
  }, 60_000);

  it('refuses to start when an applied migration file was edited after it was applied', async () => {
    const s = await scratchDb('start_edited');
    await bootDatabase({ migrate: true, pool: s.pool, backup: null });
    await s.pool.query(`update schema_migrations set sha256 = repeat('f', 64) where id = (select min(id) from schema_migrations)`);
    const server = startServer(s, await freePort());
    const code = await Promise.race([server.exited, sleep(40_000).then(() => 'still running' as const)]);
    expect(code, server.log.out).toBe(1);
    expect(server.log.out).toMatch(/CHECKSUM_MISMATCH|checksum/i);
  }, 60_000);

  it('starts on a current database, is ready, and serves GET /api/system/info through the real route table', async () => {
    const s = await scratchDb('start_current');
    await bootDatabase({ migrate: true, pool: s.pool, backup: null });
    // r1-identity: a bearer token is made by signing in. The accounts get a salted scrypt hash (the format of src/db/utils.ts).
    const hash = `scrypt$ab$${scryptSync('a-test-password', 'ab', 64).toString('hex')}`;
    await s.pool.query(`insert into users (id, uid, name, role, email, password_hash) values ('usr-qa', 'usr-qa', 'QA', 'QA', 'qa@example.invalid', $1), ('usr-an', 'usr-an', 'Analyst', 'Analyst', 'an@example.invalid', $1)`, [hash]);
    const port = await freePort();
    const server = startServer(s, port);
    const ready = await waitFor(`http://127.0.0.1:${port}/api/ready`, server.exited);
    expect(ready?.status, server.log.out).toBe(200);

    const signIn = async (email: string) => (await (await fetch(`http://127.0.0.1:${port}/api/auth/login-local`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'a-test-password' }),
    })).json()).token as string;
    const tokens = { 'usr-qa': await signIn('qa@example.invalid'), 'usr-an': await signIn('an@example.invalid') };
    const get = (id?: 'usr-qa' | 'usr-an') => fetch(`http://127.0.0.1:${port}/api/system/info`, { headers: id ? { Authorization: `Bearer ${tokens[id]}` } : {} });
    expect((await get()).status).toBe(401);
    const latest = loadMigrations().at(-1)!.id;
    const analyst = await (await get('usr-an')).json();
    expect(analyst).toMatchObject({ schemaVersion: latest, schemaCurrent: true, databaseTimeZone: 'UTC' });
    expect(analyst).not.toHaveProperty('migrations');
    const qa = await (await get('usr-qa')).json();
    expect(qa.migrations.map((m: { id: string }) => m.id)).toEqual(loadMigrations().map(f => f.id));
    // Starting changed nothing in the journal and wrote no second migration audit entry.
    expect((await s.pool.query(`select count(*)::int as n from audit_trail where action = 'SCHEMA_MIGRATED'`)).rows[0].n).toBe(1);
  }, 90_000);
});
