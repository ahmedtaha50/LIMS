import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf } from '../../server/audit/index.js';
import { authorizer } from '../../server/identity/index.js';
import { hashPassword } from '../../server/identity/password.js';
import { base32Encode, totp } from '../../server/identity/totp.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const PW = 'review test password ok';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
type R = { status: number; body: any; headers: Headers };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string, method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
async function account(username: string, roles: string[]) {
  const secret = base32Encode(Buffer.from(username.padEnd(20, 'r').slice(0, 20)));
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $1, $2, $3, false, $4, true)', [username, await hashPassword(PW), roles, secret]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW, totp: totp(secret) }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}
const step = (b: R['body'], seq: number) => b.steps.find((s: { seq: number }) => s.seq === seq);
const rec = (who: string, b: R['body'], seq: number, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/api/batches/${b.id}/steps/${step(b, seq).id}/record`, { version: step(b, seq).version, input, password: PW, ...extra });

let batch: R['body'];
beforeAll(async () => {
  db = await freshDatabase('review'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-r', ['supervisor']); await account('op-r', ['operator']); await account('qa-r', ['qa']);
  const m = (await db.pool.query<{ id: string }>("INSERT INTO mbr_masters (code, product_name) VALUES ('REV-1', 'Review product') RETURNING id")).rows[0]!.id;
  await db.pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, 'effective', $2, 'x', 'x')", [m, JSON.stringify({ batchSize: { value: 10, unit: 'kg' }, phases: [{ key: 'p', label: 'Phase', steps: [
    { key: 'ph', label: 'pH', type: 'data', unit: 'pH', min: 6, max: 7, decimals: 1 },
    { key: 'note', label: 'Inspect', type: 'instruction', text: 'Look' },
    { key: 'sign', label: 'End of phase', type: 'signature', text: 'Sign' }] }] })]);
  let b = (await call('sup-r', 'POST', '/api/batches', { mbrMasterId: m, batchNumber: 'B-REV-1' })).body;
  b = (await rec('op-r', b, 1, { value: 7.4 }, { comment: 'probe recalibrated, value confirmed' })).body;
  b = (await rec('op-r', b, 2, {}, { comment: 'slight discolouration at the edge, photo in the logbook' })).body;
  b = (await rec('op-r', b, 3)).body;
  batch = b;
});
afterAll(async () => { await close(); await db.drop(); });

describe('review by exception (E14)', () => {
  it('a batch is reviewed only once it is completed', async () => {
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/review`)).body.code).toBe('batch_state');
    expect((await call('sup-r', 'POST', `/api/batches/${batch.id}/review`)).status).toBe(403);
  });
  it('E14#1: the review lists the exceptions and the comments, and nothing else', async () => {
    await call('sup-r', 'POST', `/api/batches/${batch.id}/exceptions/${batch.exceptions[0].id}/deviation`, { version: 1, deviationNumber: 'DEV-2026-0200', password: PW });
    const v = (await call('sup-r', 'GET', `/api/batches/${batch.id}`)).body.version;
    expect((await call('sup-r', 'POST', `/api/batches/${batch.id}/complete`, { version: v, password: PW })).body.status).toBe('completed');
    const r = await call('qa-r', 'POST', `/api/batches/${batch.id}/review`);
    expect(r.status).toBe(201);
    expect(r.body.items.map((i: { kind: string }) => i.kind)).toEqual(['exception', 'comment']);
    expect(r.body.items[0].text).toMatch(/pH: 7.4 pH is outside 6 to 7 pH.*Deviation DEV-2026-0200/);
    expect(r.body.items[1].text).toMatch(/slight discolouration/);
  });
  it('E14#2 and E14#3: the review completes only when every item is signed as reviewed; each action is audited', async () => {
    let r = (await call('qa-r', 'GET', `/api/batches/${batch.id}/review`)).body;
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/review/complete`, { version: r.review.version, password: PW })).body).toMatchObject({ code: 'review_not_complete', message: '2 item(s) not reviewed.' });
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/review/items/${r.items[0].id}`, { password: 'wrong one' })).status).toBe(401);
    for (const i of r.items) await call('qa-r', 'POST', `/api/batches/${batch.id}/review/items/${i.id}`, { password: PW, note: 'assessed, no impact on quality' });
    r = (await call('qa-r', 'GET', `/api/batches/${batch.id}/review`)).body;
    expect(r.items.every((i: { acknowledgedBy: string }) => i.acknowledgedBy === 'qa-r')).toBe(true);
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/release`, { password: PW })).body.code).toBe('review_not_complete');
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/review/complete`, { version: r.review.version, password: PW })).body.review.status).toBe('complete');
    const actions = (await auditOf(db.pool, 'batch', batch.id)).map(e => e.action);
    expect(actions.filter(a => a === 'batch.review_item').length).toBe(2);
    expect(actions).toContain('batch.review_completed');
    const sigs = (await call('qa-r', 'GET', `/api/signatures?entity=batch_review&entityId=${batch.id}`)).body;
    expect(sigs).toMatchObject([{ meaning: 'reviewed', signerName: 'qa-r' }]);
  });
});

describe('disposition and certified copy (E15)', () => {
  let pdf: Buffer;
  it('E15#1: release needs a QA signature (not a supervisor) and is final', async () => {
    expect((await call('sup-r', 'POST', `/api/batches/${batch.id}/release`, { password: PW })).status).toBe(403);
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/release`, { password: 'nope' })).status).toBe(401);
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/release`, { password: PW, comment: 'meets specification' })).body.disposition).toMatchObject({ decision: 'released', decidedBy: 'qa-r' });
    expect((await call('sup-r', 'GET', `/api/batches/${batch.id}`)).body.status).toBe('released');
    expect((await call('qa-r', 'POST', `/api/batches/${batch.id}/reject`, { password: PW, comment: 'changed my mind' })).body.code).toBe('review_not_complete');
    await expect(db.pool.query("UPDATE batch_dispositions SET decision = 'rejected'")).rejects.toThrow(/never changed or deleted/);
  });
  it('E15#2: the certified copy holds the values, signatures, exceptions, review, disposition and the audit trail', async () => {
    const r = await call('op-r', 'GET', `/api/batches/${batch.id}/certified-copy`);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    pdf = r.body as Buffer;
    const text = pdf.toString('latin1');
    for (const s of ['B-REV-1', 'Recipe REV-1 version 1', '7.4', 'performed by op-r', 'DEV-2026-0200', 'REVIEW BY EXCEPTION', 'RELEASED by qa-r', 'AUDIT TRAIL', 'batch.released']) expect(text, s).toContain(s);
    expect(r.headers.get('x-certified-copy-sha256')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('E15#3: the system recognises its own copy, and a changed copy is not genuine', async () => {
    const ok = await call('op-r', 'POST', '/api/certified-copies/verify', { pdfBase64: pdf.toString('base64') });
    expect(ok.body).toMatchObject({ genuine: true, batchNumber: 'B-REV-1' });
    const forged = Buffer.from(pdf.toString('latin1').replace('7.4', '6.4'), 'latin1');
    expect((await call('op-r', 'POST', '/api/certified-copies/verify', { pdfBase64: forged.toString('base64') })).body.genuine).toBe(false);
  });
});
