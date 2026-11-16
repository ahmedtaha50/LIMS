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

const PW = 'preferences test password';
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
  db = await freshDatabase('prefs'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('op-p', ['operator']);
});
afterAll(async () => { await close(); await db.drop(); });

describe('the interface language kept with the account (E26#1)', () => {
  it('E26#1: English by default; a user chooses Arabic and every device signed in as that user gets it', async () => {
    expect((await call('op-p', 'GET', '/api/me/preferences')).body).toEqual({ language: 'en' });
    expect((await call('op-p', 'PUT', '/api/me/preferences', { language: 'fr' })).status).toBe(400);
    expect((await call('op-p', 'PUT', '/api/me/preferences', { language: 'ar' })).body).toEqual({ language: 'ar' });
    const tablet = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op-p', password: PW }) });
    const cookie = (tablet.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)![1]!;
    const other = await fetch(base + '/api/me/preferences', { headers: { cookie: `ebr_session=${cookie}` } });
    expect(await other.json()).toEqual({ language: 'ar' });                                                      // another session, same account
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'op-p'")).rows[0]!.id;
    expect((await auditOf(db.pool, 'user', id)).filter(e => e.action === 'user.language_changed').map(e => [e.oldValue, e.newValue])).toEqual([['en', 'ar']]);
    expect((await fetch(base + '/api/me/preferences')).status).toBe(401);
  });
});
