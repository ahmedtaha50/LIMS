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

// A stand-in for the LIMS machine API (/api/v1), behaving as the LIMS does (src/server/v1 of this repository): a write needs an
// Idempotency-Key, a repeated key replays the stored answer with Idempotent-Replayed: true, the same key with another body is
// a 422, problems are application/problem+json. It can go down, and it can lose the answer of a write it did make (the case
// that makes duplicates in a naive integration). The real contract is checked against docs/api/openapi.json below.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
type S = { id: string; material: string; batch: string; state: string; results: { parameter: string; value: string | null; unit: string | null; isOos: boolean }[] };
const lims = { samples: [] as S[], keys: new Map<string, { body: string; answer: unknown }>(), down: false, loseNextAnswer: false, token: 'lims_abcdefgh_' + 'x'.repeat(43), lastWrite: null as unknown };
const problem = (res: http.ServerResponse, status: number, title: string, detail: string) =>
  res.writeHead(status, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: 'about:blank', title, status, detail }));
const dto = (x: S) => ({ id: x.id, material: x.material, batch: x.batch, state: x.state, specId: null, specRevision: null, createdBy: 'api', createdAt: new Date().toISOString(), version: 1 });
function startLims(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (lims.down) { res.writeHead(503).end(); return; }
    if (req.headers.authorization !== `Bearer ${lims.token}`) { problem(res, 401, 'Unauthorized', 'The API token is missing or not valid.'); return; }
    const url = new URL(req.url!, 'http://x');
    const one = url.pathname.match(/^\/api\/v1\/samples\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const x = lims.samples.find(v => v.id === decodeURIComponent(one[1]!));
      if (!x) { problem(res, 404, 'Not Found', 'Sample does not exist.'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sample: dto(x), results: x.results.map(r => ({ id: `R-${r.parameter}`, ...r, limitKind: null, lower: null, upper: null, decimals: null, acceptanceText: null, instrumentId: null, enteredBy: null })) }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/v1/samples:batch') { problem(res, 404, 'Not Found', 'No such operation.'); return; }
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(key)) { problem(res, 400, 'Bad Request', 'This write needs an Idempotency-Key header.'); return; }
    let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
      lims.lastWrite = JSON.parse(body);
      const seen = lims.keys.get(key);
      if (seen) {
        if (seen.body !== body) { problem(res, 422, 'Unprocessable Content', 'The same Idempotency-Key was used with a different body.'); return; }
        res.writeHead(201, { 'content-type': 'application/json', 'idempotent-replayed': 'true' }).end(JSON.stringify(seen.answer)); return;
      }
      const items = (lims.lastWrite as { items: { material: string; batch: string }[] }).items;
      const made = items.map(i => { const x: S = { id: `SMP-${lims.samples.length + 1}`, material: i.material, batch: i.batch, state: 'Logged', results: [] }; lims.samples.push(x); return x; });
      const answer = { count: made.length, samples: made.map(dto) };
      lims.keys.set(key, { body, answer });
      if (lims.loseNextAnswer) { lims.loseNextAnswer = false; req.socket.destroy(); return; }   // registered, but the EBR never hears it
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as AddressInfo).port, close: () => server.close() })));
}
const forBatch = (batch: string) => lims.samples.filter(x => x.batch === batch);

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

