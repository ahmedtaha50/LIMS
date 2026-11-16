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
import { assertReady } from '../../server/interlock/index.js';

const PW = 'builtin review password';
let db: Awaited<ReturnType<typeof freshDatabase>>, base = '', close: () => Promise<void>;
const cookies: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `ebr_session=${cookies[who]}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
}
async function account(username: string, roles: string[]) {
  const secret = base32Encode(Buffer.from(username.padEnd(20, 'y').slice(0, 20)));
  await db.pool.query('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $1, $2, $3, false, $4, true)', [username, await hashPassword(PW), roles, secret]);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW, totp: totp(secret) }) });
  cookies[username] = (r.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
}

const EQUIPMENT = '00000000-0000-4000-8000-000000000e01';
let mixer = '', v1 = '';
beforeAll(async () => {
  db = await freshDatabase('lbreview'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('sup-b', ['supervisor']); await account('qa-b', ['qa']); await account('op-b', ['operator']);
  mixer = (await call('sup-b', 'POST', '/api/logbooks', { typeCode: 'equipment', objectKind: 'equipment', objectCode: 'MIX-R5', name: 'Mixer R5' })).body.id;
  v1 = (await call('qa-b', 'GET', '/api/logbook-types')).body.find((t: { id: string }) => t.id === EQUIPMENT).versions[0].id;
});
afterAll(async () => { await close(); await db.drop(); });

describe('QA review of the built-in logbook types (E28)', () => {
  it('E28#1: a fresh installation shows both built-in types waiting for the QA review, and refuses entries with them', async () => {
    const types = (await call('op-b', 'GET', '/api/logbook-types')).body.filter((t: { builtIn: boolean }) => t.builtIn);
    expect(types.map((t: { code: string; versions: { needsQaReview: boolean }[] }) => [t.code, t.versions[0]!.needsQaReview])).toEqual([['equipment', true], ['room', true]]);
    const w = await call('op-b', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'cleaning', values: { method: 'major', agent: 'Detergent D' }, password: PW });
    expect(w.status).toBe(409);
    expect(w.body.code).toBe('type_not_reviewed');
    expect(w.body.message).toMatch(/Equipment logbook.*not been reviewed by QA/);
    const lbv = (await db.pool.query<{ id: string }>('SELECT id FROM logbook_type_versions WHERE id = $1', [v1])).rows[0]!.id;
    await expect(db.pool.query(`INSERT INTO logbook_entries (logbook_id, type_version_id, kind, "values", flags, author_id, author_name, recorded_at)
      VALUES ($1, $2, 'cleaning', '{}', '[]', 'x', 'x', now())`, [mixer, lbv])).rejects.toThrow(/waits for its QA review/);
  });

  it('E28#2: equipment cannot be used in a batch before its logbook type is reviewed, and the reason says so', async () => {
    const lb = (await db.pool.query('SELECT id, type_id, object_code, name, status FROM logbooks WHERE id = $1', [mixer])).rows[0];
    await expect(assertReady(db.pool, lb)).rejects.toMatchObject({ code: 'type_not_reviewed' });
  });

  it('E28#1: only QA reviews, with a password and a remark; afterwards the logbook is written to', async () => {
    const path = `/api/logbook-types/${EQUIPMENT}/versions/${v1}/qa-review`;
    expect((await call('sup-b', 'POST', path, { password: PW, comment: 'definition checked at IQ' })).status).toBe(403);
    expect((await call('qa-b', 'POST', path, { password: 'wrong', comment: 'definition checked at IQ' })).status).toBe(401);
    expect((await call('qa-b', 'POST', path, { password: PW, comment: 'ok' })).status).toBe(400);
    const r = await call('qa-b', 'POST', path, { password: PW, comment: 'definition checked against SOP-EQ-002 at IQ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ versionNo: 1, qaReviewedBy: 'qa-b' });
    expect((await call('qa-b', 'POST', path, { password: PW, comment: 'a second time' })).body.code).toBe('no_review_needed');
    expect((await call('op-b', 'POST', `/api/logbooks/${mixer}/entries`, { kind: 'cleaning', values: { method: 'major', agent: 'Detergent D' }, password: PW })).status).toBe(201);
  });

  it('E28#3: the review is signed (meaning reviewed), audited and shown with the type; the room type still waits', async () => {
    const sigs = (await call('qa-b', 'GET', `/api/signatures?entity=logbook_type_version&entityId=${v1}`)).body;
    expect(sigs.map((s: { meaning: string; signerName: string }) => `${s.meaning}:${s.signerName}`)).toEqual(['reviewed:qa-b']);
    const a = await auditOf(db.pool, 'logbook_type', EQUIPMENT);
    expect(a.filter(e => e.action === 'logbook_type.qa_reviewed').map(e => e.reason)).toEqual(['definition checked against SOP-EQ-002 at IQ']);
    const types = (await call('op-b', 'GET', '/api/logbook-types')).body;
    expect(types.find((t: { code: string }) => t.code === 'equipment').versions[0]).toMatchObject({ needsQaReview: false, qaReviewedBy: 'qa-b' });
    expect(types.find((t: { code: string }) => t.code === 'room').versions[0]).toMatchObject({ needsQaReview: true, qaReviewedBy: null });
  });
});
