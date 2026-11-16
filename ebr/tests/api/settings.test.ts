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

const PW = 'settings test password';
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
  db = await freshDatabase('settings'); await migrate(db.pool, MIGRATIONS);
  const server = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), authorize: authorizer(db.pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>(r => server.close(() => r()));
  await account('adm-s', ['admin']); await account('adm2-s', ['admin']); await account('qa-s', ['qa']); await account('op-s', ['operator']);
});
afterAll(async () => { await close(); await db.drop(); });
const get = async (key: string) => (await call('adm-s', 'GET', '/api/settings')).body.find((s: { key: string }) => s.key === key);

describe('site settings for sessions and sign-in (E27)', () => {
  it('E27#1: the defaults are 15 minutes idle, 12 hours, 5 failures in 15 minutes, 30 minutes lock', async () => {
    const all = (await call('qa-s', 'GET', '/api/settings')).body;
    const v = Object.fromEntries(all.map((s: { key: string; value: unknown }) => [s.key, s.value]));
    expect(v).toMatchObject({ 'session.idleMinutes': 15, 'session.maxHours': 12, 'signin.maxFailures': 5, 'signin.windowMinutes': 15, 'signin.lockMinutes': 30 });
    expect(all.every((s: { changed: boolean }) => !s.changed)).toBe(true);
    expect((await call('op-s', 'GET', '/api/settings')).status).toBe(403);
  });

  it('E27#2: only an administrator changes a setting, within bounds, with a reason and a signature, on the version read', async () => {
    const body = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, rowVersion: 0, reason: 'plant policy SOP-IT-014', password: PW, ...extra });
    expect((await call('qa-s', 'PUT', '/api/settings/session.idleMinutes', body(10))).status).toBe(403);
    expect((await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', body(10, { password: 'wrong' }))).status).toBe(401);
    const oob = await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', body(240));
    expect(oob.status).toBe(400); expect(oob.body.code).toBe('out_of_bounds');
    expect((await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', body(10, { reason: 'x' }))).status).toBe(400);
    expect((await call('adm-s', 'PUT', '/api/settings/no.such', body(10))).status).toBe(404);
    expect((await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', body(15))).body.code).toBe('unchanged');
    const ok = await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', body(10));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ value: 10, default: 15, changed: true, rowVersion: 1, updatedBy: 'adm-s' });
    expect((await call('adm2-s', 'PUT', '/api/settings/session.idleMinutes', body(20))).status).toBe(409);       // stale: read version 0
    const sigs = (await call('qa-s', 'GET', '/api/signatures?entity=site_setting&entityId=session.idleMinutes')).body;
    expect(sigs.map((s: { meaning: string; signerName: string; comment: string }) => [s.meaning, s.signerName, s.comment])).toEqual([['approved', 'adm-s', 'plant policy SOP-IT-014']]);
    const a = await auditOf(db.pool, 'site_setting', 'session.idleMinutes');
    expect(a.map(e => e.action)).toEqual(['esign.refused', 'esign.signed', 'setting.changed']);                 // the wrong password is audited too
    expect(a.filter(e => e.action === 'setting.changed').map(e => [e.oldValue, e.newValue, e.reason])).toEqual([[15, 10, 'plant policy SOP-IT-014']]);
    await expect(db.pool.query('DELETE FROM site_settings')).rejects.toThrow(/never deleted/);
  });

  it('E27#3: sessions follow the idle setting at once, without a restart', async () => {
    await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', { value: 15, rowVersion: (await get('session.idleMinutes')).rowVersion, reason: 'back to the default', password: PW });
    await db.pool.query("UPDATE sessions SET last_seen = now() - interval '6 minutes' WHERE user_id = (SELECT id FROM users WHERE username = 'op-s')");
    expect((await call('op-s', 'GET', '/api/auth/me')).status).toBe(200);                                     // 6 min idle, limit 15
    await call('adm-s', 'PUT', '/api/settings/session.idleMinutes', { value: 5, rowVersion: (await get('session.idleMinutes')).rowVersion, reason: 'shorter on the shop floor', password: PW });
    await db.pool.query("UPDATE sessions SET last_seen = now() - interval '6 minutes' WHERE user_id = (SELECT id FROM users WHERE username = 'op-s')");
    expect((await call('op-s', 'GET', '/api/auth/me')).status).toBe(401);                                     // 6 min idle, limit 5
  });

  it('E27#3: sign-in locks after the number of failures the setting says', async () => {
    await call('adm-s', 'PUT', '/api/settings/signin.maxFailures', { value: 3, rowVersion: 0, reason: 'three attempts per SOP-IT-014', password: PW });
    await db.pool.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('lock-s', 'lock-s', $1, '{operator}', false)", [await hashPassword(PW)]);
    const login = (pw: string) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lock-s', password: pw }) });
    for (let i = 0; i < 2; i++) expect((await login('wrong')).status).toBe(401);
    expect((await login('wrong')).status).toBe(401);                                                           // the third locks
    expect((await login(PW)).status).toBe(423);
    const locked = await auditOf(db.pool, 'user', (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'lock-s'")).rows[0]!.id);
    expect(locked.find(e => e.action === 'auth.locked')?.newValue).toMatchObject({ minutes: 30, after: '3 failed sign-ins within 15 minutes' });
  });
});