describe('link to the LIMS (E18) over its machine API (E30)', () => {
  it('E30#2 E18#2: with the LIMS down the step shows the failure and is not recorded; the retry creates exactly one request', async () => {
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
    expect(forBatch('B-IPC-1').length).toBe(1);
  });
  it('E30#2 E18#2: a request the LIMS created but whose answer was lost is found at the retry, not created twice', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-2' })).body;
    lims.loseNextAnswer = true;
    expect((await rec(b, 1)).body.code).toBe('lims_unavailable');
    const ok = await rec(b, 1);
    expect(ok.body.steps[0].value).toMatchObject({ externalRef: 'EBR:B-IPC-2:drying.lod', reusedExisting: true });
    expect(forBatch('B-IPC-2').length).toBe(1);                              // the LIMS replayed its stored answer
  });
  it('E30#2 E18#1: the LIMS result is shown on the batch only once it is approved there, and kept', async () => {
    const b = (await call('op-l', 'GET', '/api/batches?number=B-IPC-1')).body[0];
    let v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples).toMatchObject([{ test: 'LOD', status: 'Logged', result: null }]);
    const s = forBatch('B-IPC-1')[0]!;
    Object.assign(s, { state: 'Pending Review', results: [{ parameter: 'LOD', value: '2.1', unit: '%', isOos: false }] });
    expect((await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body.samples[0]).toMatchObject({ status: 'Pending Review', result: null });
    Object.assign(s, { state: 'Approved' });
    v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples[0]).toMatchObject({ status: 'Approved', result: [{ parameter: 'LOD', value: '2.1', unit: '%', outOfSpecification: false }] });
    lims.down = true;                                                      // kept on the batch: readable with the LIMS down
    v = (await call('op-l', 'GET', `/api/batches/${b.id}/lims`)).body;
    expect(v.samples[0]).toMatchObject({ status: 'Approved', result: [{ parameter: 'LOD', value: '2.1' }] });
    lims.down = false;
  });
  it('a refused integration token is reported as such, not as "down"', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-3' })).body;
    process.env.EBR_LIMS_TOKEN = 'wrong';
    expect((await rec(b, 1)).body.code).toBe('lims_refused');
    process.env.EBR_LIMS_TOKEN = lims.token;
  });
  it('E30#1: the sample is registered with POST /api/v1/samples:batch, the EBR reference as Idempotency-Key, a body the LIMS accepts', async () => {
    const b = (await call('sup-l', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-IPC-4' })).body;
    expect((await rec(b, 1)).status).toBe(200);
    expect(lims.keys.has('EBR:B-IPC-4:drying.lod')).toBe(true);
    expect(lims.lastWrite).toEqual({ items: [{ material: 'Granules', batch: 'B-IPC-4' }] });
  });
});

// E30#3: every operation, header and field the EBR uses, against the OpenAPI document the LIMS of this repository publishes
// (generated from its route declarations, so it is the contract the LIMS really serves).
describe('the LIMS machine API contract (E30#3)', () => {
  const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.json', import.meta.url)), 'utf8'));
  const write = spec.paths['/samples:batch']?.post, read = spec.paths['/samples/{sampleId}']?.get;
  const props = (schema: { properties?: Record<string, unknown> }) => Object.keys(schema?.properties ?? {});

  it('E30#3: the API is served at /api/v1 with bearer tokens, and the two operations need samples:write and samples:read', () => {
    expect(spec.servers[0].url).toBe('/api/v1');
    expect(spec.components.securitySchemes.apiToken).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(JSON.stringify(write.security)).toContain('samples:write');
    expect(JSON.stringify(read.security)).toContain('samples:read');
  });
  it('E30#3: the registration takes a required Idempotency-Key and exactly the body the EBR sends, and answers id and state', () => {
    expect(write.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })]));
    const item = write.requestBody.content['application/json'].schema.properties.items.items;
    expect(item.required).toEqual(['material', 'batch']);
    expect(item.additionalProperties).toBe(false);
    for (const k of Object.keys((lims.lastWrite as { items: object[] }).items[0]!)) expect(props(item)).toContain(k);
    const ok = write.responses['201'];
    expect(Object.keys(ok.headers)).toContain('Idempotent-Replayed');
    expect(props(ok.content['application/json'].schema.properties.samples.items)).toEqual(expect.arrayContaining(['id', 'state']));
  });
  it('E30#3: reading a sample answers its state and results with parameter, value, unit and isOos', () => {
    const body = read.responses['200'].content['application/json'].schema.properties;
    expect(props(body.sample)).toEqual(expect.arrayContaining(['id', 'state']));
    expect(body.sample.properties.state.description).toContain('Approved');
    expect(props(body.results.items)).toEqual(expect.arrayContaining(['parameter', 'value', 'unit', 'isOos']));
  });
});

