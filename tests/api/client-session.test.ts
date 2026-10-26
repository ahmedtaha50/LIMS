/**
 * Roadmap M06 (r1-client-shell): the client session layer (src/lib/api.ts) against the REAL application and PostgreSQL.
 * apiFetch, the session store, the idle lock and re-authentication that swaps the token under a mounted page, the bridge that
 * gives the 67 legacy fetch() calls the same protection, and the sign-in flows (TOTP, enrolment, forced password change).
 * Node has no browser, so fetch is the real Node fetch pointed at a real HTTP listener in front of the real Express app.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { generateSync } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertActiveSpec, uniq } from '../helpers/fixtures';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

type Api = typeof import('../../src/lib/api');
let api: Api;
let t: TestApp;
let server: http.Server;
let base = '';
const realFetch = globalThis.fetch;
const hits: Array<{ method: string; url: string; authorization?: string }> = [];

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const code = (secret = SECRET, steps = 0) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + steps * 30 });
const STRONG = 'Zq7!velvet-Harbor-2026';
/** For `await call.then(rejected, e => e)`: the call must fail, and what it failed with is returned (typed loosely, the tests read its fields). */
const rejected = (): never => { throw new Error('the call was expected to fail, and it succeeded'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('condition not met in time'); await sleep(10); }
}

/** An in-memory Storage, so the tests can look at what the layer wrote (Node has no sessionStorage). */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

let seq = 0;
async function newUser(opts: { role?: string; mustChange?: boolean; totp?: boolean } = {}) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-c${process.pid}-${n}`;
  const email = `c${process.pid}.${n}@gxp.test`;
  await t.db.pool.query(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training, must_change_password, totp_secret, totp_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)`,
    [id, `uid-${id}`, `Client Test ${n}`, opts.role ?? 'Analyst', email, generatePasswordHash(TEST_PASSWORD), opts.mustChange ?? false, opts.totp ? SECRET : null, opts.totp ?? false],
  );
  return { id, email };
}

/** Signs in through the client's own auth calls and starts the session in the store. */
async function signedIn(user: { email: string }) {
  const r = await api.authApi.login(user.email, TEST_PASSWORD);
  if (r.kind !== 'session') throw new Error(`expected a session, got ${r.kind}`);
  api.startSession(r.signIn);
  return r.signIn;
}
const sessionId = () => api.sessionStore.getState().session!.id;
const makeIdle = (sid = sessionId()) => t.db.pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [sid]);

let seen: Record<string, Array<CustomEvent>>;
const listeners: Array<[string, EventListener]> = [];
function record(...names: string[]) {
  seen = {};
  for (const n of names) {
    seen[n] = [];
    const l = ((e: CustomEvent) => seen[n].push(e)) as EventListener;
    api.sessionEvents.addEventListener(n, l);
    listeners.push([n, l]);
  }
}

beforeAll(async () => {
  t = await startTestApp();
  // a recording layer in front of the real application: what the server saw (method, URL, Authorization), nothing else is changed
  const { default: express } = await import('express');
  const outer = express();
  outer.use((req, _res, next) => { hits.push({ method: req.method, url: req.originalUrl, authorization: req.headers.authorization }); next(); });
  outer.use(t.app);
  server = http.createServer(outer);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the browser resolves '/api/...' against its origin; Node has none, so the same thing is done here
  globalThis.fetch = ((input: any, init?: any) => realFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init)) as typeof fetch;
  api = await import('../../src/lib/api');
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise(r => server.close(r));
});

beforeEach(() => {
  (globalThis as any).sessionStorage = new MemoryStorage();
  (globalThis as any).localStorage = new MemoryStorage();
  hits.length = 0;
  api.endSession();
});

afterEach(() => {
  for (const [n, l] of listeners.splice(0)) api.sessionEvents.removeEventListener(n, l);
  globalThis.fetch = ((input: any, init?: any) => realFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init)) as typeof fetch;
});

