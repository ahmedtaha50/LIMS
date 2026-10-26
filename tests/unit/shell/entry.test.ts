/**
 * M02/M03: the production entry point validates its configuration before it does anything else, prints one
 * readable error and exits, is production unless told otherwise, and listens on loopback only by default.
 * Real child processes against the real server code.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '../../helpers/testDb';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join('src', 'server', 'obs', 'entry.ts');

function run(env: Record<string, string>, ms = 20_000) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: ROOT,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('production entry', () => {
  let sql: Record<string, string>;
  const procs: Array<ReturnType<typeof spawn>> = [];
  afterEach(() => { for (const p of procs.splice(0)) p.kill('SIGKILL'); });

  beforeAll(async () => {
    const db = await useTestDb();
    sql = { SQL_HOST: process.env.SQL_HOST!, SQL_USER: process.env.SQL_USER!, SQL_PASSWORD: process.env.SQL_PASSWORD!, SQL_DB_NAME: db.name };
  });

  const secret = 'e'.repeat(48);

  it('exits 1 with one readable message for a malformed PORT', async () => {
    const r = await run({ ...sql, JWT_SECRET: secret, PORT: 'abc' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PORT/);
    expect(r.out).toMatch(/invalid configuration/i);
    expect(r.out).not.toMatch(/\n\s+at /);       // no stack trace
    expect(r.out.trim().split('\n').length).toBeLessThanOrEqual(8);
  });

  it('is production by default, so a missing JWT_SECRET is fatal instead of falling back to a public one', async () => {
    const r = await run({ ...sql, PORT: String(await freePort()) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/JWT_SECRET/);
  });

  it('refuses a LAN bind address without LIMS_BIND_LAN', async () => {
    const r = await run({ ...sql, JWT_SECRET: secret, HOST: '0.0.0.0', PORT: String(await freePort()) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/LIMS_BIND_LAN/);
  });

  it('listens on loopback only by default and answers /api/health', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: ROOT,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '', ...sql, JWT_SECRET: secret, PORT: String(port), DIST_DIR: path.join(ROOT, 'does-not-exist'), LOG_LEVEL: 'warn' },
    });
    procs.push(child);
    let health: Response | null = null;
    for (let i = 0; i < 120 && !health; i++) {
      try { health = await fetch(`http://127.0.0.1:${port}/api/health`); } catch { await sleep(250); }
    }
    expect(health?.status).toBe(200);
    // The port must be bound to 127.0.0.1 only, not to every interface (Linux: the kernel's table of listening sockets).
    if (process.platform === 'linux') {
      const hex = port.toString(16).toUpperCase().padStart(4, '0');
      const listening = ['/proc/net/tcp', '/proc/net/tcp6']
        .flatMap(f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(1) : []))
        .map(l => l.trim().split(/\s+/))
        .filter(c => c[3] === '0A' && c[1]?.endsWith(':' + hex))
        .map(c => c[1].split(':')[0]);
      expect(listening).toEqual(['0100007F']); // 127.0.0.1 only
    }
    const ready = await fetch(`http://127.0.0.1:${port}/api/ready`);
    expect(ready.status).toBe(200);
  }, 60_000);
});
