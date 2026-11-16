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

const PW = 'audit review test password';
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

beforeAll(async () => {
  db = await freshDatabase('auditreview'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('qa-a', ['qa']); await account('sup-a', ['supervisor']); await account('op-a', ['operator']);
  await call('sup-a', 'POST', '/api/mbrs', { code: 'AUD-1', productName: 'Audit product', design: { batchSize: { value: 1, unit: 'kg' }, phases: [{ key: 'p', label: 'P', steps: [{ key: 's', label: 'S', type: 'instruction', text: 'x' }] }] } });
  await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op-a', password: 'wrong password' }) });
});
afterAll(async () => { await close(); await db.drop(); });

describe('audit trail review in the application (E32#3)', () => {
  it('E32#3: QA lists the latest entries, newest first, and filters by record, action, user and period', async () => {
    const all = (await call('qa-a', 'GET', '/api/audit/recent')).body;
    expect(all.length).toBeGreaterThan(2);
    expect(Number(all[0].id)).toBeGreaterThan(Number(all[all.length - 1].id));
    const mbr = (await call('qa-a', 'GET', '/api/audit/recent?entity=mbr')).body;
    expect(mbr.map((e: { action: string }) => e.action)).toEqual(['mbr.created']);
    expect((await call('qa-a', 'GET', `/api/audit/recent?entity=mbr&entityId=${mbr[0].entityId}`)).body).toHaveLength(1);
    expect((await call('qa-a', 'GET', '/api/audit/recent?action=auth.failed')).body.map((e: { actorName: string }) => e.actorName)).toEqual(['op-a']);
    expect((await call('qa-a', 'GET', '/api/audit/recent?actor=SUP-A')).body.every((e: { actorName: string }) => e.actorName === 'sup-a')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await call('qa-a', 'GET', `/api/audit/recent?from=${today}&to=${today}`)).body.length).toBe(all.length);
    expect((await call('qa-a', 'GET', '/api/audit/recent?from=2000-01-01&to=2000-01-02')).body).toEqual([]);
    expect((await call('qa-a', 'GET', '/api/audit/recent?limit=1')).body).toHaveLength(1);
  });
  it('E32#3: a filter is data, never SQL, and an operator cannot read the audit trail', async () => {
    expect((await call('qa-a', 'GET', "/api/audit/recent?action=%25' OR 1=1 --")).body).toEqual([]);
    expect((await call('qa-a', 'GET', '/api/audit/recent?action=%25')).body).toEqual([]);              // % is a character, not a wildcard
    expect((await call('op-a', 'GET', '/api/audit/recent')).status).toBe(403);
    expect((await call('qa-a', 'GET', '/api/audit/recent?limit=5000')).status).toBe(400);
  });
});
