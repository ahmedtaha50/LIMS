import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { auditOf } from '../../server/audit/index.js';
import type { Pool } from '../../server/core/db.js';
import { authorizer, passwordCheck } from '../../server/identity/index.js';
import { hashPassword, passwordProblem, verifyPassword } from '../../server/identity/password.js';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../../server/identity/totp.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { MIGRATIONS, ROUTES } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

type Inst = { base: string; call: (m: string, p: string, body?: unknown, token?: string) => Promise<{ status: number; body: any; cookie: string | null }>; close: () => Promise<void> };   // eslint-disable-line @typescript-eslint/no-explicit-any
async function instance(pool: Pool): Promise<Inst> {
  const server = createApp({ pool, routes: await loadRoutes(ROUTES), authorize: authorizer(pool), log: () => undefined }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    call: async (method, path, body, token) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { cookie: `ebr_session=${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: (res.headers.get('set-cookie') ?? '').match(/ebr_session=([^;]*)/)?.[1] ?? null };
    },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

let db: Awaited<ReturnType<typeof freshDatabase>>, a: Inst, b: Inst;
const PW = 'correct horse battery staple';
async function user(username: string, roles: string[], opts: { mustChange?: boolean; totpSecret?: string } = {}) {
  const r = await db.pool.query<{ id: string }>('INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [username, username.toUpperCase(), await hashPassword(PW), roles, opts.mustChange ?? false, opts.totpSecret ?? null, !!opts.totpSecret]);
  return r.rows[0]!.id;
}
const login = (i: Inst, username: string, password = PW, code?: string) => i.call('POST', '/api/auth/login', { username, password, ...(code ? { totp: code } : {}) });

beforeAll(async () => { db = await freshDatabase('identity'); await migrate(db.pool, MIGRATIONS); a = await instance(db.pool); b = await instance(db.pool); });
afterAll(async () => { await a.close(); await b.close(); await db.drop(); });

describe('passwords and TOTP', () => {
  it('scrypt hashes verify, differ per salt, and keep their parameters', async () => {
    const h1 = await hashPassword(PW), h2 = await hashPassword(PW);
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PW, h1)).toBe(true);
    expect(await verifyPassword(PW + '!', h1)).toBe(false);
    expect(await verifyPassword(PW, 'garbage')).toBe(false);
  });
  it('the password policy', () => {
    expect(passwordProblem('short', 'op')).toMatch(/12 characters/);
    expect(passwordProblem('operator1-is-long', 'operator1')).toMatch(/user name/);
    expect(passwordProblem(PW, 'op1')).toBeNull();
  });
  it('TOTP matches the RFC 6238 test vectors (SHA-1)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totp(secret, 59_000, 8)).toBe('94287082');
    expect(totp(secret, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(secret, 2_000_000_000_000, 8)).toBe('69279037');
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224');   // RFC 4226 appendix D
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
  });
});

describe('sign-in and lockout (E02#1)', () => {
  it('a wrong password is refused; five failures in 15 minutes lock the account; every failure and the lock are audited', async () => {
    const id = await user('op-lock', ['operator']);
    for (let i = 0; i < 4; i++) expect((await login(a, 'op-lock', 'wrong password here')).status).toBe(401);
    const fifth = await login(a, 'op-lock', 'wrong password here');
    expect(fifth.status).toBe(401);
    const locked = await login(b, 'op-lock');            // even the right password, on the other instance
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('locked');
    const actions = (await auditOf(db.pool, 'user', id)).map(e => e.action);
    expect(actions.filter(x => x === 'auth.failed').length).toBe(5);
    expect(actions).toContain('auth.locked');
  });
  it('an unknown user name gets the same answer as a wrong password, and is audited', async () => {
    const r = await login(a, 'nobody-here');
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('The user name or the password is not correct.');
    expect((await auditOf(db.pool, 'user', 'unknown:nobody-here')).length).toBe(1);
  });
  it('an administrator unlocks a locked account, with a reason', async () => {
    const adminSecret = base32Encode(Buffer.from('admin-secret-0123456'));
    await user('admin1', ['admin'], { totpSecret: adminSecret });
    const s = await login(a, 'admin1', PW, totp(adminSecret));
    expect(s.status).toBe(200);
    const target = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'op-lock'")).rows[0]!.id;
    expect((await a.call('POST', `/api/users/${target}/unlock`, { reason: 'operator called the help desk' }, s.cookie!)).status).toBe(204);
    expect((await login(a, 'op-lock')).status).toBe(200);
  });
});

describe('sessions in the database (E02#2)', () => {
  it('two instances accept the same session, and a session signed out on one is refused by the other', async () => {
    await user('op-two', ['operator']);
    const s = await login(a, 'op-two');
    expect(s.status).toBe(200);
    expect((await b.call('GET', '/api/auth/me', undefined, s.cookie!)).body.username).toBe('op-two');
    expect((await a.call('POST', '/api/auth/logout', undefined, s.cookie!)).status).toBe(204);
    expect((await b.call('GET', '/api/auth/me', undefined, s.cookie!)).status).toBe(401);
  });
  it('an idle session expires (sign-off after inactivity)', async () => {
    await user('op-idle', ['operator']);
    const s = await login(a, 'op-idle');
    await db.pool.query("UPDATE sessions SET last_seen = now() - interval '20 minutes' WHERE user_id = (SELECT id FROM users WHERE username = 'op-idle')");
    expect((await a.call('GET', '/api/auth/me', undefined, s.cookie!)).status).toBe(401);
  });
  it('the cookie is HttpOnly and SameSite=Strict, and only its hash is stored', async () => {
    await user('op-cookie', ['operator']);
    const res = await fetch(a.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'op-cookie', password: PW }) });
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^ebr_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
    const token = header.match(/ebr_session=([^;]*)/)![1]!;
    expect((await db.pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')", [token])).rowCount).toBe(1);
  });
});

describe('permissions (E02#3) and the second factor (E02#4)', () => {
  it('a user without the permission gets 403', async () => {
    await user('op-perm', ['operator']);
    const s = await login(a, 'op-perm');
    expect((await a.call('GET', '/api/users', undefined, s.cookie!)).status).toBe(403);
    expect((await a.call('GET', '/api/users')).status).toBe(401);
  });
  it('a QA account without the second factor can only set it up; with it, it gets its permissions', async () => {
    await user('qa-new', ['qa']);
    const s = await login(a, 'qa-new');
    expect(s.body.mustSetUpSecondFactor).toBe(true);
    expect((await a.call('GET', '/api/audit/verify', undefined, s.cookie!)).status).toBe(403);
    const enroll = await a.call('POST', '/api/auth/totp/enroll', undefined, s.cookie!);
    expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await a.call('POST', '/api/auth/totp/confirm', { code: '000000' }, s.cookie!)).status).toBe(400);
    expect((await a.call('POST', '/api/auth/totp/confirm', { code: totp(enroll.body.secret) }, s.cookie!)).status).toBe(204);
    expect((await a.call('GET', '/api/audit/verify', undefined, s.cookie!)).body).toMatchObject({ ok: true });
  });
  it('a QA account with the second factor needs the code, and a wrong code counts as a failure', async () => {
    const sec = base32Encode(Buffer.from('qa-secret-0123456789'));
    const id = await user('qa-mfa', ['qa'], { totpSecret: sec });
    expect((await login(a, 'qa-mfa')).body.code).toBe('totp_required');
    expect((await login(a, 'qa-mfa', PW, '000000')).body.code).toBe('totp_invalid');
    expect((await auditOf(db.pool, 'user', id)).map(e => e.action)).toContain('auth.failed');
    expect((await login(a, 'qa-mfa', PW, totp(sec))).status).toBe(200);
  });
  it('a first password must be changed before anything else; the new one follows the policy', async () => {
    await user('op-first', ['operator'], { mustChange: true });
    const s = await login(a, 'op-first');
    expect(s.body.mustChangePassword).toBe(true);
    expect(s.body.permissions).toEqual(['session']);
    expect((await a.call('POST', '/api/auth/password', { current: PW, next: 'short' }, s.cookie!)).body.code).toBe('weak_password');
    expect((await a.call('POST', '/api/auth/password', { current: PW, next: 'a brand new long password' }, s.cookie!)).status).toBe(204);
    expect((await a.call('GET', '/api/auth/me', undefined, s.cookie!)).body.permissions).toContain('signatures.read');
  });
});

describe('account administration', () => {
  it('create, stale update refused with 409, disable revokes the sessions, every change audited with old and new value', async () => {
    const adminSecret = base32Encode(Buffer.from('admin-secret-0123456'));
    const s = await login(a, 'admin1', PW, totp(adminSecret));
    const created = await a.call('POST', '/api/users', { username: 'op-new', displayName: 'New Operator', roles: ['operator'], password: 'initial password 123' }, s.cookie!);
    expect(created.status).toBe(201);
    expect((await a.call('POST', '/api/users', { username: 'op-new', displayName: 'Again', roles: ['operator'], password: 'initial password 123' }, s.cookie!)).status).toBe(409);
    expect((await a.call('POST', '/api/users', { username: 'op-x', displayName: 'X', roles: ['operator'], password: 'initial password 123', id: 'mine' }, s.cookie!)).status).toBe(400);
    const op = await login(b, 'op-new', 'initial password 123');
    expect(op.status).toBe(200);
    const v = created.body.version;
    const changed = await a.call('PATCH', `/api/users/${created.body.id}`, { version: v, reason: 'left the company', status: 'disabled' }, s.cookie!);
    expect(changed.status).toBe(200);
    expect((await a.call('PATCH', `/api/users/${created.body.id}`, { version: v, reason: 'stale write', displayName: 'Other' }, s.cookie!)).status).toBe(409);
    expect((await b.call('GET', '/api/auth/me', undefined, op.cookie!)).status).toBe(401);
    const trail = await auditOf(db.pool, 'user', created.body.id);
    expect(trail.find(e => e.action === 'user.changed')).toMatchObject({ oldValue: { status: 'active' }, newValue: { status: 'disabled' }, reason: 'left the company' });
  });
  it('the password check of e-signatures uses the current password of an active account', async () => {
    const id = (await db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin1'")).rows[0]!.id;
    const check = passwordCheck(db.pool);
    expect(await check(id, PW)).toBe(true);
    expect(await check(id, 'not it')).toBe(false);
    expect(await check('00000000-0000-0000-0000-000000000000', PW)).toBe(false);
  });
});
