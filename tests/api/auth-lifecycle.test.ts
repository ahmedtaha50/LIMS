/**
 * Roadmap M05 (r1-identity): user lifecycle (create, forced password change, policy and history, reset, deactivate, unlock),
 * the split between the sign-in lockout and the signing lockout, training certification, and what the API may serialize.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { insertActiveSpec, race, uniq, receiveSample } from '../helpers/fixtures';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
let t: TestApp;
let seq = 0;
beforeAll(async () => {
  t = await startTestApp();
  // Cache the five tokens now: building a header inside `request.get(...).set(await t.auth(...))` would otherwise log in while that request waits.
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});

async function newUser(role = 'Analyst', trained = true) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-l${process.pid}-${n}`;
  const email = `l${process.pid}.${n}@gxp.test`;
  await t.db.pool.query(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `uid-${id}`, `Lifecycle Test ${n}`, role, email, generatePasswordHash(TEST_PASSWORD), trained],
  );
  return { id, email };
}
const login = (email: string, password = TEST_PASSWORD) => t.request.post('/api/auth/login-local').send({ email, password });
const tokenOf = async (email: string) => (await login(email)).body.token as string;
const countAudit = async (where: string, params: unknown[]) =>
  (await t.db.pool.query(`SELECT count(*)::int AS n FROM audit_trail WHERE ${where}`, params)).rows[0].n as number;
const countEvents = async (where: string, params: unknown[]) =>
  (await t.db.pool.query(`SELECT count(*)::int AS n FROM security_events WHERE ${where}`, params)).rows[0].n as number;

describe('serialization: no secret or counter leaves the API', () => {
  const FORBIDDEN = ['passwordHash', 'password_hash', 'totpSecret', 'totp_secret', 'totpPendingSecret', 'totpLastStep',
    'failedAttempts', 'lockedAt', 'loginFailedAttempts', 'loginLockedUntil', 'codeHash'];
  const keysOf = (v: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach(x => keysOf(x, into));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { into.add(k); keysOf(x, into); }
    return into;
  };

  it('GET /training as an Analyst has no totpSecret, failedAttempts or lockedAt (M05 acceptance)', async () => {
    await t.db.pool.query(
      `UPDATE users SET totp_secret = 'LEAKCHECKSECRETBASE32AAAA', totp_enabled = true, failed_attempts = 2, locked_at = now() + interval '1 hour' WHERE id = 'usr-analyst2'`);
    try {
      const res = await t.request.get('/api/training').set(await t.auth('analyst1@gxp.com'));
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThan(0);
      const text = JSON.stringify(res.body);
      for (const needle of ['totpSecret', 'failedAttempts', 'lockedAt', 'passwordHash', 'LEAKCHECKSECRETBASE32AAAA']) expect(text).not.toContain(needle);
      for (const u of res.body.users) expect(Object.keys(u).sort()).toEqual(['hasCompletedSoftwareTraining', 'id', 'name', 'role']);
    } finally {
      await t.db.pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false, failed_attempts = 0, locked_at = NULL WHERE id = 'usr-analyst2'");
    }
  });

  it('GET /admin/users shows account state to Admin and QA but never a secret or a counter', async () => {
    await t.db.pool.query("UPDATE users SET totp_secret = 'LEAKCHECKSECRETBASE32AAAA', totp_enabled = true WHERE id = 'usr-analyst2'");
    try {
      for (const who of ['admin@gxp.com', 'qa@gxp.com']) {
        const res = await t.request.get('/api/admin/users').set(await t.auth(who));
        expect(res.status).toBe(200);
        const keys = keysOf(res.body);
        for (const f of FORBIDDEN) expect(keys.has(f), `${who} sees ${f}`).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain('LEAKCHECKSECRETBASE32AAAA');
        const row = res.body.find((u: any) => u.id === 'usr-analyst2');
        expect(row).toMatchObject({ mfaEnabled: true, active: true });
        expect(typeof row.version).toBe('number');
      }
      expect((await t.request.get('/api/admin/users').set(await t.auth('analyst1@gxp.com'))).status).toBe(403);
    } finally {
      await t.db.pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = 'usr-analyst2'");
    }
  });

  it('no GET route without path parameters returns a secret-bearing key to an Administrator', async () => {
    const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'route-table.json'), 'utf8')).routes as Array<{ method: string; path: string }>;
    const gets = table.filter(r => r.method === 'GET' && !r.path.includes(':'));
    expect(gets.length).toBeGreaterThan(10);
    const admin = await t.auth('admin@gxp.com');
    const offenders: string[] = [];
    for (const r of gets) {
      const res = await t.request.get(r.path).set(admin);
      if (res.status !== 200) continue;
      const found = FORBIDDEN.filter(f => keysOf(res.body).has(f));
      if (found.length) offenders.push(`${r.path}: ${found.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('administrator creates a user', () => {
  const NEW_EMAIL = 'Nora.New@gxp.test';
  let userId = '';
  let temporary = '';
  const STRONG = 'Quartz-Meadow-47!';
  const CURRENT = 'Harbor-Violet-58?'; // the password after the history test below

  it('returns a temporary password once and the new account must change it (M05 acceptance)', async () => {
    const admin = await t.auth('admin@gxp.com');
    const res = await t.request.post('/api/admin/users').set(admin)
      .send({ name: 'Nora New', email: NEW_EMAIL, role: 'Analyst', reason: 'New analyst joins QC', password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    userId = res.body.user.id;
    temporary = res.body.temporaryPassword;
    expect(temporary.length).toBeGreaterThanOrEqual(14);
    expect(res.body.user).toMatchObject({ email: 'nora.new@gxp.test', role: 'Analyst', active: true, mustChangePassword: true, hasCompletedSoftwareTraining: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash/);
    // the stored hash is salted scrypt and the clear text is nowhere in the database
    const row = await t.db.pool.query('SELECT password_hash, must_change_password FROM users WHERE id = $1', [userId]);
    expect(row.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(row.rows[0].must_change_password).toBe(true);
    expect(await countAudit("entity = 'User' AND entity_id = $1 AND action = 'Create'", [userId])).toBe(1);
    const stored = await t.db.pool.query("SELECT old_value, new_value FROM audit_trail WHERE entity = 'User' AND entity_id = $1 AND action = 'Create'", [userId]);
    expect(JSON.stringify(stored.rows)).not.toContain(temporary);
  });

  it('until the password is changed every other call is 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const ok = await login(NEW_EMAIL.toUpperCase(), temporary); // sign-in ignores the case of the address
    expect(ok.status).toBe(200);
    expect(ok.body.mustChangePassword).toBe(true);
    const auth = bearer(ok.body.token);
    for (const url of ['/api/samples', '/api/training', '/api/admin/users']) {
      const res = await t.request.get(url).set(auth);
      expect(res.status, url).toBe(403);
      expect(res.body.code, url).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await t.request.get('/api/auth/me').set(auth)).status).toBe(200);
  });

  it('the new password must satisfy the policy: length, classes, common passwords, the address, the history', async () => {
    const auth = bearer((await t.request.post('/api/auth/login-local').send({ email: NEW_EMAIL, password: temporary })).body.token);
    const change = (newPassword: string, currentPassword = temporary) => t.request.post('/api/auth/change-password').set(auth).send({ currentPassword, newPassword });
    for (const weak of ['Ab1!', 'password123!A', 'nora.new-Passw0rd!', 'alllowercase-nodigits', temporary]) {
      const res = await change(weak);
      expect(res.status, weak).toBe(400);
      expect(res.body.code, weak).toBe('PASSWORD_POLICY');
    }
    expect((await change(STRONG, 'not-the-current-one')).status).toBe(401);
    const ok = await change(STRONG);
    expect(ok.status).toBe(200);

    expect((await t.request.get('/api/samples').set(auth)).status).toBe(200);
    expect((await t.request.get('/api/auth/me').set(auth)).body.mustChangePassword).toBe(false);
    expect((await t.request.post('/api/auth/login-local').send({ email: NEW_EMAIL, password: temporary })).status).toBe(401);
    expect((await login(NEW_EMAIL, STRONG)).status).toBe(200);
    expect(await countAudit("entity = 'User' AND entity_id = $1 AND action = 'PasswordChanged'", [userId])).toBe(1);
  });

  it('a password used before is refused (history) and a change ends the other sessions', async () => {
    const a = (await login(NEW_EMAIL, STRONG)).body.token as string;
    const b = (await login(NEW_EMAIL, STRONG)).body.token as string;
    // the credentials in this test are the ones from the previous test
    const next = CURRENT;
    const res = await t.request.post('/api/auth/change-password').set(bearer(b)).send({ currentPassword: STRONG, newPassword: next });
    expect(res.status).toBe(200);
    expect((await t.request.get('/api/samples').set(bearer(a))).status).toBe(401); // the other session ended
    expect((await t.request.get('/api/samples').set(bearer(b))).status).toBe(200); // the one that changed it did not
    const back = await t.request.post('/api/auth/change-password').set(bearer(b)).send({ currentPassword: next, newPassword: STRONG });
    expect(back.status).toBe(400);
    expect(back.body.code).toBe('PASSWORD_POLICY');
    expect(JSON.stringify(back.body)).toMatch(/recent|previous|reuse/i);
  });

  it('the address is unique without regard to case', async () => {
    const admin = await t.auth('admin@gxp.com');
    const res = await t.request.post('/api/admin/users').set(admin)
      .send({ name: 'Someone Else', email: 'NORA.NEW@GXP.TEST', role: 'Analyst', reason: 'duplicate attempt', password: TEST_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_IN_USE');
    const dup = await t.db.pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'nora.new@gxp.test'");
    expect(dup.rows[0].n).toBe(1);
  });

  it('two simultaneous creations of the same address: one account, one 409', async () => {
    const admin = await t.auth('admin@gxp.com');
    const body = { name: 'Race Person', email: 'race.person@gxp.test', role: 'Analyst', reason: 'race', password: TEST_PASSWORD };
    const statuses = await race(2, () => t.request.post('/api/admin/users').set(admin).send(body));
    expect(statuses).toEqual([201, 409]);
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'race.person@gxp.test'")).rows[0].n).toBe(1);
  });

  it('only an Administrator creates users; the body is strict; a wrong administrator password creates nothing', async () => {
    const body = { name: 'X Person', email: 'x.person@gxp.test', role: 'Analyst', reason: 'test', password: TEST_PASSWORD };
    expect((await t.request.post('/api/admin/users').set(await t.auth('analyst1@gxp.com')).send(body)).status).toBe(403);
    expect((await t.request.post('/api/admin/users').set(await t.auth('qa@gxp.com')).send(body)).status).toBe(403);
    const admin = await t.auth('admin@gxp.com');
    expect((await t.request.post('/api/admin/users').set(admin).send({ ...body, role: 'Root' })).status).toBe(400);
    expect((await t.request.post('/api/admin/users').set(admin).send({ ...body, active: true })).status).toBe(400);
    expect((await t.request.post('/api/admin/users').set(admin).send({ ...body, password: 'wrong-admin-password' })).status).toBe(401);
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'x.person@gxp.test'")).rows[0].n).toBe(0);
  });

  it('deactivation needs a reason and the current version, ends the sessions and is audited; reactivation works', async () => {
    const admin = await t.auth('admin@gxp.com');
    const live = (await login(NEW_EMAIL, CURRENT)).body.token as string; // the password chosen in the previous tests
    expect((await t.request.get('/api/samples').set(bearer(live))).status).toBe(200);
    const v = (await t.request.get('/api/admin/users').set(admin)).body.find((u: any) => u.id === userId).version as number;
    const put = (body: Record<string, unknown>) => t.request.put(`/api/admin/users/${userId}`).set(admin).send({ reason: 'Left the laboratory', password: TEST_PASSWORD, ...body });

    expect((await put({ active: false, expectedVersion: v - 1 })).status).toBe(409);
    expect((await put({ active: false })).status).toBe(400);
    expect((await put({ expectedVersion: v })).status).toBe(400); // nothing to change
    expect((await put({ active: false, expectedVersion: v, reason: '' })).status).toBe(400);
    expect(await countAudit("entity = 'User' AND entity_id = $1 AND action = 'Update'", [userId])).toBe(0); // refused attempts leave no entry

    const done = await put({ active: false, expectedVersion: v });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ active: false, version: v + 1 });
    expect((await t.request.get('/api/samples').set(bearer(live))).status).toBe(401);
    const refused = await login(NEW_EMAIL, CURRENT);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('ACCOUNT_DISABLED');
    const audit = await t.db.pool.query("SELECT reason, old_value, new_value FROM audit_trail WHERE entity = 'User' AND entity_id = $1 AND action = 'Update'", [userId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toBe('Left the laboratory');
    expect(audit.rows[0].new_value).toContain('"active":false');

    const back = await put({ active: true, expectedVersion: v + 1, reason: 'Returned from leave' });
    expect(back.status).toBe(200);
    expect(back.body.user.active).toBe(true);
    expect((await login(NEW_EMAIL, CURRENT)).status).toBe(200);
  });

  it('an administrator cannot change their own role or deactivate themselves', async () => {
    const admin = await t.auth('admin@gxp.com');
    const me = (await t.request.get('/api/admin/users').set(admin)).body.find((u: any) => u.id === 'usr-admin');
    for (const body of [{ active: false }, { role: 'Analyst' }]) {
      const res = await t.request.put('/api/admin/users/usr-admin').set(admin)
        .send({ ...body, reason: 'testing', expectedVersion: me.version, password: TEST_PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SELF_CHANGE_FORBIDDEN');
    }
  });

  it('a role change takes effect on the next call and ends the target user\'s sessions', async () => {
    const admin = await t.auth('admin@gxp.com');
    const u = await newUser('Analyst');
    const token = await tokenOf(u.email);
    const v = (await t.request.get('/api/admin/users').set(admin)).body.find((x: any) => x.id === u.id).version;
    const res = await t.request.put(`/api/admin/users/${u.id}`).set(admin).send({ role: 'Reviewer', reason: 'Promoted to reviewer', expectedVersion: v, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('Reviewer');
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(401);
  });
});

describe('password policy engine', () => {
  const settings = { minPasswordLength: 8, requireUppercase: true, requireNumbers: true, requireSymbols: true, passwordHistoryCount: 5 };

  it('every generated temporary password satisfies the policy and starts with a letter', async () => {
    const { checkPasswordPolicy, generateTemporaryPassword } = await import('../../src/server/auth/passwordPolicy');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = generateTemporaryPassword();
      seen.add(pw);
      expect(pw).toHaveLength(18);
      expect(pw[0]).toMatch(/[A-Z]/);
      expect(checkPasswordPolicy(pw, { settings, email: 'someone@gxp.test', name: 'Some One' }), pw).toEqual([]);
    }
    expect(seen.size).toBe(200);
  });

  it('applies the configured rules, the common-password screen and the personal-data rule', async () => {
    const { checkPasswordPolicy } = await import('../../src/server/auth/passwordPolicy');
    const rules = (pw: string, s = settings) => checkPasswordPolicy(pw, { settings: s, email: 'ahmed.taha@gxp.test', name: 'Ahmed Taha' });
    expect(rules('Short1!')).toHaveLength(1);
    expect(rules('longenough-but-lower1!')).toEqual(['Include at least one uppercase letter (A-Z).']);
    expect(rules('Quartz-Meadow-47!')).toEqual([]);
    expect(rules('quartz meadow', { ...settings, requireUppercase: false, requireNumbers: false, requireSymbols: false })).toEqual([]); // classes are optional when the policy says so
    expect(rules('Welcome2026!').join(' ')).toMatch(/too common/);
    expect(rules('Qwerty-Qwerty-1!').join(' ')).toMatch(/too common/);
    expect(rules('Ahmed-Meadow-47!').join(' ')).toMatch(/e-mail address or your name/);
    expect(rules('x'.repeat(129) + 'A1!').join(' ')).toMatch(/at most 128/);
    // a configured minimum above the floor is honoured, one below it is not
    expect(rules('Abcdef1!', { ...settings, minPasswordLength: 12 }).join(' ')).toMatch(/at least 12/);
    expect(rules('Ab1!', { ...settings, minPasswordLength: 6 }).join(' ')).toMatch(/at least 8/);
  });
});

describe('password aging', () => {
  it('a password older than the policy allows must be changed before anything else; changing it restores access', async () => {
    const u = await newUser();
    await t.db.pool.query("UPDATE users SET password_changed_at = now() - interval '100 days' WHERE id = $1", [u.id]);
    const r = await login(u.email);
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true);
    const auth = bearer(r.body.token);
    const blocked = await t.request.get('/api/samples').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const ok = await t.request.post('/api/auth/change-password').set(auth).send({ currentPassword: TEST_PASSWORD, newPassword: 'Amber-Falcon-2026!' });
    expect(ok.status).toBe(200);
    expect((await t.request.get('/api/samples').set(auth)).status).toBe(200);
  });
});

describe('administrator resets, unlocks and resets MFA', () => {
  const versionOf = async (id: string) => (await t.request.get('/api/admin/users').set(await t.auth('admin@gxp.com'))).body.find((u: any) => u.id === id).version as number;

  it('reset password issues a new temporary password, forces a change and ends the sessions', async () => {
    const u = await newUser();
    const token = await tokenOf(u.email);
    const admin = await t.auth('admin@gxp.com');
    const expectedVersion = await versionOf(u.id);
    const res = await t.request.post(`/api/admin/users/${u.id}/reset-password`).set(admin)
      .send({ reason: 'User forgot the password', expectedVersion, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(14);
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(401);
    expect((await login(u.email)).status).toBe(401);
    const fresh = await login(u.email, res.body.temporaryPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.body.mustChangePassword).toBe(true);
    expect(await countAudit("entity = 'User' AND entity_id = $1 AND action = 'PasswordReset'", [u.id])).toBe(1);
    // stale version
    const stale = await t.request.post(`/api/admin/users/${u.id}/reset-password`).set(admin).send({ reason: 'again', expectedVersion: 1, password: TEST_PASSWORD });
    expect(stale.status).toBe(409);
  });

  it('unlock clears both the sign-in lock and the signing lock', async () => {
    const u = await newUser();
    await t.db.pool.query(
      `UPDATE users SET login_failed_attempts = 3, login_locked_until = now() + interval '10 minutes', failed_attempts = 3, locked_at = now() + interval '10 minutes' WHERE id = $1`, [u.id]);
    expect((await login(u.email)).body.code).toBe('ACCOUNT_LOCKED');
    const admin = await t.auth('admin@gxp.com');
    const expectedVersion = await versionOf(u.id);
    const res = await t.request.post(`/api/admin/users/${u.id}/unlock`).set(admin)
      .send({ reason: 'Identity confirmed in person', expectedVersion, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const row = (await t.db.pool.query('SELECT login_failed_attempts, login_locked_until, failed_attempts, locked_at FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ login_failed_attempts: 0, login_locked_until: null, failed_attempts: 0, locked_at: null });
    expect((await login(u.email)).status).toBe(200);
    expect(await countAudit("entity = 'User' AND entity_id = $1 AND action = 'Unlock'", [u.id])).toBe(1);
  });

  it('reset MFA removes the authenticator and the recovery codes and ends the sessions', async () => {
    const u = await newUser();
    await t.db.pool.query("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', totp_enabled = true WHERE id = $1", [u.id]);
    await t.db.pool.query("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, 'x')", [`rc-${u.id}`, u.id]);
    const admin = await t.auth('admin@gxp.com');
    const expectedVersion = await versionOf(u.id);
    const res = await t.request.post(`/api/admin/users/${u.id}/reset-mfa`).set(admin)
      .send({ reason: 'Phone lost', expectedVersion, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const row = (await t.db.pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ totp_secret: null, totp_enabled: false });
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
    expect((await login(u.email)).body.token).toBeTruthy();
  });

  it('two administrators cannot deactivate each other at the same time and leave the system without one', async () => {
    const others = (await t.db.pool.query("SELECT id FROM users WHERE role = 'Admin' AND active")).rows.map(r => r.id as string);
    await t.db.pool.query('UPDATE users SET active = false WHERE id = ANY($1)', [others]);
    try {
      for (let round = 0; round < 5; round++) {
        const a = await newUser('Admin'); const b = await newUser('Admin');
        const ta = await tokenOf(a.email); const tb = await tokenOf(b.email);
        const list = (await t.request.get('/api/admin/users').set(bearer(ta))).body as any[];
        const va = list.find(u => u.id === a.id).version, vb = list.find(u => u.id === b.id).version;
        const results = await Promise.all([
          t.request.put(`/api/admin/users/${b.id}`).set(bearer(ta)).send({ active: false, reason: 'race a', expectedVersion: vb, password: TEST_PASSWORD }),
          t.request.put(`/api/admin/users/${a.id}`).set(bearer(tb)).send({ active: false, reason: 'race b', expectedVersion: va, password: TEST_PASSWORD }),
        ]);
        expect(results.filter(r => r.status === 200), `round ${round}: ${results.map(r => r.status)}`).toHaveLength(1);
        expect([401, 409]).toContain(results.find(r => r.status !== 200)!.status);
        const active = (await t.db.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'Admin' AND active AND id IN ($1, $2)", [a.id, b.id])).rows[0].n;
        expect(active, `round ${round}`).toBe(1);
        await t.db.pool.query('UPDATE users SET active = false WHERE id IN ($1, $2)', [a.id, b.id]);
      }
    } finally {
      await t.db.pool.query('UPDATE users SET active = true WHERE id = ANY($1)', [others]);
    }
  });
});

describe('security policies', () => {
  it('are read and written with the current version and a strict body, with the administrator password', async () => {
    const admin = await t.auth('admin@gxp.com');
    const before = (await t.request.get('/api/admin/settings').set(admin)).body;
    expect(before.version).toBeGreaterThanOrEqual(1);
    expect(before).toMatchObject({ mfaRequired: false, passwordHistoryCount: expect.any(Number), lockoutMinutes: expect.any(Number) });
    const next = { ...before, lockoutMinutes: 20, expectedVersion: before.version, password: TEST_PASSWORD, reason: 'Tighten lockout' };
    delete (next as any).version; delete (next as any).id; delete (next as any).updatedAt;
    expect((await t.request.put('/api/admin/settings').set(admin).send({ ...next, expectedVersion: before.version + 5 })).status).toBe(409);
    expect((await t.request.put('/api/admin/settings').set(admin).send({ ...next, surprise: 1 })).status).toBe(400);
    expect((await t.request.put('/api/admin/settings').set(admin).send({ ...next, sessionTimeoutMinutes: 0 })).status).toBe(400);
    expect((await t.request.put('/api/admin/settings').set(await t.auth('qa@gxp.com')).send(next)).status).toBe(403);
    const ok = await t.request.put('/api/admin/settings').set(admin).send(next);
    expect(ok.status).toBe(200);
    const after = (await t.request.get('/api/admin/settings').set(admin)).body;
    expect(after).toMatchObject({ lockoutMinutes: 20, version: before.version + 1 });
    expect(await countAudit("entity = 'SystemSettings' AND action = 'Update' AND reason = 'Tighten lockout'", [])).toBe(1);
    await t.request.put('/api/admin/settings').set(admin).send({ ...next, lockoutMinutes: 15, expectedVersion: after.version, reason: 'Restore default' });
  });
});

describe('sign-in lockout', () => {
  it('three bad passwords lock the account for a limited time, the right password is refused during the lock, and the lock ends by itself', async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) {
      const bad = await login(u.email, `wrong-${i}`);
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await login(u.email);
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);

    const row = (await t.db.pool.query('SELECT active, login_failed_attempts, login_locked_until > now() AS locked FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toEqual({ active: true, login_failed_attempts: 3, locked: true }); // the account is not deactivated

    await t.db.pool.query("UPDATE users SET login_locked_until = now() - interval '1 second' WHERE id = $1", [u.id]);
    expect((await login(u.email)).status).toBe(200);
    expect((await t.db.pool.query('SELECT login_failed_attempts FROM users WHERE id = $1', [u.id])).rows[0].login_failed_attempts).toBe(0);
  });

  it('after a lock has ended the count starts again: one failure does not re-lock', async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) await login(u.email, 'wrong');
    await t.db.pool.query("UPDATE users SET login_locked_until = now() - interval '1 second' WHERE id = $1", [u.id]);
    expect((await login(u.email, 'wrong')).body.code).toBe('INVALID_CREDENTIALS');
    expect((await login(u.email)).status).toBe(200);
  });

  it('failures and the lock are security events, one each, without the password; the counters are committed with them', async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) await login(u.email, `wrong-${i}`);
    expect(await countEvents("actor_id = $1 AND event_type = 'AUTH_LOGIN_FAILED'", [u.id])).toBe(3);
    expect(await countEvents("actor_id = $1 AND event_type = 'LOCKOUT'", [u.id])).toBe(1);
    await login(u.email); // refused during the lock: no further events
    expect(await countEvents("actor_id = $1 AND event_type IN ('AUTH_LOGIN_FAILED', 'LOCKOUT')", [u.id])).toBe(4);
    const all = (await t.db.pool.query('SELECT detail, ip, request_id FROM security_events WHERE actor_id = $1', [u.id])).rows;
    expect(JSON.stringify(all)).not.toContain('wrong-');
    expect(all.every(r => !!r.request_id)).toBe(true);
    const lock = (await t.db.pool.query("SELECT detail FROM security_events WHERE actor_id = $1 AND event_type = 'LOCKOUT'", [u.id])).rows[0];
    expect(JSON.parse(lock.detail)).toMatchObject({ scope: 'sign-in', attempts: 3, minutes: 15 });
    // failed sign-ins are not entries of the audit trail
    expect(await countAudit("user_id = $1 AND action IN ('AUTH_LOGIN_FAILED', 'LOCKOUT')", [u.id])).toBe(0);
  });

  it('an unknown address is a plain 401, no audit entry, and one security event that names the address that was typed', async () => {
    const audits = await countAudit('true', []);
    const events = await countEvents("event_type = 'AUTH_LOGIN_FAILED' AND actor_id IS NULL", []);
    const res = await login('nobody@gxp.test', 'whatever-password');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(await countAudit('true', [])).toBe(audits);
    expect(await countEvents("event_type = 'AUTH_LOGIN_FAILED' AND actor_id IS NULL", [])).toBe(events + 1);
    const last = (await t.db.pool.query("SELECT actor_label, detail FROM security_events WHERE actor_id IS NULL ORDER BY sequence DESC LIMIT 1")).rows[0];
    expect(last.actor_label).toBe('nobody@gxp.test');
    expect(last.detail).not.toContain('whatever-password');
  });
});

describe('signing lockout is separate from the sign-in lockout (M05 acceptance)', () => {
  async function submittedSampleFor(email: string) {
    const material = uniq('Lock-Material');
    await insertActiveSpec(t, material);
    const auth = await t.auth(email);
    const created = await t.request.post('/api/samples').set(auth).send({ material, batch: uniq('B') });
    expect(created.status).toBe(200);
    const sid = created.body.id as string;
    const version = async () => (await t.db.pool.query('SELECT version FROM samples WHERE id = $1', [sid])).rows[0].version as number;
    await receiveSample(t, sid, email);
    const submit = await t.request.post(`/api/samples/${sid}/transition`).set(auth).send({ action: 'submit', expectedVersion: await version() });
    expect(submit.status).toBe(200);
    // r1-results-oos: review needs every result entered.
    const [r] = (await t.db.pool.query('SELECT id, version FROM results WHERE sample_id = $1', [sid])).rows;
    expect((await t.request.put(`/api/samples/${sid}/results/${r.id}`).set(auth).send({ value: '100.0', reason: 'routine entry', expectedVersion: r.version })).status).toBe(200);
    const review = (password: string) => t.request.post(`/api/samples/${sid}/transition`).set(auth).send({ action: 'review', expectedVersion: 0, password });
    return { sid, auth, version, reviewWith: async (password: string) => t.request.post(`/api/samples/${sid}/transition`).set(auth).send({ action: 'review', expectedVersion: await version(), password }), review };
  }

  it('three bad signing passwords lock signing for 15 minutes but not sign-in, and the lock expires by itself', async () => {
    const s = await submittedSampleFor('analyst2@gxp.com');
    for (let i = 0; i < 3; i++) expect((await s.reviewWith(`bad-${i}`)).status).toBe(401);

    // sign-in is unaffected (the old code refused it for as long as locked_at was set, which is the defect)
    const again = await login('analyst2@gxp.com');
    expect(again.status).toBe(200);
    expect(again.body.token).toBeTruthy();

    const row = (await t.db.pool.query(
      `SELECT failed_attempts, extract(epoch FROM (locked_at - now())) AS secs, login_failed_attempts, login_locked_until, active FROM users WHERE id = 'usr-analyst2'`)).rows[0];
    expect(row.failed_attempts).toBe(3);
    expect(Number(row.secs)).toBeGreaterThan(14 * 60);
    expect(Number(row.secs)).toBeLessThanOrEqual(15 * 60);
    expect(row.login_failed_attempts).toBe(0);
    expect(row.login_locked_until).toBeNull();
    expect(row.active).toBe(true);

    // but signing is refused, even with the right password
    expect((await s.reviewWith(TEST_PASSWORD)).status).toBe(401);
    // the failures are audited and the counter survived the failed transaction
    expect(await countAudit("action = 'SignatureFailed' AND entity_id = $1", [s.sid])).toBe(3);

    await t.db.pool.query("UPDATE users SET locked_at = now() - interval '1 minute' WHERE id = 'usr-analyst2'");
    expect((await s.reviewWith(TEST_PASSWORD)).status).toBe(200);
    expect((await t.db.pool.query("SELECT failed_attempts FROM users WHERE id = 'usr-analyst2'")).rows[0].failed_attempts).toBe(0);
  });

  it('a signing lock never blocks a protected call, only signing', async () => {
    await t.db.pool.query("UPDATE users SET failed_attempts = 3, locked_at = now() + interval '10 minutes' WHERE id = 'usr-analyst1'");
    try {
      const token = await tokenOf('analyst1@gxp.com');
      expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(200);
    } finally {
      await t.db.pool.query("UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-analyst1'");
    }
  });
});

describe('training certification', () => {
  const certify = (as: string, userId: string, body: Record<string, unknown>) => t.request.post(`/api/training/${userId}/certify`).set(bearer(as)).send(body);

  it('records the certification and the audit entry, once per module, for an existing user', async () => {
    const qa = await newUser('QA');
    const target = await newUser('Analyst', false);
    const token = await tokenOf(qa.email);
    expect((await certify(token, target.id, { moduleName: 'LIMS Core Software' })).status).toBe(400); // password missing
    expect((await certify(token, target.id, { password: TEST_PASSWORD })).status).toBe(400); // module missing
    expect((await certify(token, target.id, { password: TEST_PASSWORD, moduleName: 'M', extra: 1 })).status).toBe(400); // strict
    expect((await certify(token, 'usr-does-not-exist', { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' })).status).toBe(404);

    const ok = await certify(token, target.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' });
    expect(ok.status).toBe(200);
    expect((await t.db.pool.query('SELECT has_completed_software_training FROM users WHERE id = $1', [target.id])).rows[0].has_completed_software_training).toBe(true);
    const rec = (await t.db.pool.query('SELECT module_name, status, certified_by FROM training_records WHERE user_id = $1', [target.id])).rows;
    expect(rec).toEqual([{ module_name: 'LIMS Core Software', status: 'Completed', certified_by: qa.id }]);
    // Since r2-docs-training (M28) the certification is signed on the training record it creates (entity TrainingRecord).
    expect(await countAudit("entity = 'TrainingRecord' AND action = 'Certify' AND entity_id IN (SELECT id FROM training_records WHERE user_id = $1)", [target.id])).toBe(1);

    const twice = await certify(token, target.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' });
    expect(twice.status).toBe(409);
  });

  it('refuses analysts, and refuses certifying oneself', async () => {
    const qa = await newUser('QA', false);
    const analyst = await newUser('Analyst', false);
    expect((await certify(await tokenOf(analyst.email), qa.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' })).status).toBe(403);
    const own = await certify(await tokenOf(qa.email), qa.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('SELF_CERTIFICATION_FORBIDDEN');
  });

  it('a wrong password counts toward the signing lock, which is committed and audited, and ends by itself', async () => {
    const qa = await newUser('QA');
    const target = await newUser('Analyst', false);
    const token = await tokenOf(qa.email);
    for (let i = 0; i < 3; i++) {
      const bad = await certify(token, target.id, { password: `bad-${i}`, moduleName: 'LIMS Core Software' });
      expect(bad.status).toBe(401);
    }
    expect((await t.db.pool.query('SELECT failed_attempts FROM users WHERE id = $1', [qa.id])).rows[0].failed_attempts).toBe(3);
    expect(await countAudit("action = 'SignatureFailed' AND user_id = $1", [qa.id])).toBe(3);
    expect(await countEvents("actor_id = $1 AND event_type = 'LOCKOUT' AND detail LIKE '%signing%'", [qa.id])).toBe(1);
    const locked = await certify(token, target.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('SIGNING_LOCKED');
    expect((await login(qa.email)).status).toBe(200); // sign-in still works
    await t.db.pool.query("UPDATE users SET locked_at = now() - interval '1 minute' WHERE id = $1", [qa.id]);
    expect((await certify(token, target.id, { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' })).status).toBe(200);
  });

  it('a non-string password is a 400 and the server stays up', async () => {
    const qa = await newUser('QA');
    const res = await certify(await tokenOf(qa.email), 'usr-analyst1', { password: 12345, moduleName: 'LIMS Core Software' });
    expect(res.status).toBe(400);
    expect((await t.request.get('/api/health')).status).toBe(200);
  });
});

describe('administration extras that used to be broken or invented', () => {
  it('the broadcast route exists, is Administrator-only, is audited and becomes one system.alert event with the audit entry', async () => {
    const msg = { message: 'Maintenance at 17:00. Please save your work.' };
    expect((await t.request.post('/api/admin/broadcast').set(await t.auth('analyst1@gxp.com')).send(msg)).status).toBe(403);
    expect((await t.request.post('/api/admin/broadcast').set(await t.auth('admin@gxp.com')).send({ ...msg, extra: 1 })).status).toBe(400);
    const ok = await t.request.post('/api/admin/broadcast').set(await t.auth('admin@gxp.com')).send(msg);
    expect(ok.status).toBe(200);
    // The alert is an outbox event written in the transaction of the audit entry (r2-events); the dispatcher turns it into a
    // persistent notification for every active user after COMMIT.
    const sent = (await t.db.pool.query("SELECT payload, actor_id FROM outbox_events WHERE type = 'system.alert' AND payload->>'message' = $1", [msg.message])).rows;
    expect(sent).toEqual([{ payload: { message: msg.message }, actor_id: 'usr-admin' }]);
    expect(await countAudit("action = 'Broadcast' AND user_id = 'usr-admin'", [])).toBe(1);
  });

  it('the usage heatmap counts real audit entries only: nothing is invented', async () => {
    const res = await t.request.get('/api/admin/activity-heatmap').set(await t.auth('admin@gxp.com'));
    expect(res.status).toBe(200);
    const total = (res.body as Array<{ value: number }>).reduce((s, c) => s + c.value, 0);
    const real = (await t.db.pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n;
    expect(total).toBe(real); // old code added random numbers while there were fewer than 50 entries
    expect(real).toBeGreaterThan(0);
    expect((await t.request.get('/api/admin/activity-heatmap').set(await t.auth('qa@gxp.com'))).status).toBe(403);
  });
});

describe('concurrent sign-ins', () => {
  it('parallel wrong passwords cannot out-run the lock: the counter is exact', async () => {
    const u = await newUser();
    const statuses = await race(8, () => login(u.email, 'wrong-password'));
    expect(statuses.every(s => s === 401)).toBe(true);
    const row = (await t.db.pool.query('SELECT login_failed_attempts FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row.login_failed_attempts).toBeGreaterThanOrEqual(3);
    expect(row.login_failed_attempts).toBeLessThanOrEqual(8);
    expect((await login(u.email)).body.code).toBe('ACCOUNT_LOCKED');
  });
});