describe('apiFetch', () => {
  it('sends the session token and returns the parsed body', async () => {
    const u = await newUser();
    const signIn = await signedIn(u);
    const list = await api.apiFetch<unknown[]>('/samples');
    expect(Array.isArray(list)).toBe(true);
    expect(hits.at(-1)!.authorization).toBe(`Bearer ${signIn.token}`);
  });

  it('accepts a path with or without the /api prefix', async () => {
    await signedIn(await newUser());
    const a = await api.apiFetch<any>('/auth/me');
    const b = await api.apiFetch<any>('/api/auth/me');
    expect(a.user.id).toBe(b.user.id);
  });

  it('turns an error response into a typed ApiError: status, code, message, request id and details', async () => {
    const u = await newUser();
    await signedIn(u);
    const err = await api.apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword: TEST_PASSWORD, newPassword: 'short' } }).then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.code).toBe('PASSWORD_POLICY');
    expect(err.message).toMatch(/at least 8 characters/i); // the server's own sentence, unchanged
    expect(err.requestId).toMatch(/^[\w-]{8,}$/);
    expect(Array.isArray(err.details)).toBe(true);
  });

  it('a missing record is a 404 ApiError, not a body to be mapped over', async () => {
    await signedIn(await newUser());
    const err = await api.apiFetch('/samples/NO-SUCH-SAMPLE').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(404);
  });

  it('a server that cannot be reached is an ApiError with code NETWORK_ERROR and a readable message', async () => {
    await signedIn(await newUser());
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toMatch(/cannot be reached|could not reach/i);
  });

  it('an answer that is not JSON (a proxy page) is an ApiError that names the HTTP status, never a SyntaxError', async () => {
    await signedIn(await newUser());
    globalThis.fetch = (async () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
  });

  it('a 200 whose body is not JSON is also an ApiError (the caller never receives a half-parsed value)', async () => {
    await signedIn(await newUser());
    globalThis.fetch = (async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('BAD_RESPONSE');
  });

  it('a rate-limit answer carries retryAfterSeconds', async () => {
    await signedIn(await newUser());
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Too many requests.', code: 'RATE_LIMITED', retryAfterSeconds: 17 }), { status: 429, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(17);
  });

  it('204 and empty bodies resolve to undefined', async () => {
    await signedIn(await newUser());
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await expect(api.apiFetch('/anything', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('with no session it fails at once with a typed error and sends nothing', async () => {
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(401);
    expect(hits).toEqual([]);
  });
});

describe('a session that has ended', () => {
  it('an invalid token: ApiError, one session:expired event, an expired state, and the token is gone from storage', async () => {
    record('session:expired');
    const signIn = await signedIn(await newUser());
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBe(signIn.token);
    await t.db.pool.query('DELETE FROM sessions WHERE id = $1', [sessionId()]);

    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_TOKEN');
    expect(api.sessionStore.getState().status).toBe('expired');
    expect(api.sessionStore.getState().endedCode).toBe('INVALID_TOKEN');
    expect(seen['session:expired']).toHaveLength(1);
    expect(seen['session:expired'][0].detail).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBeNull();

    // later calls do not go to the server again
    const n = hits.length;
    await api.apiFetch('/samples').catch(() => {});
    expect(hits.length).toBe(n);
    expect(seen['session:expired']).toHaveLength(1);
  });

  it.each([
    ['revoked (logout elsewhere, password change, deactivation)', "UPDATE sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", 'SESSION_REVOKED'],
    ['past the absolute limit', "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", 'SESSION_EXPIRED'],
  ])('%s', async (_name, sql, expected) => {
    record('session:expired');
    await signedIn(await newUser());
    await t.db.pool.query(sql, [sessionId()]);
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err.code).toBe(expected);
    expect(api.sessionStore.getState().status).toBe('expired');
    expect(seen['session:expired']).toHaveLength(1);
  });

  it('a deactivated user (USER_INACTIVE) ends the session', async () => {
    const u = await newUser();
    await signedIn(u);
    await t.db.pool.query('UPDATE users SET active = false WHERE id = $1', [u.id]);
    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err.code).toBe('USER_INACTIVE');
    expect(api.sessionStore.getState().status).toBe('expired');
  });
});

describe('idle lock and re-authentication', () => {
  it('the server says SESSION_IDLE: the store locks, the call waits, and after re-authentication it is repeated with the new token and succeeds', async () => {
    record('session:locked', 'session:renewed', 'session:expired');
    const u = await newUser();
    const first = await signedIn(u);
    const sid = sessionId();
    await makeIdle();
    await sleep(1100); // a token carries its issue time in whole seconds: unlock later than that, or the new token is the same string

    const pending = api.apiFetch<unknown[]>('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    expect(api.sessionStore.getState().lockReason).toBe('server');
    expect(seen['session:locked']).toHaveLength(1);

    await api.reauth({ password: TEST_PASSWORD });
    const list = await pending;
    expect(Array.isArray(list)).toBe(true);

    const st = api.sessionStore.getState();
    expect(st.status).toBe('active');
    expect(st.session!.id).toBe(sid); // the same session: nothing was lost on the server either
    expect(st.token).not.toBe(first.token); // swapped
    expect(hits.at(-1)!.authorization).toBe(`Bearer ${st.token}`);
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBe(st.token);
    expect(seen['session:renewed']).toHaveLength(1);
    expect(seen['session:expired']).toHaveLength(0);
  });

  it('three calls in flight at the lock produce one lock and all three are repeated once', async () => {
    record('session:locked');
    await signedIn(await newUser());
    await makeIdle();
    const calls = [api.apiFetch('/samples'), api.apiFetch('/instruments'), api.apiFetch('/reagents')];
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    const results = await Promise.all(calls);
    expect(results.every(Array.isArray)).toBe(true);
    expect(seen['session:locked']).toHaveLength(1);
    const ok = hits.filter(h => h.url === '/api/samples');
    expect(ok.length).toBe(2); // the refused attempt and the repeat
  });

  it('a write that was refused only because the session was idle is carried out once, after unlock (the typed value is not lost, and not duplicated)', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material);
    await signedIn(await newUser());
    await makeIdle();
    const save = api.apiFetch<{ id: string }>('/samples', { method: 'POST', body: { material, batch: uniq('B') } });
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    const created = await save;
    expect(created.id).toBeTruthy();
    const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM samples WHERE material = $1', [material]);
    expect(rows[0].n).toBe(1);
  });

  it('while the screen is locked nothing is sent to the server: a locked page cannot keep the server session alive', async () => {
    await signedIn(await newUser());
    const sid = sessionId();
    const before = (await t.db.pool.query('SELECT last_seen_at FROM sessions WHERE id = $1', [sid])).rows[0].last_seen_at;
    await sleep(1100);
    api.lockSession('idle'); // the client idle timer
    expect(api.sessionStore.getState().status).toBe('locked');
    expect(api.sessionStore.getState().lockReason).toBe('idle');
    const n = hits.length;
    const waiting = api.apiFetch('/samples');
    await sleep(200);
    expect(hits.length).toBe(n);
    const same = (await t.db.pool.query('SELECT last_seen_at FROM sessions WHERE id = $1', [sid])).rows[0].last_seen_at;
    expect(same).toEqual(before);

    await api.reauth({ password: TEST_PASSWORD });
    await expect(waiting).resolves.toBeDefined();
  });

  it('a wrong password keeps the page locked and says why; the right one then unlocks', async () => {
    await signedIn(await newUser());
    await makeIdle();
    const pending = api.apiFetch('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    const err = await api.reauth({ password: 'not-the-password' }).then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(api.sessionStore.getState().status).toBe('locked');
    await api.reauth({ password: TEST_PASSWORD });
    await expect(pending).resolves.toBeDefined();
  });

  it('a user with an authenticator is asked for the code (MFA_CODE_REQUIRED), and the next code unlocks', async () => {
    const u = await newUser({ totp: true });
    const r = await api.authApi.login(u.email, TEST_PASSWORD);
    expect(r.kind).toBe('totp');
    if (r.kind !== 'totp') return;
    const done = await api.authApi.verifyTotp({ tempToken: r.tempToken, code: code() });
    api.startSession(done);
    await makeIdle();
    const pending = api.apiFetch('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    const need = await api.reauth({ password: TEST_PASSWORD }).then(rejected, (e: any) => e);
    expect(need.code).toBe('MFA_CODE_REQUIRED');
    expect(api.sessionStore.getState().status).toBe('locked');
    await api.reauth({ password: TEST_PASSWORD, code: code(SECRET, 1) });
    await expect(pending).resolves.toBeDefined();
  });

  it('re-authentication does not re-sign anything: a request that carries a password is NOT repeated after unlock', async () => {
    const admin = await newUser({ role: 'Admin' });
    await signedIn(admin);
    await makeIdle();
    const target = '/training/usr-analyst1/certify';
    const before = (await t.db.pool.query("SELECT count(*)::int AS n FROM training_records WHERE user_id = 'usr-analyst1'")).rows[0].n;
    const signing = api.apiFetch(target, { method: 'POST', body: { moduleName: 'GxP Basics', password: TEST_PASSWORD } });
    const outcome = signing.then(rejected, (e: any) => e);
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    const err = await outcome;
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('RESUBMIT_REQUIRED');
    expect(err.message).toMatch(/not carried out|submit it again/i);
    expect(hits.filter(h => h.method === 'POST' && h.url === `/api${target}`)).toHaveLength(1); // the refused attempt only
    const after = (await t.db.pool.query("SELECT count(*)::int AS n FROM training_records WHERE user_id = 'usr-analyst1'")).rows[0].n;
    expect(after).toBe(before); // nothing was certified
  });

  it('replay can be refused explicitly for any other call', async () => {
    await signedIn(await newUser());
    await makeIdle();
    const outcome = api.apiFetch('/samples', { replay: 'never' }).then(rejected, (e: any) => e);
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    expect((await outcome).code).toBe('RESUBMIT_REQUIRED');
  });

  it('when the absolute limit has passed, unlocking fails with the session ending, and the waiting calls fail with it', async () => {
    record('session:expired');
    await signedIn(await newUser());
    await t.db.pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 minute' WHERE id = $1", [sessionId()]);
    const pending = api.apiFetch('/samples').then(rejected, (e: any) => e);
    await until(() => api.sessionStore.getState().status === 'locked');
    await t.db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sessionId()]);
    const err = await api.reauth({ password: TEST_PASSWORD }).then(rejected, (e: any) => e);
    expect(err.code).toBe('SESSION_EXPIRED');
    expect(api.sessionStore.getState().status).toBe('expired');
    expect((await pending).code).toBe('SESSION_EXPIRED');
    expect(seen['session:expired']).toHaveLength(1);
  });

  it('signing out from the lock screen ends the session on the server and releases the waiting calls with an error', async () => {
    await signedIn(await newUser());
    await makeIdle();
    const sid = sessionId();
    const pending = api.apiFetch('/samples').then(rejected, (e: any) => e);
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.authApi.logout().catch(() => {});
    api.endSession();
    expect((await pending)).toBeInstanceOf(api.ApiError);
    const { rows } = await t.db.pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [sid]);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(api.sessionStore.getState().status).toBe('signed-out');
  });
});

