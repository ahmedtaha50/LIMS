import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { base32Encode, totp } from '../../server/identity/totp.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'materials test password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
type R = { status: number; body: any };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string, method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}
async function account(username: string, roles: string[]) {
  const secret = base32Encode(Buffer.from(username.padEnd(20, 'm').slice(0, 20)));
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $1, $2, $3, false, $4, true)', [username, await hashPassword(PW), roles, secret]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW, totp: totp(secret) }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
async function recipe(code: string, steps: unknown[], size = 100) {
  const m = (await db.pool.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) RETURNING id', [code, `Product ${code}`])).rows[0]!.id;
  await db.pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, 'effective', $2, 'x', 'x')", [m, JSON.stringify({ batchSize: { value: size, unit: 'kg' }, phases: [{ key: 'dispensing', label: 'Dispensing', steps }] })]);
  return m;
}
const step = (b: R['body'], seq: number) => b.steps.find((s: { seq: number }) => s.seq === seq);
const rec = (who: string, b: R['body'], seq: number, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/api/batches/${b.id}/steps/${step(b, seq).id}/record`, { version: step(b, seq).version, input, password: PW, ...extra });
const API = { key: 'api', label: 'Paracetamol', type: 'material', material: 'RM-PCM', quantity: 60, unit: 'kg', tolerancePct: 0.5 };
const MCC = { key: 'mcc', label: 'Microcrystalline cellulose', type: 'material', material: 'RM-MCC', quantity: 40, unit: 'kg', tolerancePct: 1 };

let released = '';
beforeAll(async () => {
  db = await freshDatabase('materials'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-x', ['supervisor']); await account('op-x', ['operator']); await account('qa-x', ['qa']);
});
afterAll(async () => { await close(); await db.drop(); });

describe('materials and lots', () => {
  it('a lot is received in quarantine and released or rejected only by QA, with a signature', async () => {
    expect((await call('sup-x', 'POST', '/api/materials', { code: 'RM-PCM', name: 'Paracetamol', unit: 'kg' })).status).toBe(201);
    await call('sup-x', 'POST', '/api/materials', { code: 'RM-MCC', name: 'Microcrystalline cellulose', unit: 'kg' });
    const lot = (await call('sup-x', 'POST', '/api/materials/RM-PCM/lots', { lotNumber: 'PCM-2601', expiry: '2030-12-31' })).body;
    expect(lot.status).toBe('quarantine');
    expect((await call('sup-x', 'POST', `/api/material-lots/${lot.id}/release`, { version: 1, password: PW })).status).toBe(403);
    expect((await call('qa-x', 'POST', `/api/material-lots/${lot.id}/release`, { version: 1, password: PW })).body.status).toBe('released');
    released = lot.lotNumber;
    await call('sup-x', 'POST', '/api/materials/RM-PCM/lots', { lotNumber: 'PCM-QUAR', expiry: '2030-12-31' });
    const old = (await call('sup-x', 'POST', '/api/materials/RM-PCM/lots', { lotNumber: 'PCM-OLD', expiry: '2020-01-31' })).body;
    await call('qa-x', 'POST', `/api/material-lots/${old.id}/release`, { version: 1, password: PW });
    const mcc = (await call('sup-x', 'POST', '/api/materials/RM-MCC/lots', { lotNumber: 'MCC-2601', expiry: '2031-01-31' })).body;
    await call('qa-x', 'POST', `/api/material-lots/${mcc.id}/release`, { version: 1, password: PW });
  });
});

describe('dispensing (E12)', () => {
  let b: R['body'];
  it('E12#1: a material step accepts a lot only when it is the right material, released and not expired', async () => {
    const m = await recipe('DISP-1', [API, MCC]);
    b = (await call('sup-x', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-DISP-1' })).body;
    expect((await rec('op-x', b, 1, { lot: 'NOPE-1', weight: 60 })).body.code).toBe('unknown_lot');
    expect((await rec('op-x', b, 1, { lot: 'MCC-2601', weight: 60 })).body).toMatchObject({ code: 'wrong_material', message: expect.stringMatching(/is RM-MCC, not RM-PCM/) });
    expect((await rec('op-x', b, 1, { lot: 'PCM-QUAR', weight: 60 })).body.code).toBe('lot_not_released');
    expect((await rec('op-x', b, 1, { lot: 'PCM-OLD', weight: 60 })).body).toMatchObject({ code: 'lot_expired', message: expect.stringMatching(/expired on 2020-01-31/) });
    const ok = await rec('op-x', b, 1, { lot: released.toLowerCase(), weight: 60.12 });
    expect(ok.status).toBe(200);
    expect(ok.body.steps[0].value).toMatchObject({ material: 'RM-PCM', lot: 'PCM-2601', weight: 60.12, target: 60 });
    expect(ok.body.exceptions).toEqual([]);
    b = ok.body;
  });
  it('E12#2: a weight outside its tolerance is an exception (with a comment)', async () => {
    const r = await rec('op-x', b, 2, { lot: 'MCC-2601', weight: 41 });
    expect(r.body).toMatchObject({ code: 'comment_required', message: expect.stringMatching(/41 kg is outside 40 kg ± 1% \(39.6 to 40.4\)/) });
    b = (await rec('op-x', b, 2, { lot: 'MCC-2601', weight: 41 }, { comment: 'balance overshoot, excess kept aside' })).body;
    expect(b.exceptions).toMatchObject([{ kind: 'out_of_tolerance', status: 'open' }]);
  });
  it('E12#3: yield and reconciliation are calculated at the end; differences beyond limits are exceptions; the batch does not close without them', async () => {
    await call('sup-x', 'POST', `/api/batches/${b.id}/exceptions/${b.exceptions[0].id}/close`, { version: 1, note: 'excess returned to the warehouse, label checked', password: PW });
    const before = (await call('sup-x', 'GET', `/api/batches/${b.id}`)).body;
    expect((await call('sup-x', 'POST', `/api/batches/${b.id}/complete`, { version: before.version, password: PW })).body.code).toBe('reconciliation_required');
    const r = await call('sup-x', 'POST', `/api/batches/${b.id}/reconcile`, { outputQuantity: 92, password: PW });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ yieldPct: 92, theoretical: 100 });
    expect(r.body.materials).toEqual(expect.arrayContaining([expect.objectContaining({ material: 'RM-MCC', dispensed: 41, target: 40, differencePct: 2.5 })]));
    expect(r.body.exceptions.map((e: { kind: string }) => e.kind).sort()).toEqual(['reconciliation_difference', 'yield_out_of_limits']);
    expect((await call('sup-x', 'POST', `/api/batches/${b.id}/reconcile`, { outputQuantity: 99, password: PW })).body.code).toBe('already_reconciled');
    const after = (await call('sup-x', 'GET', `/api/batches/${b.id}`)).body;
    expect(after.exceptions.filter((e: { status: string }) => e.status === 'open').length).toBe(2);
    expect((await call('sup-x', 'POST', `/api/batches/${b.id}/complete`, { version: after.version, password: PW })).body.code).toBe('not_complete');
    for (const e of after.exceptions.filter((x: { status: string }) => x.status === 'open')) await call('sup-x', 'POST', `/api/batches/${b.id}/exceptions/${e.id}/deviation`, { version: 1, deviationNumber: 'DEV-2026-0101', password: PW });
    const v = (await call('sup-x', 'GET', `/api/batches/${b.id}`)).body.version;
    expect((await call('sup-x', 'POST', `/api/batches/${b.id}/complete`, { version: v, password: PW })).body.status).toBe('completed');
  });
});
