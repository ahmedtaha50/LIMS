import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { builtInTypesReviewed } from '../helpers/builtin.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'interlock test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
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
async function recipe(code: string) {
  const m = (await db.pool.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) RETURNING id', [code, `Product ${code}`])).rows[0]!.id;
  await db.pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, 'effective', $2, 'x', 'x')", [m, JSON.stringify({ batchSize: { value: 100, unit: 'kg' }, phases: [{ key: 'mixing', label: 'Mixing', steps: [
    { key: 'mixer', label: 'Mixer', type: 'equipment', objectKind: 'equipment' },
    { key: 'mix', label: 'Mix 10 minutes', type: 'instruction', text: 'Low speed' }] }] })]);
  return m;
}
const step = (b: R['body'], seq: number) => b.steps.find((s: { seq: number }) => s.seq === seq);
const rec = (who: string, b: R['body'], seq: number, input: Record<string, unknown> = {}) => call(who, 'POST', `/api/batches/${b.id}/steps/${step(b, seq).id}/record`, { version: step(b, seq).version, input, password: PW });
const status = async (id: string) => (await call('op-i', 'GET', `/api/logbooks/${id}`)).body;

let mixer = '', m = '';
beforeAll(async () => {
  db = await freshDatabase('interlock'); await migrate(db.pool, MIGRATIONS); await builtInTypesReviewed(db.pool);   // E28: the QA review at IQ
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-i', ['supervisor']); await account('op-i', ['operator']);
  mixer = (await call('sup-i', 'POST', '/api/logbooks', { typeCode: 'equipment', objectKind: 'equipment', objectCode: 'MIX-201', name: 'Mixer 201' })).body.id;
  m = await recipe('MIXING-1');
});
afterAll(async () => { await close(); await db.drop(); });

describe('equipment interlock (E13)', () => {
  it('E13#1: a step that uses dirty equipment is refused, with the reason', async () => {
    const b = (await call('sup-i', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-MIX-1' })).body;
    const r = await rec('op-i', b, 1, { objectCode: 'MIX-201' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'equipment_not_ready', message: expect.stringMatching(/MIX-201 Mixer 201 is dirty/) });
    expect((await rec('op-i', b, 1, { objectCode: 'MIX-999' })).body.code).toBe('no_logbook');
  });
  it('E13#1: equipment past its calibration due date is refused too', async () => {
    await call('op-i', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'cleaning', values: { method: 'major' }, password: PW });
    await call('op-i', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'calibration', values: { certificate: 'C-1', result: 'pass', next_due: '2020-01-01T00:00:00Z' }, password: PW });
    const b = (await call('sup-i', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-MIX-2' })).body;
    expect((await rec('op-i', b, 1, { objectCode: 'MIX-201' })).body.message).toMatch(/out of calibration \(calibration was due 2020-01-01\)/);
  });
  it('E13#2 and E13#3: using clean equipment writes start and end of use into its logbook; closing the batch leaves it dirty', async () => {
    await call('op-i', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'calibration', values: { certificate: 'C-2', result: 'pass', next_due: '2099-01-01T00:00:00Z' }, password: PW });
    expect((await status(mixer)).derived.status).toBe('clean');
    let b = (await call('sup-i', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-MIX-3' })).body;
    b = (await rec('op-i', b, 1, { objectCode: 'mix-201' })).body;
    expect(b.steps[0].value).toMatchObject({ objectCode: 'MIX-201' });
    let lb = await status(mixer);
    expect(lb.derived.status).toBe('in_use');
    expect(lb.entries.at(-1)).toMatchObject({ kind: 'use_start', values: { product: 'Product MIXING-1', batch: 'B-MIX-3' }, signedBy: 'op-i', meaning: 'performed' });
    // a second batch cannot take the mixer while it is in use
    const other = (await call('sup-i', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-MIX-4' })).body;
    expect((await rec('op-i', other, 1, { objectCode: 'MIX-201' })).body.message).toMatch(/is in use/);
    b = (await rec('op-i', b, 2)).body;
    expect((await call('sup-i', 'POST', `/api/batches/${b.id}/complete`, { version: b.version, password: PW })).body.status).toBe('completed');
    lb = await status(mixer);
    expect(lb.derived.status).toBe('dirty');
    expect(lb.entries.at(-1)).toMatchObject({ kind: 'use_end', values: { batch: 'B-MIX-3' } });
  });
});
