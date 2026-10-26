/**
 * Roadmap M16 (keystore) and M05 (break-glass CLI): purpose keys, the versioned ciphertext format and key rotation,
 * and the operator CLI that works when no administrator can sign in. Real PostgreSQL for everything that touches rows.
 */
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

const KEY_A = 'first-generation-master-key-0123456789';
const KEY_B = 'second-generation-master-key-987654321';

describe('keystore', () => {
  it('derives independent keys per purpose and per generation', async () => {
    const { createKeystore, KEY_PURPOSES } = await import('../../src/server/crypto/keystore');
    const ks = createKeystore({ current: 2, keys: { 1: KEY_A, 2: KEY_B } });
    const keys = KEY_PURPOSES.map(p => ks.deriveKey(p).toString('hex'));
    expect(new Set(keys).size).toBe(KEY_PURPOSES.length);
    for (const k of keys) expect(k).toHaveLength(64);
    expect(ks.deriveKey('jwt').equals(ks.deriveKey('jwt'))).toBe(true);
    expect(ks.deriveKey('jwt', 'access').equals(ks.deriveKey('jwt', 'mfa'))).toBe(false);
    expect(ks.deriveKey('jwt', '', 1).equals(ks.deriveKey('jwt', '', 2))).toBe(false);
    expect(ks.deriveKey('jwt').equals(ks.deriveKey('jwt', '', 2))).toBe(true); // default is the current generation
  });

  it('writes v<generation>:... ciphertext, randomised, bound to its context, and refuses tampering', async () => {
    const { createKeystore, KeystoreError } = await import('../../src/server/crypto/keystore');
    const ks = createKeystore({ current: 1, keys: { 1: KEY_A } });
    const a = ks.encrypt('JBSWY3DPEHPK3PXP', 'users.totp_secret:usr-1');
    const b = ks.encrypt('JBSWY3DPEHPK3PXP', 'users.totp_secret:usr-1');
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(ks.decrypt(a, 'users.totp_secret:usr-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => ks.decrypt(a, 'users.totp_secret:usr-2')).toThrow(KeystoreError); // swapped between rows
    const parts = a.split(':');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    expect(() => ks.decrypt(parts.join(':'), 'users.totp_secret:usr-1')).toThrow(KeystoreError);
    expect(() => ks.decrypt('JBSWY3DPEHPK3PXP', 'x')).toThrow(KeystoreError); // not ciphertext
    expect(ks.isEncrypted(a)).toBe(true);
    expect(ks.isEncrypted('JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('rotation: v1 data stays readable, new data is v2, a v1 value can be moved to v2, and the old key ring alone cannot read v2 (M16 acceptance)', async () => {
    const { createKeystore, KeystoreError } = await import('../../src/server/crypto/keystore');
    const gen1 = createKeystore({ current: 1, keys: { 1: KEY_A } });
    const gen2 = createKeystore({ current: 2, keys: { 1: KEY_A, 2: KEY_B } });
    const old = gen1.encrypt('stored before rotation', 'ctx');
    expect(old.startsWith('v1:')).toBe(true);
    expect(gen2.decrypt(old, 'ctx')).toBe('stored before rotation');
    const fresh = gen2.encrypt('stored after rotation', 'ctx');
    expect(fresh.startsWith('v2:')).toBe(true);
    const moved = gen2.reencrypt(old, 'ctx');
    expect(moved.startsWith('v2:')).toBe(true);
    expect(gen2.decrypt(moved, 'ctx')).toBe('stored before rotation');
    expect(gen2.reencrypt(fresh, 'ctx')).toBe(fresh); // already current: unchanged
    expect(() => gen1.decrypt(fresh, 'ctx')).toThrow(KeystoreError);
  });

  it('refuses short keys, a current generation that is not in the ring, and an empty ring', async () => {
    const { createKeystore, KeystoreError } = await import('../../src/server/crypto/keystore');
    expect(() => createKeystore({ current: 1, keys: { 1: 'short' } })).toThrow(KeystoreError);
    expect(() => createKeystore({ current: 3, keys: { 1: KEY_A } })).toThrow(KeystoreError);
    expect(() => createKeystore({ current: 1, keys: {} })).toThrow(KeystoreError);
  });

  it('reads its ring from the environment: LIMS_KEYRING, else LIMS_MASTER_KEY, else JWT_SECRET', async () => {
    const { keyRingFromEnv, KeystoreError } = await import('../../src/server/crypto/keystore');
    expect(keyRingFromEnv({ LIMS_KEYRING: JSON.stringify({ current: 2, keys: { 1: KEY_A, 2: KEY_B } }), LIMS_MASTER_KEY: 'ignored-because-keyring-wins-0123456789' })).toEqual({ current: 2, keys: { 1: KEY_A, 2: KEY_B } });
    expect(keyRingFromEnv({ LIMS_MASTER_KEY: KEY_A, JWT_SECRET: 'x'.repeat(40) })).toEqual({ current: 1, keys: { 1: KEY_A } });
    expect(keyRingFromEnv({ JWT_SECRET: 'jwt-secret-used-as-master' })).toEqual({ current: 1, keys: { 1: 'jwt-secret-used-as-master' } });
    expect(() => keyRingFromEnv({})).toThrow(KeystoreError);
    expect(() => keyRingFromEnv({ LIMS_KEYRING: '{not json' })).toThrow(KeystoreError);
    expect(() => keyRingFromEnv({ LIMS_MASTER_KEY: 'short' })).toThrow(KeystoreError);
  });
});

describe('stored secrets across a key rotation', () => {
  let t: TestApp;
  beforeAll(async () => {
  t = await startTestApp();
  // Cache the five tokens now: building a header inside `request.get(...).set(await t.auth(...))` would otherwise log in while that request waits.
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});
  afterAll(async () => { (await import('../../src/server/crypto/keystore')).setKeystore(null); });

  it('moves every stored secret to the current generation, audits it, and nobody is locked out', async () => {
    const { createKeystore, getKeystore, setKeystore } = await import('../../src/server/crypto/keystore');
    const { rotateStoredSecrets } = await import('../../src/server/crypto/rotate');
    const { db } = await import('../../src/db/index');
    const { generatePasswordHash } = await import('../../src/db/utils');

    // a user with MFA enrolled under generation 1, and a stored AI key
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const id = 'usr-rot-1'; const email = 'rot1@gxp.test';
    const gen1 = getKeystore();
    expect(gen1.current).toBe(1);
    await t.db.pool.query(
      `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training, totp_secret, totp_enabled)
       VALUES ($1, $1, 'Rotation', 'Analyst', $2, $3, true, $4, true)`,
      [id, email, generatePasswordHash(TEST_PASSWORD), gen1.encrypt(secret, `users.totp_secret:${id}`)]);
    await t.db.pool.query(
      `INSERT INTO integration_settings (id, ai_api_key_enc) VALUES ('default', $1)
       ON CONFLICT (id) DO UPDATE SET ai_api_key_enc = EXCLUDED.ai_api_key_enc`, [gen1.encrypt('AIza-stored-key-0001', 'integration_settings.ai_api_key_enc:default')]);
    // and one plaintext secret from an installation older than the keystore
    await t.db.pool.query("UPDATE users SET totp_secret = $2, totp_enabled = true WHERE id = $1", ['usr-qa', secret]);

    const gen2 = createKeystore({ current: 2, keys: { 1: process.env.JWT_SECRET!, 2: KEY_B } });
    setKeystore(gen2);

    // v1 data is still readable under the new ring
    const r1 = await t.request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD });
    expect(r1.body.requiresTotp).toBe(true);
    const v1 = await t.request.post('/api/auth/totp-verify').send({ tempToken: r1.body.tempToken, code: generateSync({ secret }) });
    expect(v1.status).toBe(200);
    // and tokens issued before the rotation (generation 1 signing key) still work
    expect((await t.request.get('/api/samples').set({ Authorization: `Bearer ${v1.body.token}` })).status).toBe(200);

    const report = await rotateStoredSecrets(db, { actor: 'cli:tester', reason: 'Scheduled key rotation', keystore: gen2 });
    expect(report).toMatchObject({ generation: 2, totpSecrets: 2, apiKeys: 1 });

    const rows = (await t.db.pool.query("SELECT id, totp_secret FROM users WHERE id IN ($1, 'usr-qa')", [id])).rows;
    for (const r of rows) expect(r.totp_secret, r.id).toMatch(/^v2:/);
    const key = (await t.db.pool.query("SELECT ai_api_key_enc FROM integration_settings WHERE id = 'default'")).rows[0].ai_api_key_enc as string;
    expect(key.startsWith('v2:')).toBe(true);
    expect(gen2.decrypt(key, 'integration_settings.ai_api_key_enc:default')).toBe('AIza-stored-key-0001');

    const again = await rotateStoredSecrets(db, { actor: 'cli:tester', reason: 'Second run', keystore: gen2 });
    expect(again).toMatchObject({ totpSecrets: 0, apiKeys: 0 }); // nothing left to move

    const audit = await t.db.pool.query("SELECT user_id, entity, reason, new_value FROM audit_trail WHERE action = 'KEY_ROTATION' ORDER BY sequence");
    expect(audit.rows[0]).toMatchObject({ user_id: 'cli:tester', entity: 'Keystore', reason: 'Scheduled key rotation' });
    expect(audit.rows[0].new_value).not.toContain(KEY_B);

    // MFA still works after the rotation (next time step, the current one is spent)
    const r2 = await t.request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD });
    const v2 = await t.request.post('/api/auth/totp-verify').send({ tempToken: r2.body.tempToken, code: generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }) });
    expect(v2.status).toBe(200);
    // a session token signed with the new generation
    expect((await t.request.get('/api/samples').set({ Authorization: `Bearer ${v2.body.token}` })).status).toBe(200);
    await t.db.pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = 'usr-qa'");
  });
});

