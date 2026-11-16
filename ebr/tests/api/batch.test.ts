import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf, verifyChain } from '../../server/audit/index.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'batch test password long';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
type R = { status: number; body: any };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string, method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}
async function account(username: string, roles: string[]) {
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ($1, $2, $3, $4, false)', [username, `${username} (name)`, await hashPassword(PW), roles]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
/** An effective recipe written straight into the database (the MBR approval itself is tested in mbr.test.ts). */
async function recipe(code: string, status: string, steps: unknown[]) {
  const m = (await db.pool.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) RETURNING id', [code, `Product ${code}`])).rows[0]!.id;
  await db.pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, $2, $3, 'x', 'x')", [m, status, JSON.stringify({ batchSize: { value: 120, unit: 'kg' }, phases: [{ key: 'granulation', label: 'Granulation', steps }] })]);
  return m;
}
const STEPS = [
  { key: 'clearance', label: 'Line clearance', type: 'verified', text: 'Free of the previous product' },
  { key: 'water', label: 'Water added', type: 'data', unit: 'L', min: 10, max: 14, decimals: 1 },
  { key: 'ratio', label: 'Water per kg', type: 'calculation', formula: 'water / 60', unit: 'L/kg', min: 0.15, max: 0.25, decimals: 3 },
  { key: 'mix', label: 'Mix for 10 minutes', type: 'instruction', text: 'Mix at low speed' },
];
const step = (b: { steps: Array<{ seq: number; id: string; version: number }> }, seq: number) => b.steps.find(s => s.seq === seq)!;
const rec = (who: string, b: R['body'], seq: number, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/api/batches/${b.id}/steps/${step(b, seq).id}/record`, { version: step(b, seq).version, input, password: PW, ...extra });

let pcm = '';
beforeAll(async () => {
  db = await freshDatabase('batch'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-b', ['supervisor']); await account('op-b1', ['operator']); await account('op-b2', ['operator']);
  pcm = await recipe('PCM-500', 'effective', STEPS);
});
afterAll(async () => { await close(); await db.drop(); });

describe('batch creation (E10#1)', () => {
  it('a batch is created only from an effective recipe and keeps that exact version', async () => {
    const draft = await recipe('DRAFT-1', 'draft', STEPS);
    expect((await call('sup-b', 'POST', '/api/batches', { mbrMasterId: draft, batchNumber: 'B-DRAFT-1' })).body.code).toBe('no_effective_mbr');
    const b = await call('sup-b', 'POST', '/api/batches', { mbrMasterId: pcm, batchNumber: 'B-001' });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ status: 'created', mbr: { code: 'PCM-500', versionNo: 1 }, batchSize: { value: 120, unit: 'kg' } });
    expect(b.body.steps.map((s: { stepKey: string }) => s.stepKey)).toEqual(['clearance', 'water', 'ratio', 'mix']);
    expect((await call('sup-b', 'POST', '/api/batches', { mbrMasterId: pcm, batchNumber: 'b-001' })).body.code).toBe('batch_number_taken');
    expect((await call('op-b1', 'POST', '/api/batches', { mbrMasterId: pcm, batchNumber: 'B-OP' })).status).toBe(403);
  });
});

describe('executing a batch (E10#2, E10#3, E11)', () => {
  let b: R['body'];
  it('E10#2: the server refuses a step out of order', async () => {
    b = (await call('sup-b', 'POST', '/api/batches', { mbrMasterId: pcm, batchNumber: 'B-002' })).body;
    const r = await rec('op-b1', b, 2, { value: 12 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'out_of_order', message: 'Not yet: step 1 (Line clearance) comes first.' });
  });
  it('a verified step blocks the next one until a different person verifies it', async () => {
    b = (await rec('op-b1', b, 1)).body;
    expect(b.status).toBe('in_progress');
    expect((await rec('op-b1', b, 2, { value: 12 })).body.message).toMatch(/waits for its verification by a second person/);
    const self = await call('op-b1', 'POST', `/api/batches/${b.id}/steps/${step(b, 1).id}/verify`, { version: step(b, 1).version, password: PW });
    expect(self.body.code).toBe('same_person');
    b = (await call('op-b2', 'POST', `/api/batches/${b.id}/steps/${step(b, 1).id}/verify`, { version: step(b, 1).version, password: PW })).body;
    expect(b.steps[0]).toMatchObject({ performedBy: 'op-b1 (name)', verifiedBy: 'op-b2 (name)' });
  });
  it('E10#3: each value is stored with performer, server time and version; a second tablet with a stale version gets 409', async () => {
    const stale = step(b, 2).version;
    const [first, second] = await Promise.all([rec('op-b1', b, 2, { value: 12.04 }), rec('op-b2', b, 2, { value: 11 })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    b = (first.status === 200 ? first : second).body;
    expect(step(b, 2).version).toBe(stale + 1);
    const s2 = b.steps[1];
    expect(s2.value).toEqual({ value: s2.performedBy === 'op-b1 (name)' ? 12 : 11, unit: 'L' });   // rounded to the recipe's 1 decimal
    expect(Math.abs(Date.parse(s2.performedAt) - Date.now())).toBeLessThan(60_000);
  });
  it('E11#3: a calculated value is computed on the server; a value sent by the client is refused', async () => {
    expect((await rec('op-b1', b, 3, { value: 0.2 })).body.code).toBe('calculated_on_server');
  });
  it('E11#1: a value outside its limits is recorded, raised as an exception at once, and needs a comment', async () => {
    const water = b.steps[1].value.value as number;      // 12 L -> 0.2 L/kg inside, 11 L -> 0.183 inside: make a batch that goes outside
    expect(water).toBeGreaterThan(0);
    const b3 = (await call('sup-b', 'POST', '/api/batches', { mbrMasterId: pcm, batchNumber: 'B-003' })).body;
    let x = (await rec('op-b1', b3, 1)).body;
    x = (await call('op-b2', 'POST', `/api/batches/${x.id}/steps/${step(x, 1).id}/verify`, { version: step(x, 1).version, password: PW })).body;
    const noComment = await rec('op-b1', x, 2, { value: 15.5 });
    expect(noComment.status).toBe(400);
    expect(noComment.body.message).toMatch(/Water added: 15.5 L is outside 10 to 14 L\. A comment is required\./);
    x = (await rec('op-b1', x, 2, { value: 15.5 }, { comment: 'measuring cylinder misread, QA informed' })).body;
    expect(x.exceptions).toMatchObject([{ kind: 'out_of_limits', status: 'open', comment: 'measuring cylinder misread, QA informed' }]);
    // the calculation is outside too (15.5 / 60 = 0.258): a second exception, from the server's own number
    x = (await rec('op-b1', x, 3, {}, { comment: 'follows from the water quantity' })).body;
    expect(x.steps[2].value).toMatchObject({ value: 0.258, unit: 'L/kg' });
    expect(x.exceptions.map((e: { kind: string }) => e.kind)).toEqual(['out_of_limits', 'calculation_out_of_limits']);
    x = (await rec('op-b1', x, 4)).body;
    const blocked = await call('sup-b', 'POST', `/api/batches/${x.id}/complete`, { version: x.version, password: PW });
    expect(blocked.body.code).toBe('not_complete');
    expect(blocked.body.message).toMatch(/2 exception\(s\) open/);
    // E11#2: an exception raised as a deviation keeps its number on the batch
    x = (await call('sup-b', 'POST', `/api/batches/${x.id}/exceptions/${x.exceptions[0].id}/deviation`, { version: 1, deviationNumber: 'DEV-2026-0042', password: PW })).body;
    expect(x.exceptions[0]).toMatchObject({ status: 'closed', deviationNumber: 'DEV-2026-0042' });
    expect((await call('op-b1', 'POST', `/api/batches/${x.id}/exceptions/${x.exceptions[1].id}/close`, { version: 1, note: 'covered by DEV-2026-0042', password: PW })).status).toBe(403);
    x = (await call('sup-b', 'POST', `/api/batches/${x.id}/exceptions/${x.exceptions[1].id}/close`, { version: 1, note: 'consequence of the same error, covered by DEV-2026-0042', password: PW })).body;
    const done = await call('sup-b', 'POST', `/api/batches/${x.id}/complete`, { version: x.version, password: PW });
    expect(done.body.status).toBe('completed');
    expect((await rec('op-b1', done.body, 4)).body.code).toBe('batch_closed');
  });
  it('recorded steps cannot be changed in the database; every action is audited and the chain verifies', async () => {
    await expect(db.pool.query("UPDATE batch_steps SET value = '{\"value\":1}' WHERE state = 'done'")).rejects.toThrow(/is recorded: it cannot change/);
    await expect(db.pool.query('DELETE FROM batch_steps')).rejects.toThrow(/never deleted/);
    const actions = (await auditOf(db.pool, 'batch', b.id)).map(e => e.action);
    expect(actions).toEqual(['batch.created', 'batch.step_recorded', 'batch.step_verified', 'batch.step_recorded']);
    expect(await verifyChain(db.pool)).toMatchObject({ ok: true });
  });
  it('a step type this version cannot record yet is refused with the reason, not skipped', async () => {
    // a type whose handler comes in a later release (sample: r3-lims-link); material and equipment have theirs since R2 wave 2
    const m = await recipe('SAMPLE-1', 'effective', [{ key: 'ipc', label: 'Moisture sample', type: 'sample', test: 'LOD', quantity: 10, unit: 'g' }]);
    const bm = (await call('sup-b', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-SAMPLE-1' })).body;
    expect((await rec('op-b1', bm, 1, {})).body.code).toBe('step_type_not_available');
  });
});
