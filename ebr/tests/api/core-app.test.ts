import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/core/config.js';
import { createPool, withTx } from '../../server/core/db.js';
import { route } from '../../server/core/route.js';
import { strict } from '../../server/core/validate.js';
import { startApp } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('the application', () => {
  it('health answers from the database, with server time and the migrations applied', async () => {
    const r = await app.call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.migrations).toBeGreaterThan(0);
    expect(Math.abs(Date.parse(r.body.serverTime) - Date.now())).toBeLessThan(60_000);
  });

  it('an unknown route is a JSON 404 with a request id, never an HTML page', async () => {
    const r = await app.call('GET', '/api/nothing-here');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'not_found', requestId: r.headers.get('x-request-id') });
  });
});

describe('fails closed and validates strictly', () => {
  const routes = [
    route({ method: 'POST', path: '/api/things', permission: 'things.create', summary: 'create', input: strict({ name: z.string().min(1) }), handler: ({ input }) => ({ name: input.name }) }),
    route({ method: 'POST', path: '/api/open', permission: 'public', summary: 'open', input: strict({ name: z.string().min(1) }), status: 201, handler: ({ input }) => ({ name: input.name }) }),
    route({ method: 'GET', path: '/api/boom', permission: 'public', summary: 'boom', handler: () => { throw new Error('secret internals'); } }),
  ];
  let t: Awaited<ReturnType<typeof listen>>;
  async function listen(authorize?: Parameters<typeof createApp>[0]['authorize']) {
    const db = await freshDatabase('closed');
    const logs: string[] = [];
    const server = createApp({ pool: db.pool, routes, log: (l) => logs.push(l), ...(authorize ? { authorize } : {}) }).listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const call = async (method: string, path: string, body?: string) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) }); return { status: res.status, body: (await res.json()) as any }; };   // eslint-disable-line @typescript-eslint/no-explicit-any
    return { call, logs, close: async () => { await new Promise<void>(r => server.close(() => r())); await db.drop(); } };
  }
  beforeAll(async () => { t = await listen(); });
  afterAll(async () => { await t.close(); });

  it('without an authorizer, a route that is not public answers 401', async () => {
    expect((await t.call('POST', '/api/things', '{"name":"x"}')).status).toBe(401);
  });
  it('an authorized user without the permission gets 403', async () => {
    const u = await listen(async () => ({ userId: '1', username: 'op', permissions: new Set(['other']) }));
    try { expect((await u.call('POST', '/api/things', '{"name":"x"}')).status).toBe(403); expect((await u.call('POST', '/api/things', '{"name":"x"}')).body.code).toBe('forbidden'); } finally { await u.close(); }
  });
  it('an unknown field is refused, not dropped (AGENTS.md rule 9)', async () => {
    const r = await t.call('POST', '/api/open', '{"name":"x","createdBy":"someone-else"}');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_input');
    expect((await t.call('POST', '/api/open', '{"name":"x"}')).status).toBe(201);
  });
  it('broken JSON is a 400 with its cause', async () => {
    expect((await t.call('POST', '/api/open', '{"name":')).body.code).toBe('invalid_json');
  });
  it('an unexpected error is logged with the request id and the client sees no internals', async () => {
    const r = await t.call('GET', '/api/boom');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret internals/);
    expect(t.logs.some(l => l.includes(r.body.requestId) && l.includes('secret internals'))).toBe(true);
  });
});

describe('core helpers', () => {
  it('withTx rolls back everything when the work fails half-way (the basis of "audit entry in the same transaction")', async () => {
    const d = await freshDatabase('tx');
    try {
      await d.pool.query('CREATE TABLE t (v int)');
      await expect(withTx(d.pool, async (c) => { await c.query('INSERT INTO t VALUES (1)'); throw new Error('second write failed'); })).rejects.toThrow('second write failed');
      expect((await d.pool.query('SELECT count(*)::int AS n FROM t')).rows[0].n).toBe(0);
      await withTx(d.pool, async (c) => { await c.query('INSERT INTO t VALUES (1)'); });
      expect((await d.pool.query('SELECT count(*)::int AS n FROM t')).rows[0].n).toBe(1);
    } finally { await d.drop(); }
  });
  it('a configuration error names the variable', () => {
    expect(() => loadConfig({ PORT: 'x' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: '99999' })).toThrow(/PORT/);
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).PORT).toBe(4100);
  });
  it('the pool survives the database being dropped under an idle connection (it reports, it does not crash)', async () => {
    const d = await freshDatabase('drop');
    const lost: string[] = [];
    const other = createPool(d.url, 1, (e) => lost.push(e.message));
    await other.query('SELECT 1');                 // one idle connection stays open in the pool
    await d.drop();                                // DROP DATABASE ... WITH (FORCE) terminates it
    for (let i = 0; i < 50 && !lost.length; i++) await new Promise(r => setTimeout(r, 50));
    expect(lost.length).toBe(1);
    await other.end();
  });
});
