import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { verifyChain } from '../../server/audit/index.js';
import { fillDemo } from '../../server/demo/index.js';
import { authorizer, bootstrapAdmin } from '../../server/identity/index.js';
import { assertReady } from '../../server/interlock/index.js';
import { logbookDetail } from '../../server/logbook/service.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// E33: one command fills an empty installation with demo data, through the services and signatures people use.
const PW = 'demo accounts password';
let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeAll(async () => {
  db = await freshDatabase('demo'); await migrate(db.pool, MIGRATIONS);
  await bootstrapAdmin(db.pool, 'siteadmin', 'first administrator password');            // an installation as delivered
});
afterAll(async () => { await db.drop(); });

describe('demo installation (E33)', () => {
  it('E33#1: a weak password is refused before anything is written', async () => {
    await expect(fillDemo(db.pool, 'short')).rejects.toMatchObject({ code: 'weak_password' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  it('E33#1: it fills an empty installation: accounts for every role, ready equipment, released lots, an effective recipe', async () => {
    const r = await fillDemo(db.pool, PW);
    expect(r).toEqual({ accounts: ['demo-operator', 'demo-operator2', 'demo-supervisor', 'demo-qa'], logbooks: ['MIX-01', 'BAL-01', 'RM-101'], lots: ['PCM-2601', 'STA-2601'], recipe: 'PCM-500' });
    const lb = (await db.pool.query("SELECT id, type_id, object_code, name, status FROM logbooks WHERE object_code = 'MIX-01'")).rows[0];
    expect((await logbookDetail(db.pool, lb.id)).derived.status).toBe('clean');
    await expect(assertReady(db.pool, lb)).resolves.toBeUndefined();                       // usable in a batch (E13, E28)
    expect((await db.pool.query("SELECT status FROM material_lots ORDER BY lot_number")).rows.map(x => x.status)).toEqual(['released', 'released']);
    expect((await db.pool.query("SELECT v.status FROM mbr_versions v JOIN mbr_masters m ON m.id = v.master_id WHERE m.code = 'PCM-500'")).rows[0].status).toBe('effective');
  });

  it('E33#1: everything is signed by the demo accounts themselves and the audit chain verifies', async () => {
    const sigs = (await db.pool.query<{ meaning: string; signer_name: string; entity: string }>('SELECT meaning, signer_name, entity FROM signatures ORDER BY id')).rows;
    expect(sigs.filter(s => s.entity === 'logbook_type_version').map(s => `${s.meaning}:${s.signer_name}`)).toEqual(['reviewed:demo-qa', 'reviewed:demo-qa']);
    expect(sigs.filter(s => s.entity === 'mbr_version').map(s => `${s.meaning}:${s.signer_name}`)).toEqual(['authored:demo-supervisor', 'approved:demo-qa', 'approved:demo-qa']);
    expect(sigs.filter(s => s.entity === 'logbook_entry').every(s => s.signer_name === 'demo-operator')).toBe(true);
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });

  it('E33#1: it refuses a database that already holds records', async () => {
    await expect(fillDemo(db.pool, PW)).rejects.toMatchObject({ code: 'not_empty' });
  });

  it('E33#1: the supervisor signs in with the demo password and creates a batch from the demo recipe', async () => {
    const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
    await new Promise<void>(res => server.once('listening', () => res()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-supervisor', password: PW }) });
      expect(login.status).toBe(200);
      const cookie = `ebr_session=${(login.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]}`;
      const m = (await (await fetch(base + '/api/mbrs', { headers: { cookie } })).json()).find((x: { code: string }) => x.code === 'PCM-500');
      const b = await fetch(base + '/api/batches', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mbrMasterId: m.id, batchNumber: 'DEMO-0001' }) });
      expect(b.status).toBe(201);
      expect((await b.json()).steps).toHaveLength(7);
    } finally { await new Promise<void>(res => server.close(() => res())); }
  });

  it('E33#2: the run guide names commands, scripts and files that exist', () => {
    const ROOT = fileURLToPath(new URL('../..', import.meta.url));
    const guide = readFileSync(ROOT + 'README.md', 'utf8');
    const scripts = Object.keys(JSON.parse(readFileSync(ROOT + 'package.json', 'utf8')).scripts as Record<string, string>);
    const named = [...guide.matchAll(/npm run ([a-z:-]+)/g)].map(m => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter(n => !scripts.includes(n))).toEqual([]);
    const files = [...new Set([...guide.matchAll(/(?:deploy|validation|dist\/server)\/[A-Za-z0-9_./\\-]+\.(?:yml|example|ps1|sh|cjs|js|conf)/g)].map(m => m[0].replace(/\\/g, '/')))];
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter(f => !existsSync(ROOT + f.replace(/^dist\/server\/(.*)\.js$/, 'server/$1.ts')))).toEqual([]);
    for (const step of ['PCM-500', 'demo-operator2', 'Check a certified copy', 'Verify the chain']) expect(guide).toContain(step);
  });
});