describe('break-glass CLI', () => {
  let t: TestApp;
  const OS_USER = os.userInfo().username;
  beforeAll(async () => { t = await startTestApp(); });

  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/server/admin-cli.ts'), ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, ...env },
  });
  const audit = async (where: string, params: unknown[]) => (await t.db.pool.query(`SELECT user_id, action, entity, entity_id, reason FROM audit_trail WHERE ${where} ORDER BY sequence`, params)).rows;

  it('needs a command, an address that exists and a reason', async () => {
    expect(cli([]).status).toBe(2);
    expect(cli(['reset-password', '--email', 'analyst1@gxp.com']).status).toBe(2); // no reason
    const unknown = cli(['reset-password', '--email', 'nobody@gxp.test', '--reason', 'test']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/no user/i);
  });

  it('reset-password prints a temporary password once, forces a change, ends sessions and records the operator', async () => {
    const before = (await t.request.post('/api/auth/login-local').send({ email: 'analyst2@gxp.com', password: TEST_PASSWORD })).body.token;
    const res = cli(['reset-password', '--email', 'analyst2@gxp.com', '--reason', 'Administrator locked out; identity checked in person']);
    expect(res.status, res.stderr).toBe(0);
    const temporary = /Temporary password: (\S+)/.exec(res.stdout)![1];
    expect(temporary.length).toBeGreaterThanOrEqual(14);

    expect((await t.request.get('/api/samples').set({ Authorization: `Bearer ${before}` })).status).toBe(401);
    const login = await t.request.post('/api/auth/login-local').send({ email: 'analyst2@gxp.com', password: temporary });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);

    const rows = await audit("entity = 'User' AND entity_id = 'usr-analyst2' AND action = 'PasswordReset'", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: `cli:${OS_USER}`, reason: 'Administrator locked out; identity checked in person' });
    expect(JSON.stringify(await audit('true', []))).not.toContain(temporary);
  });

  it('unlock clears both locks and reset-mfa removes the authenticator', async () => {
    await t.db.pool.query(
      `UPDATE users SET login_failed_attempts = 3, login_locked_until = now() + interval '10 minutes', failed_attempts = 3, locked_at = now() + interval '10 minutes',
              totp_secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', totp_enabled = true WHERE id = 'usr-reviewer'`);
    expect((await t.request.post('/api/auth/login-local').send({ email: 'reviewer@gxp.com', password: TEST_PASSWORD })).body.code).toBe('ACCOUNT_LOCKED');
    expect(cli(['unlock', '--email', 'reviewer@gxp.com', '--reason', 'Operator unlock']).status).toBe(0);
    expect(cli(['reset-mfa', '--email', 'reviewer@gxp.com', '--reason', 'Phone lost']).status).toBe(0);
    const row = (await t.db.pool.query('SELECT login_locked_until, locked_at, totp_secret, totp_enabled FROM users WHERE id = $1', ['usr-reviewer'])).rows[0];
    expect(row).toEqual({ login_locked_until: null, locked_at: null, totp_secret: null, totp_enabled: false });
    expect((await t.request.post('/api/auth/login-local').send({ email: 'reviewer@gxp.com', password: TEST_PASSWORD })).body.token).toBeTruthy();
    const rows = await audit("entity_id = 'usr-reviewer' AND user_id LIKE 'cli:%'", []);
    expect(rows.map(r => r.action)).toEqual(['Unlock', 'MfaReset']);
  });

  it('bootstrap-admin creates the first administrator only when there is none, with an audit entry and a forced password change', async () => {
    const refused = cli(['bootstrap-admin', '--reason', 'first install'], { ADMIN_EMAIL: 'first@gxp.test', ADMIN_NAME: 'First Admin', ADMIN_PASSWORD: 'Initial-Maple-Value-91!' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/administrator already exists/i);

    await t.db.pool.query("UPDATE users SET active = false WHERE role = 'Admin'");
    try {
      const weak = cli(['bootstrap-admin', '--reason', 'first install'], { ADMIN_EMAIL: 'first@gxp.test', ADMIN_NAME: 'First Admin', ADMIN_PASSWORD: 'short' });
      expect(weak.status).toBe(1);
      const ok = cli(['bootstrap-admin', '--reason', 'first install'], { ADMIN_EMAIL: 'first@gxp.test', ADMIN_NAME: 'First Admin', ADMIN_PASSWORD: 'Initial-Maple-Value-91!' });
      expect(ok.status, ok.stderr).toBe(0);
      const u = (await t.db.pool.query("SELECT id, role, must_change_password FROM users WHERE email = 'first@gxp.test'")).rows[0];
      expect(u).toMatchObject({ role: 'Admin', must_change_password: true });
      const rows = await audit("entity = 'User' AND entity_id = $1 AND action = 'Create'", [u.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(`cli:${OS_USER}`);
      const login = await t.request.post('/api/auth/login-local').send({ email: 'first@gxp.test', password: 'Initial-Maple-Value-91!' });
      expect(login.status).toBe(200);
      expect(login.body.mustChangePassword).toBe(true);
    } finally {
      await t.db.pool.query("UPDATE users SET active = true WHERE id IN ('usr-admin')");
    }
  });

  it('rotate-keys re-encrypts the stored secrets and writes the audit entry', async () => {
    const { getKeystore } = await import('../../src/server/crypto/keystore');
    await t.db.pool.query("UPDATE users SET totp_secret = $2, totp_enabled = true WHERE id = $1", ['usr-qa', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP']);
    const ring = JSON.stringify({ current: 2, keys: { 1: process.env.JWT_SECRET, 2: KEY_B } });
    const res = cli(['rotate-keys', '--reason', 'Annual rotation'], { LIMS_KEYRING: ring });
    expect(res.status, res.stderr).toBe(0);
    const stored = (await t.db.pool.query("SELECT totp_secret FROM users WHERE id = 'usr-qa'")).rows[0].totp_secret as string;
    expect(stored.startsWith('v2:')).toBe(true);
    expect(getKeystore().current).toBe(1); // this process still runs the old ring; it can read v1 only: the operator restarts the server with the new ring
    const rows = await audit("action = 'KEY_ROTATION' AND user_id = $1", [`cli:${OS_USER}`]);
    expect(rows).toHaveLength(1);
    await t.db.pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = 'usr-qa'");
  });
});
