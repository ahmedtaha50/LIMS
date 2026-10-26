/**
 * Roadmap M05 (r1-identity): purpose-typed tokens, TOTP (replay, throttle, enrolment, recovery codes, encrypted secrets)
 * and server-side sessions (idle and absolute timeout, logout, re-authentication that keeps the session id).
 * Real Express app, real PostgreSQL. Every test that changes lock, MFA or session state uses its own fresh user.
 */
import jwt from 'jsonwebtoken';
import { generateSync } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** The code for the current 30 s step, or for a step `steps` away. */
const code = (secret = SECRET, steps = 0) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + steps * 30 });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let t: TestApp;
let seq = 0;
beforeAll(async () => {
  t = await startTestApp();
  // Cache the five tokens now: building a header inside `request.get(...).set(await t.auth(...))` would otherwise log in while that request waits.
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});

/** A fresh user by plain INSERT (valid on the old and the new schema), so tests never share lock, MFA or session state. */
async function newUser(role = 'Analyst') {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-s${process.pid}-${n}`;
  const email = `s${process.pid}.${n}@gxp.test`;
  await t.db.pool.query(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [id, `uid-${id}`, `Session Test ${n}`, role, email, generatePasswordHash(TEST_PASSWORD)],
  );
  return { id, email };
}
const enableTotp = (id: string, secret = SECRET) =>
  t.db.pool.query('UPDATE users SET totp_secret = $2, totp_enabled = true WHERE id = $1', [id, secret]);
const login = (email: string, password = TEST_PASSWORD) => t.request.post('/api/auth/login-local').send({ email, password });
const verify = (body: Record<string, unknown>) => t.request.post('/api/auth/totp-verify').send(body);

describe('purpose-typed tokens', () => {
  it('the pre-MFA tempToken is not a session: 401 as a Bearer on a protected route', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const r = await login(u.email);
    expect(r.body.requiresTotp).toBe(true);
    expect(r.body.token).toBeUndefined();
    const res = await t.request.get('/api/samples').set(bearer(r.body.tempToken));
    expect(res.status).toBe(401);
  });

  it('a token signed with the shared JWT secret in the old {id} format is refused', async () => {
    const forged = jwt.sign({ id: 'usr-admin' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
    const res = await t.request.get('/api/samples').set(bearer(forged));
    expect(res.status).toBe(401);
  });

  it('a token of one purpose is refused for another: a session token is not an MFA challenge', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const plain = await newUser();
    const session = (await login(plain.email)).body.token;
    expect(session).toBeTruthy();
    const res = await verify({ tempToken: session, code: code() });
    expect(res.status).toBe(401);
  });

  it('the name and role in the token are for display only: a role change in the database applies at once', async () => {
    const u = await newUser('QA');
    const token = (await login(u.email)).body.token as string;
    expect(jwt.decode(token)).toMatchObject({ typ: 'access', sub: u.id, id: u.id, role: 'QA' });
    expect((await t.request.get('/api/audit').set(bearer(token))).status).toBe(200); // QA may read the audit trail
    await t.db.pool.query("UPDATE users SET role = 'Analyst' WHERE id = $1", [u.id]);
    expect((await t.request.get('/api/audit').set(bearer(token))).status).toBe(403); // the token still says QA
  });

  it('a session token whose session row is gone is refused (the signature alone is not enough)', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(200);
    await t.db.pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(401);
  });
});

describe('TOTP at sign-in', () => {
  it('a valid code issues a session; the same code a second time is refused (replay)', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const first = await login(u.email);
    const c = code();
    const ok = await verify({ tempToken: first.body.tempToken, code: c });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect((await t.request.get('/api/samples').set(bearer(ok.body.token))).status).toBe(200);

    const second = await login(u.email);
    const replay = await verify({ tempToken: second.body.tempToken, code: c });
    expect(replay.status).toBe(401);
    expect(replay.body.token).toBeUndefined();
  });

  it('the same challenge cannot be redeemed twice: not with the same code, not with the next one', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const r = await login(u.email);
    const c = code();
    expect((await verify({ tempToken: r.body.tempToken, code: c })).status).toBe(200);
    expect((await verify({ tempToken: r.body.tempToken, code: c })).status).toBe(401);
    expect((await verify({ tempToken: r.body.tempToken, code: code(SECRET, 1) })).status).toBe(401);
  });

  it('wrong codes are throttled: three of them lock sign-in, and then even the right code is refused', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const r = await login(u.email);
    for (let i = 0; i < 3; i++) expect((await verify({ tempToken: r.body.tempToken, code: '000000' })).status).toBe(401);
    const locked = await verify({ tempToken: r.body.tempToken, code: code() });
    expect(locked.status).toBe(401);
    expect(locked.body.token).toBeUndefined();
    const again = await login(u.email);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('one code used by two sign-ins at the same moment opens exactly one session', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const a = (await login(u.email)).body.tempToken as string;
    const b = (await login(u.email)).body.tempToken as string;
    const c = code();
    const statuses = (await Promise.all([verify({ tempToken: a, code: c }), verify({ tempToken: b, code: c })])).map(r => r.status).sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('a plaintext secret from an older installation is accepted once and re-encrypted at rest', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const r = await login(u.email);
    expect((await verify({ tempToken: r.body.tempToken, code: code() })).status).toBe(200);
    const row = await t.db.pool.query('SELECT totp_secret FROM users WHERE id = $1', [u.id]);
    expect(row.rows[0].totp_secret).toMatch(/^v1:/);
    expect(row.rows[0].totp_secret).not.toContain(SECRET);
    // and it still verifies afterwards (next time step, because the current one is spent)
    const next = await login(u.email);
    expect((await verify({ tempToken: next.body.tempToken, code: code(SECRET, 1) })).status).toBe(200);
  });
});

describe('TOTP enrolment and recovery codes', () => {
  it('enrolment shows a QR once, activates only after a valid code, stores the secret encrypted and issues recovery codes', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    const auth = bearer(token);

    const wrong = await t.request.post('/api/auth/totp-enroll').set(auth).send({ password: 'not-the-password' });
    expect(wrong.status).toBe(401);

    const start = await t.request.post('/api/auth/totp-enroll').set(auth).send({ password: TEST_PASSWORD });
    expect(start.status).toBe(200);
    expect(start.body.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(start.body.otpauthUri).toContain('otpauth://totp/');
    expect(start.body.qrCode).toMatch(/^data:image\/png;base64,/);

    // not active yet: a password-only sign-in still works, and the pending secret is not stored in clear
    let row = await t.db.pool.query('SELECT totp_enabled, totp_secret, totp_pending_secret FROM users WHERE id = $1', [u.id]);
    expect(row.rows[0].totp_enabled).toBe(false);
    expect(row.rows[0].totp_pending_secret).toMatch(/^v1:/);
    expect(row.rows[0].totp_pending_secret).not.toContain(start.body.secret);

    expect((await t.request.post('/api/auth/totp-confirm').set(auth).send({ code: '000000' })).status).toBe(401);
    const done = await t.request.post('/api/auth/totp-confirm').set(auth).send({ code: code(start.body.secret) });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);

    row = await t.db.pool.query('SELECT totp_enabled, totp_secret, totp_pending_secret FROM users WHERE id = $1', [u.id]);
    expect(row.rows[0].totp_enabled).toBe(true);
    expect(row.rows[0].totp_secret).toMatch(/^v1:/);
    expect(row.rows[0].totp_secret).not.toContain(start.body.secret);
    expect(row.rows[0].totp_pending_secret).toBeNull();
    const codes = await t.db.pool.query('SELECT code_hash FROM recovery_codes WHERE user_id = $1', [u.id]);
    expect(codes.rows).toHaveLength(10);
    for (const c of done.body.recoveryCodes) expect(JSON.stringify(codes.rows)).not.toContain(c);

    // the next sign-in asks for the second factor
    const next = await login(u.email);
    expect(next.body.requiresTotp).toBe(true);
    expect((await verify({ tempToken: next.body.tempToken, code: code(start.body.secret, 1) })).status).toBe(200);
  });

  it('enrolment cannot be started twice; recovery codes can be replaced, and the old ones stop working', async () => {
    const u = await newUser();
    const auth = bearer((await login(u.email)).body.token);
    const start = await t.request.post('/api/auth/totp-enroll').set(auth).send({ password: TEST_PASSWORD });
    expect((await t.request.post('/api/auth/recovery-codes').set(auth).send({ password: TEST_PASSWORD })).status).toBe(409); // not enrolled yet
    const done = await t.request.post('/api/auth/totp-confirm').set(auth).send({ code: code(start.body.secret) });
    const old = done.body.recoveryCodes[0] as string;
    expect((await t.request.post('/api/auth/totp-enroll').set(auth).send({ password: TEST_PASSWORD })).status).toBe(409);
    expect((await t.request.post('/api/auth/recovery-codes').set(auth).send({ password: 'wrong-password' })).status).toBe(401);
    const fresh = await t.request.post('/api/auth/recovery-codes').set(auth).send({ password: TEST_PASSWORD });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const a = await login(u.email);
    expect((await verify({ tempToken: a.body.tempToken, recoveryCode: old })).status).toBe(401);
    const b = await login(u.email);
    expect((await verify({ tempToken: b.body.tempToken, recoveryCode: fresh.body.recoveryCodes[0] })).status).toBe(200);
  });

  it('a recovery code signs in once and is spent', async () => {
    const u = await newUser();
    const auth = bearer((await login(u.email)).body.token);
    const start = await t.request.post('/api/auth/totp-enroll').set(auth).send({ password: TEST_PASSWORD });
    const done = await t.request.post('/api/auth/totp-confirm').set(auth).send({ code: code(start.body.secret) });
    const [first] = done.body.recoveryCodes as string[];

    const a = await login(u.email);
    const used = await verify({ tempToken: a.body.tempToken, recoveryCode: first });
    expect(used.status).toBe(200);
    const b = await login(u.email);
    expect((await verify({ tempToken: b.body.tempToken, recoveryCode: first })).status).toBe(401);
    const spent = await t.db.pool.query('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL', [u.id]);
    expect(spent.rows[0].n).toBe(1);
  });

  it('when the administrator requires MFA, a user without it is taken through enrolment before any session exists', async () => {
    await t.db.pool.query(`INSERT INTO system_settings (id, mfa_required) VALUES ('default', true)
                           ON CONFLICT (id) DO UPDATE SET mfa_required = true`);
    try {
      const u = await newUser();
      const r = await login(u.email);
      expect(r.status).toBe(200);
      expect(r.body.token).toBeUndefined();
      expect(r.body.requireTotpSetup).toBe(true);
      expect(r.body.qrCode).toMatch(/^data:image\/png;base64,/);
      expect((await t.request.get('/api/samples').set(bearer(r.body.tempToken))).status).toBe(401);

      expect((await t.request.post('/api/auth/totp-setup').send({ tempToken: r.body.tempToken, code: '000000' })).status).toBe(401);
      const done = await t.request.post('/api/auth/totp-setup').send({ tempToken: r.body.tempToken, code: code(r.body.secret) });
      expect(done.status).toBe(200);
      expect(done.body.token).toBeTruthy();
      expect(done.body.recoveryCodes).toHaveLength(10);
      expect((await t.request.get('/api/samples').set(bearer(done.body.token))).status).toBe(200);
    } finally {
      await t.db.pool.query("UPDATE system_settings SET mfa_required = false WHERE id = 'default'");
    }
  });
});

describe('sessions', () => {
  it('GET /auth/me describes the session and the user, with no secret or counter in it', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    const me = await t.request.get('/api/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: u.id, email: u.email, role: 'Analyst' });
    expect(me.body.session.id).toMatch(/^ses-/);
    expect(me.body.session.idleTimeoutMinutes).toBeGreaterThan(0);
    expect(new Date(me.body.session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(me.body.mustChangePassword).toBe(false);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|totpSecret|failedAttempts|lockedAt/);
  });

  it('logout ends the session on the server: the same token is refused afterwards, and the logout is audited', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(200);
    const out = await t.request.post('/api/auth/logout').set(bearer(token));
    expect(out.status).toBe(200);
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(401);
    const sid = (await t.db.pool.query('SELECT id FROM sessions WHERE user_id = $1', [u.id])).rows[0].id;
    const events = await t.db.pool.query("SELECT event_type, outcome, session_id FROM security_events WHERE actor_id = $1 AND event_type IN ('AUTH_LOGIN', 'AUTH_LOGOUT') ORDER BY sequence", [u.id]);
    expect(events.rows).toEqual([
      { event_type: 'AUTH_LOGIN', outcome: 'success', session_id: sid },
      { event_type: 'AUTH_LOGOUT', outcome: 'success', session_id: sid },
    ]);
  });

  it('the idle timeout is enforced by the server, and re-authentication revives the same session id', async () => {
    const u = await newUser();
    const first = (await login(u.email)).body.token;
    const sid = (await t.request.get('/api/auth/me').set(bearer(first))).body.session.id;
    await t.db.pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [sid]);

    const idle = await t.request.get('/api/samples').set(bearer(first));
    expect(idle.status).toBe(401);
    expect(idle.body.code).toBe('SESSION_IDLE');

    expect((await t.request.post('/api/auth/reauth').set(bearer(first)).send({ password: 'wrong-password' })).status).toBe(401);
    const re = await t.request.post('/api/auth/reauth').set(bearer(first)).send({ password: TEST_PASSWORD });
    expect(re.status).toBe(200);
    expect(re.body.session.id).toBe(sid);
    expect((await t.request.get('/api/samples').set(bearer(re.body.token))).status).toBe(200);
    expect((await t.request.get('/api/auth/me').set(bearer(re.body.token))).body.session.id).toBe(sid);
  });

  it('re-authentication of a TOTP user needs a fresh code', async () => {
    const u = await newUser(); await enableTotp(u.id);
    const r = await login(u.email);
    const token = (await verify({ tempToken: r.body.tempToken, code: code() })).body.token;
    const sid = (await t.request.get('/api/auth/me').set(bearer(token))).body.session.id;
    await t.db.pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [sid]);
    expect((await t.request.post('/api/auth/reauth').set(bearer(token)).send({ password: TEST_PASSWORD })).status).toBe(401);
    expect((await t.request.post('/api/auth/reauth').set(bearer(token)).send({ password: TEST_PASSWORD, code: code(SECRET, 1) })).status).toBe(200);
  });

  it('the absolute session length follows the policy', async () => {
    await t.db.pool.query(`INSERT INTO system_settings (id, session_absolute_hours) VALUES ('default', 1) ON CONFLICT (id) DO UPDATE SET session_absolute_hours = 1`);
    try {
      const u = await newUser();
      const r = await login(u.email);
      const left = new Date(r.body.session.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(55 * 60_000);
      expect(left).toBeLessThanOrEqual(60 * 60_000);
    } finally {
      await t.db.pool.query("UPDATE system_settings SET session_absolute_hours = 12 WHERE id = 'default'");
    }
  });

  it('the absolute limit cannot be extended by re-authentication', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    const sid = (await t.request.get('/api/auth/me').set(bearer(token))).body.session.id;
    await t.db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sid]);
    const gone = await t.request.get('/api/samples').set(bearer(token));
    expect(gone.status).toBe(401);
    expect(gone.body.code).toBe('SESSION_EXPIRED');
    expect((await t.request.post('/api/auth/reauth').set(bearer(token)).send({ password: TEST_PASSWORD })).status).toBe(401);
  });

  it('a deactivated user loses the session at once', async () => {
    const u = await newUser();
    const token = (await login(u.email)).body.token;
    await t.db.pool.query('UPDATE users SET active = false WHERE id = $1', [u.id]);
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(401);
    expect((await login(u.email)).status).toBe(401);
  });
});
