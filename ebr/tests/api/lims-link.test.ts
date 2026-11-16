import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// A stand-in LIMS that implements the integration contract of server/lims/client.ts. It can go down, and it can lose
// the answer of a request it did create (the case that makes duplicates in a naive integration).
type S = { id: string; externalRef: string; status: string; result?: unknown };
const lims = { samples: [] as S[], down: false, loseNextAnswer: false, token: 'lims-integration-token' };
function startLims(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (lims.down) { res.writeHead(503).end(); return; }
    if (req.headers.authorization !== `Bearer ${lims.token}`) { res.writeHead(401).end(); return; }
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(lims.samples.filter(s => s.externalRef === url.searchParams.get('externalRef')))); return; }
    let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
      const b = JSON.parse(body) as { externalRef: string };
      const s = { id: `SMP-${lims.samples.length + 1}`, externalRef: b.externalRef, status: 'received' };
      lims.samples.push(s);
      if (lims.loseNextAnswer) { lims.loseNextAnswer = false; req.socket.destroy(); return; }   // created, but the EBR never hears it
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(s));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as AddressInfo).port, close: () => server.close() })));
}

const PW = 'lims link test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>, limsServer: { port: number; close: () => void };
const cookies: Record<string, string> = {};
type R = { status: number; body: any };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string, method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}
async function account(username: string, roles: string[]) {
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ($1, $1, $2, $3, false)', [username, await hashPassword(PW), roles]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
const step = (b: R['body'], seq: number) => b.steps.find((s: { seq: number }) => s.seq === seq);
const rec = (b: R['body'], seq: number) => call('op-l', 'POST', `/api/batches/${b.id}/steps/${step(b, seq).id}/record`, { version: step(b, seq).version, input: {}, password: PW });

let m = '';
beforeAll(async () => {
  db = await freshDatabase('lims'); await migrate(db.pool, MIGRATIONS);
  limsServer = await startLims();
  Object.assign(process.env, { EBR_LIMS_URL: `http://127.0.0.1:${limsServer.port}`, EBR_LIMS_TOKEN: lims.token, EBR_LIMS_TIMEOUT_MS: '2000' });
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-l', ['supervisor']); await account('op-l', ['operator']);
  m = (await db.pool.query<{ id: string }>("INSERT INTO mbr_masters (code, product_name) VALUES ('IPC-1', 'Granules') RETURNING id")).rows[0]!.id;
  await db.pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, 'effective', $2, 'x', 'x')", [m, JSON.stringify({ batchSize: { value: 50, unit: 'kg' }, phases: [{ key: 'drying', label: 'Drying', steps: [{ key: 'lod', label: 'Moisture sample', type: 'sample', test: 'LOD', quantity: 10, unit: 'g' }] }] })]);
});
afterAll(async () => { for (const k of ['EBR_LIMS_URL', 'EBR_LIMS_TOKEN', 'EBR_LIMS_TIMEOUT_MS']) delete process.env[k]; limsServer.close(); await close(); await db.drop(); });

describe('link to the LIMS (E18)', () => {
  it('E18#2: with the LIMS down the step shows the failure and is not recorded; the retry creates exactly one request', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-1' })).body;
    lims.down = true;
    const r = await rec(b, 1);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'lims_unavailable', message: expect.stringMatching(/not recorded and no duplicate request/) });
    expect((await call('op-l', 'GET', `/api/batches/${b.id}`)).body.steps[0].state).toBe('pending');
    lims.down = false;
    const ok = await rec(b, 1);
    expect(ok.status).toBe(200);
    expect(ok.body.steps[0].value).toMatchObject({ externalRef: 'EBR:B-IPC-1:drying.lod', limsSampleId: 'SMP-1', reusedExisting: false });
    expect(lims.samples.filter(s => s.externalRef === 'EBR:B-IPC-1:drying.lod').length).toBe(1);
  });
  it('E18#2: a request the LIMS created but whose answer was lost is found at the retry, not created twice', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-2' })).body;
    lims.loseNextAnswer = true;
    expect((await rec(b, 1)).body.code).toBe('lims_unavailable');
    const ok = await rec(b, 1);
    expect(ok.body.steps[0].value).toMatchObject({ externalRef: 'EBR:B-IPC-2:drying.lod', reusedExisting: true });
    expect(lims.samples.filter(s => s.externalRef === 'EBR:B-IPC-2:drying.lod').length).toBe(1);
  });
  it('E18#1: the LIMS result is shown on the batch only once it is approved there, and kept', async () => {
    const b = (await call('op-l', 'GET', '/api/batches?number=B-IPC-1')).body[0];
    let v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples).toMatchObject([{ test: 'LOD', status: 'received', result: null }]);
    const s = lims.samples.find(x => x.externalRef === 'EBR:B-IPC-1:drying.lod')!;
    Object.assign(s, { status: 'in_review', result: { value: 2.1, unit: '%' } });
    expect((await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body.samples[0]).toMatchObject({ status: 'in_review', result: null });
    Object.assign(s, { status: 'approved' });
    v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples[0]).toMatchObject({ status: 'approved', result: { value: 2.1, unit: '%' } });
    lims.down = true;                                                      // kept on the batch: readable with the LIMS down
    v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples[0]).toMatchObject({ status: 'approved', result: { value: 2.1, unit: '%' } });
    lims.down = false;
  });
  it('a refused integration token is reported as such, not as "down"', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-3' })).body;
    process.env.EBR_LIMS_TOKEN = 'wrong';
    expect((await rec(b, 1)).body.code).toBe('lims_refused');
    process.env.EBR_LIMS_TOKEN = lims.token;
  });
});