describe('forced password change', () => {
  it('a temporary password signs in, every other call is refused with PASSWORD_CHANGE_REQUIRED and the store says a change is due; after the change the application works', async () => {
    record('session:password-change-required');
    const u = await newUser({ mustChange: true });
    const signIn = await signedIn(u);
    expect(signIn.mustChangePassword).toBe(true);
    expect(api.sessionStore.getState().mustChangePassword).toBe(true);

    const err = await api.apiFetch('/samples').then(rejected, (e: any) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(seen['session:password-change-required']).toHaveLength(1);

    await api.authApi.changePassword({ currentPassword: TEST_PASSWORD, newPassword: STRONG });
    await api.refreshMe();
    expect(api.sessionStore.getState().mustChangePassword).toBe(false);
    await expect(api.apiFetch('/samples')).resolves.toBeDefined();
  });

  it('a weak new password is an ApiError with the reasons, and the password is unchanged', async () => {
    const u = await newUser({ mustChange: true });
    await signedIn(u);
    const err = await api.authApi.changePassword({ currentPassword: TEST_PASSWORD, newPassword: 'password1' }).then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('PASSWORD_POLICY');
    expect((await api.authApi.login(u.email, TEST_PASSWORD)).kind).toBe('session');
  });
});

describe('sign-in', () => {
  it('a TOTP user reaches the application with a real token, not the string "undefined" (Login.tsx tested requireTotp; the server sends requiresTotp)', async () => {
    const u = await newUser({ totp: true });
    const step = await api.authApi.login(u.email, TEST_PASSWORD);
    expect(step.kind).toBe('totp');
    if (step.kind !== 'totp') return;
    expect(step.tempToken).toBeTruthy();

    const signIn = await api.authApi.verifyTotp({ tempToken: step.tempToken, code: code() });
    expect(signIn.token).not.toBe('undefined');
    expect(signIn.token.split('.')).toHaveLength(3);
    api.startSession(signIn);
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBe(signIn.token);
    const me = await api.apiFetch<any>('/auth/me');
    expect(me.user.id).toBe(u.id);
    expect(me.user.mfaEnabled).toBe(true);
  });

  it('a wrong code is an ApiError the screen can show, and the challenge is still usable', async () => {
    const u = await newUser({ totp: true });
    const step = await api.authApi.login(u.email, TEST_PASSWORD);
    if (step.kind !== 'totp') throw new Error('expected totp');
    const err = await api.authApi.verifyTotp({ tempToken: step.tempToken, code: '000000' }).then(rejected, (e: any) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('INVALID_CODE');
    const ok = await api.authApi.verifyTotp({ tempToken: step.tempToken, code: code() });
    expect(ok.token.split('.')).toHaveLength(3);
  });

  it('enrolment required by policy: the first sign-in returns the QR code and key; the first code completes it and shows the ten recovery codes', async () => {
    await t.db.pool.query("INSERT INTO system_settings (id, mfa_required) VALUES ('default', true) ON CONFLICT (id) DO UPDATE SET mfa_required = true");
    try {
      const u = await newUser();
      const step = await api.authApi.login(u.email, TEST_PASSWORD);
      expect(step.kind).toBe('totp-setup');
      if (step.kind !== 'totp-setup') return;
      expect(step.qrCode).toMatch(/^data:image\//);
      expect(step.secret).toMatch(/^[A-Z2-7]{16,}$/);

      const signIn = await api.authApi.setupTotp({ tempToken: step.tempToken, code: code(step.secret) });
      expect(signIn.token.split('.')).toHaveLength(3);
      expect(signIn.recoveryCodes).toHaveLength(10);
      api.startSession(signIn);
      expect((await api.apiFetch<any>('/auth/me')).user.mfaEnabled).toBe(true);
    } finally {
      await t.db.pool.query("UPDATE system_settings SET mfa_required = false WHERE id = 'default'");
    }
  });

  it('a recovery code signs in when the phone is lost', async () => {
    await t.db.pool.query("INSERT INTO system_settings (id, mfa_required) VALUES ('default', true) ON CONFLICT (id) DO UPDATE SET mfa_required = true");
    let recovery: string;
    let email: string;
    try {
      const u = await newUser(); email = u.email;
      const step = await api.authApi.login(u.email, TEST_PASSWORD);
      if (step.kind !== 'totp-setup') throw new Error('expected enrolment');
      recovery = (await api.authApi.setupTotp({ tempToken: step.tempToken, code: code(step.secret) })).recoveryCodes![0];
    } finally {
      await t.db.pool.query("UPDATE system_settings SET mfa_required = false WHERE id = 'default'");
    }
    const again = await api.authApi.login(email, TEST_PASSWORD);
    if (again.kind !== 'totp') throw new Error('expected totp');
    const signIn = await api.authApi.verifyTotp({ tempToken: again.tempToken, recoveryCode: recovery });
    expect(signIn.token.split('.')).toHaveLength(3);
  });

  it('wrong credentials and a locked account are ApiErrors with the server message; the lock carries the wait in seconds', async () => {
    const u = await newUser();
    const first = await api.authApi.login(u.email, 'bad-1').then(rejected, (e: any) => e);
    expect(first).toBeInstanceOf(api.ApiError);
    expect(first.code).toBe('INVALID_CREDENTIALS');
    await api.authApi.login(u.email, 'bad-2').catch(() => {});
    await api.authApi.login(u.email, 'bad-3').catch(() => {});
    const locked = await api.authApi.login(u.email, TEST_PASSWORD).then(rejected, (e: any) => e);
    expect(locked.code).toBe('ACCOUNT_LOCKED');
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('a failed sign-in is not treated as the loss of a session (it has no session to lose)', async () => {
    record('session:expired', 'session:locked');
    await api.authApi.login('nobody@gxp.test', 'whatever').catch(() => {});
    expect(seen['session:expired']).toHaveLength(0);
    expect(seen['session:locked']).toHaveLength(0);
    expect(api.sessionStore.getState().status).toBe('signed-out');
  });

  it('a sign-in answer without a real token is rejected, never stored (the old screen stored "undefined")', () => {
    expect(() => api.toSignIn({})).toThrow(api.ApiError);
    expect(() => api.toSignIn({ token: undefined, user: {} })).toThrow(/token/i);
    expect(() => api.startSession({ token: 'undefined', user: { id: 'x', name: 'x', role: 'QA' } as any, mustChangePassword: false, session: { id: 's', idleTimeoutMinutes: 15, idleExpiresAt: '', expiresAt: '' } })).toThrow();
    expect(api.sessionStore.getState().status).toBe('signed-out');
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBeNull();
  });

  it('logout ends the session on the server with the Authorization header (the old screen posted without it, so the session stayed alive)', async () => {
    const u = await newUser();
    const signIn = await signedIn(u);
    await api.authApi.logout();
    expect(hits.at(-1)!.url).toBe('/api/auth/logout');
    expect(hits.at(-1)!.authorization).toBe(`Bearer ${signIn.token}`);
    const res = await realFetch(`${base}/api/samples`, { headers: { Authorization: `Bearer ${signIn.token}` } });
    expect(res.status).toBe(401);
    const events = await t.db.pool.query("SELECT event_type FROM security_events WHERE actor_id = $1 AND event_type = 'AUTH_LOGOUT'", [u.id]);
    expect(events.rowCount).toBe(1);
  });
});

describe('page reload', () => {
  it('restores the session from sessionStorage with GET /auth/me: the user is the server\'s, not decoded from the token', async () => {
    const u = await newUser();
    const signIn = await signedIn(u);
    vi.resetModules();
    const fresh: Api = await import('../../src/lib/api');
    expect(fresh.sessionStore.getState().status).toBe('signed-out'); // new page, nothing in memory
    await fresh.bootSession();
    const st = fresh.sessionStore.getState();
    expect(st.status).toBe('active');
    expect(st.token).toBe(signIn.token);
    expect(st.user).toMatchObject({ id: u.id, role: 'Analyst', name: expect.stringContaining('Client Test') });
    expect(st.session!.idleTimeoutMinutes).toBeGreaterThan(0);
  });

  it('a stored token the server no longer accepts ends at the sign-in screen with a notice, and is removed from storage', async () => {
    await signedIn(await newUser());
    await t.db.pool.query('DELETE FROM sessions WHERE id = $1', [sessionId()]);
    vi.resetModules();
    const fresh: Api = await import('../../src/lib/api');
    await fresh.bootSession();
    const st = fresh.sessionStore.getState();
    expect(st.status).not.toBe('active');
    expect(st.user).toBeNull();
    expect(st.notice).toMatch(/session/i);
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBeNull();
  });

  it('a page reloaded after the idle limit boots into the lock screen and the same session is revived by re-authentication', async () => {
    await signedIn(await newUser());
    const sid = sessionId();
    await makeIdle(sid);
    vi.resetModules();
    const fresh: Api = await import('../../src/lib/api');
    await fresh.bootSession();
    expect(fresh.sessionStore.getState().status).toBe('locked');
    await fresh.reauth({ password: TEST_PASSWORD });
    const st = fresh.sessionStore.getState();
    expect(st.status).toBe('active');
    expect(st.session!.id).toBe(sid);
    expect(st.user).not.toBeNull();
  });

  it('with no stored token it simply stays signed out, and removes a token an older build left in localStorage', async () => {
    (globalThis as any).localStorage.setItem('gxp_token', 'old.token.value');
    vi.resetModules();
    const fresh: Api = await import('../../src/lib/api');
    await fresh.bootSession();
    expect(fresh.sessionStore.getState().status).toBe('signed-out');
    expect((globalThis as any).localStorage.getItem('gxp_token')).toBeNull();
  });
});

describe('storage', () => {
  it('writes the token to sessionStorage only, and removes the key an older build wrote to localStorage', async () => {
    (globalThis as any).localStorage.setItem('gxp_token', 'old.token.value');
    const signIn = await signedIn(await newUser());
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBe(signIn.token);
    expect((globalThis as any).localStorage.getItem('gxp_token')).toBeNull();
  });

  it('works when storage throws (private window, blocked site data): the token lives in memory for the page', async () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    (globalThis as any).sessionStorage = broken;
    (globalThis as any).localStorage = broken;
    await signedIn(await newUser());
    await expect(api.apiFetch('/samples')).resolves.toBeDefined();
  });

  it('endSession removes everything', async () => {
    await signedIn(await newUser());
    api.endSession();
    expect((globalThis as any).sessionStorage.getItem('gxp_token')).toBeNull();
    expect(api.sessionStore.getState()).toMatchObject({ status: 'signed-out', token: null, user: null });
  });
});

describe('the bridge for the existing fetch() calls (Dashboard, Reagents and the rest)', () => {
  let uninstall: () => void;
  beforeEach(() => { uninstall = api.installSessionFetch(); });
  afterEach(() => uninstall());

  it('installs once and uninstalls cleanly', () => {
    const patched = globalThis.fetch;
    const again = api.installSessionFetch();
    expect(globalThis.fetch).toBe(patched);
    again();
    expect(globalThis.fetch).toBe(patched);
  });

  it('an expired token under a raw fetch: the caller gets the original 401 (it can read the message), the session is marked ended, no exception escapes', async () => {
    record('session:expired');
    const signIn = await signedIn(await newUser());
    await t.db.pool.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [sessionId()]);
    const res = await fetch('/api/dashboard', { headers: { Authorization: `Bearer ${signIn.token}` } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('SESSION_REVOKED');
    expect(api.sessionStore.getState().status).toBe('expired');
    expect(seen['session:expired']).toHaveLength(1);
  });

  it('an idle session under a raw fetch: held, the lock opens, and after re-authentication the caller receives the real 200 (with the new token)', async () => {
    const signIn = await signedIn(await newUser());
    await makeIdle();
    const pending = fetch('/api/reagents', { headers: { Authorization: `Bearer ${signIn.token}` } });
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
    expect(hits.at(-1)!.authorization).toBe(`Bearer ${api.sessionStore.getState().token}`);
  });

  it('a token captured before the swap (a prop held by a mounted component) is rewritten to the current one', async () => {
    const signIn = await signedIn(await newUser());
    await makeIdle();
    await sleep(1100); // see above: the new token only differs after a second
    const p = api.apiFetch('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    await p;
    hits.length = 0;
    const res = await fetch('/api/samples', { headers: { Authorization: `Bearer ${signIn.token}` } });
    expect(res.status).toBe(200);
    expect(hits[0].authorization).toBe(`Bearer ${api.sessionStore.getState().token}`);
    expect(signIn.token).not.toBe(api.sessionStore.getState().token);
  });

  it('a raw write that carries a password is answered with a resubmit message after unlock and is NOT repeated', async () => {
    const admin = await newUser({ role: 'Admin' });
    const signIn = await signedIn(admin);
    await makeIdle();
    const pending = fetch('/api/training/usr-analyst1/certify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signIn.token}` },
      body: JSON.stringify({ moduleName: 'GxP Basics', password: TEST_PASSWORD }),
    });
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    const res = await pending;
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.code).toBe('RESUBMIT_REQUIRED');
    expect(typeof body.error).toBe('string');
    expect(hits.filter(h => h.url === '/api/training/usr-analyst1/certify')).toHaveLength(1);
  });

  it('a raw write without credentials is repeated after unlock, exactly once', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material);
    const signIn = await signedIn(await newUser());
    await makeIdle();
    const pending = fetch('/api/samples', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signIn.token}` },
      body: JSON.stringify({ material, batch: uniq('B') }),
    });
    await until(() => api.sessionStore.getState().status === 'locked');
    await api.reauth({ password: TEST_PASSWORD });
    expect((await pending).status).toBe(200);
    const { rows } = await t.db.pool.query('SELECT count(*)::int AS n FROM samples WHERE material = $1', [material]);
    expect(rows[0].n).toBe(1);
  });

  it('sign-in calls and other URLs are left alone: a wrong password is not a lost session', async () => {
    record('session:expired', 'session:locked');
    const res = await fetch('/api/auth/login-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@gxp.test', password: 'x' }) });
    expect(res.status).toBe(401);
    expect(seen['session:expired']).toHaveLength(0);
    const other = await fetch('/api/health');
    expect(other.status).toBe(200);
  });

  it('a bearer token that is not this session\'s is not touched and cannot end this session', async () => {
    record('session:expired');
    await signedIn(await newUser());
    const res = await fetch('/api/samples', { headers: { Authorization: 'Bearer some.other.token' } });
    expect(res.status).toBe(401);
    expect(hits.at(-1)!.authorization).toBe('Bearer some.other.token');
    expect(api.sessionStore.getState().status).toBe('active');
    expect(seen['session:expired']).toHaveLength(0);
  });

  it('while the screen is locked a raw fetch waits too', async () => {
    const signIn = await signedIn(await newUser());
    api.lockSession('idle');
    const n = hits.length;
    const pending = fetch('/api/samples', { headers: { Authorization: `Bearer ${signIn.token}` } });
    await sleep(150);
    expect(hits.length).toBe(n);
    await api.reauth({ password: TEST_PASSWORD });
    expect((await pending).status).toBe(200);
  });
});

describe('answers that predate an unlock', () => {
  it('a request that was in flight when the user unlocked is repeated, and its stale "idle" answer does not lock the screen again', async () => {
    await signedIn(await newUser());
    await makeIdle();

    // The server answers /reagents "idle" (the session was idle when it arrived), but the answer is held back until after the unlock.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const heldOnce = { done: false };
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const res = await inner(input, init);
      if (!heldOnce.done && String(input).endsWith('/api/reagents')) { heldOnce.done = true; await gate; }
      return res;
    }) as typeof fetch;

    const slow = api.apiFetch('/reagents');
    const first = api.apiFetch('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    await until(() => hits.some(h => h.url === '/api/reagents'));
    await api.reauth({ password: TEST_PASSWORD });
    release(); // now the stale answer arrives
    await expect(Promise.all([first, slow])).resolves.toBeDefined();
    expect(api.sessionStore.getState().status).toBe('active');
    expect(hits.filter(h => h.url === '/api/reagents')).toHaveLength(2); // refused once (idle), repeated once
  });

  it('the same for a write that carries a password: it is not repeated, and the answer is RESUBMIT_REQUIRED, not a second lock', async () => {
    const admin = await newUser({ role: 'Admin' });
    await signedIn(admin);
    await makeIdle();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const heldOnce = { done: false };
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const res = await inner(input, init);
      if (!heldOnce.done && String(input).includes('/certify')) { heldOnce.done = true; await gate; }
      return res;
    }) as typeof fetch;
    const signing = api.apiFetch('/training/usr-analyst1/certify', { method: 'POST', body: { moduleName: 'GxP Basics', password: TEST_PASSWORD } }).then(rejected, (e: any) => e);
    const other = api.apiFetch('/samples');
    await until(() => api.sessionStore.getState().status === 'locked');
    await until(() => hits.some(h => h.url.includes('/certify')));
    await api.reauth({ password: TEST_PASSWORD });
    release();
    await other;
    expect((await signing).code).toBe('RESUBMIT_REQUIRED');
    expect(api.sessionStore.getState().status).toBe('active');
  });
});

describe('the bridge and the calls that must work while locked', () => {
  let uninstall: () => void;
  beforeEach(() => { uninstall = api.installSessionFetch(); });
  afterEach(() => uninstall());

  it('a raw logout with the session token is not held by the lock: it is how someone leaves a locked screen', async () => {
    const signIn = await signedIn(await newUser());
    await makeIdle();
    api.lockSession('idle'); // the screen is locked: every other call waits
    const sid = sessionId();
    const res = await Promise.race([
      fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${signIn.token}` } }),
      sleep(3000).then(() => 'held' as const),
    ]);
    expect(res).not.toBe('held');
    expect((res as Response).status).toBe(200);
    expect(api.sessionStore.getState().status).toBe('locked'); // the layer neither held the call nor changed the state because of it
    const { rows } = await t.db.pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [sid]);
    expect(rows[0].revoked_at).not.toBeNull();
  });
});

