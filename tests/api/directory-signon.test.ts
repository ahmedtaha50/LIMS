/**
 * Roadmap M41 (r3-directory): directory (LDAP / Active Directory) sign-on against the real application and PostgreSQL, with an
 * in-process fake directory behind the connector seam (tests/helpers/fakeDirectory.ts). The tests build on one another in order
 * (settings and mapping first, then people), as an installation is set up.
 */
import { generateSync } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeDirectory } from '../helpers/fakeDirectory';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const totp = (secret = SECRET, steps = 0) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + steps * 30 });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const G = (cn: string) => `CN=${cn},OU=Groups,DC=corp,DC=example`;
const AD_PASSWORD = 'Directory-Pass-1!';

let t: TestApp;
let ldap: typeof import('../../src/server/auth/ldap');
let fake: ReturnType<typeof createFakeDirectory>;
let adminAuth: { Authorization: string };
let qaAuth: { Authorization: string };
let settingsVersion = 0;
let seq = 0;
const ids: Record<string, string> = {};

const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const person = (sam: string, groups: string[], over: Record<string, unknown> = {}) => fake.add({
  dn: `CN=${sam},OU=Users,DC=corp,DC=example`, guid: `0f${(++seq).toString(16).padStart(30, '0')}`, upn: `${sam}@corp.example`, sam, mail: `${sam}@corp.example`,
  displayName: `Person ${sam}`, password: AD_PASSWORD, groups, ...over,
});
const adLogin = (name: string, password = AD_PASSWORD) => t.request.post('/api/auth/login-local').send({ email: name, password });
const securityEvents = (type: string) => sql(`SELECT * FROM security_events WHERE event_type = $1 ORDER BY sequence`, [type]);
const userByEmail = async (email: string) => (await sql(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]))[0];

const settingsBody = (over: Record<string, unknown> = {}) => ({
  enabled: true, url: 'ldaps://dc.corp.example:636', security: 'ldaps', bindDn: fake.state.serviceDn, bindPassword: fake.state.servicePassword,
  baseDn: 'DC=corp,DC=example', reason: 'Directory sign-on set up', expectedVersion: settingsVersion, password: TEST_PASSWORD, ...over,
});
const putSettings = (over: Record<string, unknown> = {}) => t.request.put('/api/directory/settings').set(adminAuth).send(settingsBody(over));

async function approve(mappingId: string, over: Record<string, unknown> = {}) {
  const [{ version }] = await sql('SELECT version FROM directory_group_roles WHERE id = $1', [mappingId]);
  return t.request.post(`/api/directory/mappings/${mappingId}/approve`).set(qaAuth).send({ expectedVersion: version, reason: 'Reviewed with the AD team', password: TEST_PASSWORD, ...over });
}

beforeAll(async () => {
  t = await startTestApp();
  ldap = await import('../../src/server/auth/ldap');
  fake = createFakeDirectory(ldap);
  ldap.setDirectoryConnector(fake.connector);
  adminAuth = await t.auth('admin@gxp.com');
  qaAuth = await t.auth('qa@gxp.com');
  await t.token('analyst1@gxp.com');
  // A local Administrator with an authenticator: the future break-glass account.
  const { generatePasswordHash } = await import('../../src/db/utils');
  await sql(`INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ('usr-bg', 'uid-bg', 'Break Glass', 'Admin', 'breakglass@gxp.test', $1, true)`, [generatePasswordHash(TEST_PASSWORD)]);
});

describe('switched off (the state of every installation until an Administrator turns it on)', () => {
  it('has no settings, never contacts a directory, and leaves local sign-in untouched', async () => {
    const s = await t.request.get('/api/directory/settings').set(adminAuth);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ enabled: false, version: 0, hasBindPassword: false });
    person('early', [G('LIMS-Analysts')]);
    const res = await adLogin('early@corp.example');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    const local = await t.request.post('/api/auth/login-local').send({ email: 'analyst1@gxp.com', password: TEST_PASSWORD });
    expect(local.status).toBe(200);
    expect(fake.state.connections).toHaveLength(0);
    expect(fake.state.binds).toHaveLength(0);
  });

  it('the administration routes are for Administrator and QA only, strict, and an unknown key is a 400', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    expect((await t.request.get('/api/directory/settings').set(analyst)).status).toBe(403);
    expect((await t.request.get('/api/directory/mappings').set(analyst)).status).toBe(403);
    expect((await t.request.get('/api/directory/settings').set(qaAuth)).status).toBe(200);
    expect((await t.request.put('/api/directory/settings').set(qaAuth).send(settingsBody())).status).toBe(403); // QA reads and approves; the Administrator manages
    expect((await putSettings({ role: 'Admin' })).status).toBe(400);
    expect((await putSettings({ security: 'ldaps', url: 'ldap://dc.corp.example' })).status).toBe(400); // plain-text LDAP does not exist
    expect((await putSettings({ security: 'none' })).status).toBe(400);
  });
});

describe('the group to role mapping', () => {
  it('the Administrator role cannot be mapped, in the API or in the table', async () => {
    const res = await t.request.post('/api/directory/mappings').set(adminAuth).send({ groupDn: G('LIMS-Admins'), role: 'Admin', reason: 'try to map admin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ROLE_NOT_MAPPABLE');
    await expect(sql(`INSERT INTO directory_group_roles (id, group_dn, group_dn_norm, role, reason, created_by) VALUES ('x', 'CN=a', 'cn=a', 'Admin', 'because', 'usr-admin')`)).rejects.toThrow(/role_check/);
    expect((await t.request.post('/api/directory/mappings').set(adminAuth).send({ groupDn: G('X'), role: 'Janitor', reason: 'no such role' })).body.code).toBe('UNKNOWN_ROLE');
  });

  it('a proposal is a Draft; only QA can approve it, with an e-signature, and not its proposer', async () => {
    for (const [cn, role] of [['LIMS-Analysts', 'Analyst'], ['LIMS-Reviewers', 'Reviewer'], ['LIMS-QA', 'QA'], ['LIMS-Pending', 'Reviewer']]) {
      const res = await t.request.post('/api/directory/mappings').set(adminAuth).send({ groupDn: G(cn), role, reason: `Group ${cn} gets ${role}` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('Draft');
      ids[cn] = res.body.id;
    }
    // the same group cannot have two live mappings, even written with different case or spacing
    const dup = await t.request.post('/api/directory/mappings').set(adminAuth).send({ groupDn: 'cn=lims-analysts, ou=Groups, dc=corp, dc=example', role: 'Reviewer', reason: 'duplicate group' });
    expect(dup.status).toBe(409);

    expect((await approve(ids['LIMS-Analysts'], { expectedVersion: 7 })).status).toBe(409);
    expect((await approve(ids['LIMS-Analysts'], { password: 'wrong' })).status).toBe(401);
    for (const cn of ['LIMS-Analysts', 'LIMS-Reviewers', 'LIMS-QA']) {
      const ok = await approve(ids[cn]);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.mapping).toMatchObject({ status: 'Approved', approvedBy: 'usr-qa', version: 2 });
      expect(ok.body.signature).toBeTruthy();
    }
    const [sig] = await sql(`SELECT * FROM signatures WHERE entity_type = 'DirectoryGroupRole' AND entity_id = $1`, [ids['LIMS-Analysts']]);
    expect(sig).toMatchObject({ meaning_code: 'DIRECTORY_MAPPING', record_version: 2, signer_id: 'usr-qa' });
    const audit = await sql(`SELECT action, new_value FROM audit_trail WHERE entity = 'DirectoryGroupRole' AND entity_id = $1 AND action <> 'SignatureFailed' ORDER BY sequence`, [ids['LIMS-Analysts']]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Approve']);
    expect((await approve(ids['LIMS-Analysts'], { expectedVersion: 2 })).status).toBe(409); // already approved
  });

  it('the person who proposed a mapping cannot approve it', async () => {
    await sql(`INSERT INTO directory_group_roles (id, group_dn, group_dn_norm, role, reason, created_by) VALUES ('dgr-self', $1, $2, 'Reviewer', 'proposed by QA', 'usr-qa')`, [G('SelfProposed'), ldap.normalizeDn(G('SelfProposed'))]);
    const res = await approve('dgr-self');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    // the Administrator holds the permission but not the signature meaning: only QA decides (a different person than the proposer, so the role check is what answers)
    const asAdmin = await t.request.post('/api/directory/mappings/dgr-self/approve').set(adminAuth).send({ expectedVersion: 1, reason: 'Admin tries to approve', password: TEST_PASSWORD });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.code).toBe('ROLE_NOT_ALLOWED');
  });
});

describe('switching directory sign-on on', () => {
  it('needs a break-glass account with multi-factor authentication', async () => {
    expect((await putSettings()).body.code).toBe('BREAK_GLASS_REQUIRED');
    const flag = (userId: string, over: Record<string, unknown> = {}) => t.request.post(`/api/directory/accounts/${userId}/break-glass`).set(adminAuth).send({ enabled: true, reason: 'Emergency access', expectedVersion: 0, password: TEST_PASSWORD, ...over });
    expect((await flag('usr-analyst1')).body.code).toBe('BREAK_GLASS_ROLE');
    expect((await flag('usr-bg')).body.code).toBe('BREAK_GLASS_MFA');
    await sql(`UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = 'usr-bg'`, [SECRET]);
    expect((await flag('usr-bg', { password: 'wrong' })).status).toBe(401);
    expect((await flag('usr-bg', { expectedVersion: 3 })).status).toBe(409);
    const ok = await flag('usr-bg');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await flag('usr-bg', { expectedVersion: 1 })).status).toBe(409);
    expect((await sql(`SELECT action FROM audit_trail WHERE entity = 'DirectoryAccount' AND entity_id = 'usr-bg' AND action = 'Update'`))).toHaveLength(1);
  });

  it('needs a connection that works: an unreachable server, a wrong service password, and an untrusted certificate change nothing', async () => {
    fake.state.reachable = false;
    const down = await putSettings();
    expect(down.status).toBe(422);
    expect(down.body.code).toBe('DIRECTORY_TEST_FAILED');
    fake.state.reachable = true;
    expect((await putSettings({ bindPassword: 'not-the-service-password' })).body.code).toBe('DIRECTORY_TEST_FAILED');
    expect(await sql('SELECT 1 FROM directory_settings')).toHaveLength(0);
  });

  it('stores the bind password as keystore ciphertext, never returns it, and audits the change without it', async () => {
    const ok = await putSettings();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    settingsVersion = ok.body.version;
    expect(ok.body).toMatchObject({ enabled: true, security: 'ldaps', hasBindPassword: true });
    expect(JSON.stringify(ok.body)).not.toContain(fake.state.servicePassword);
    const [row] = await sql('SELECT * FROM directory_settings');
    expect(row.bind_password_enc).toMatch(/^v\d+:/);
    expect(row.bind_password_enc).not.toContain(fake.state.servicePassword);
    expect(JSON.stringify(await sql(`SELECT * FROM audit_trail WHERE entity = 'DirectorySettings'`))).not.toContain(fake.state.servicePassword);
    expect(JSON.stringify((await t.request.get('/api/directory/settings').set(adminAuth)).body)).not.toContain(fake.state.servicePassword);
    // the password is bound to its row: a copy in another column or row does not decrypt
    expect(() => (require('../../src/server/crypto/keystore') as any).getKeystore().decrypt(row.bind_password_enc, 'other:context')).toThrow();
    expect(fake.state.connections.at(-1)).toMatchObject({ security: 'ldaps', url: 'ldaps://dc.corp.example:636' });
  });

  it('a stale version is a 409; the connection test reports reachability and previews a person', async () => {
    expect((await putSettings({ expectedVersion: 0 })).status).toBe(409);
    person('preview', [G('LIMS-QA')]);
    const test = await t.request.post('/api/directory/test').set(adminAuth).send({ login: 'preview', password: TEST_PASSWORD });
    expect(test.body).toMatchObject({ reachable: true, person: { mappedRole: 'QA', accountState: 'enabled' } });
    fake.state.reachable = false;
    expect((await t.request.post('/api/directory/test').set(adminAuth).send({ password: TEST_PASSWORD })).body).toMatchObject({ reachable: false });
    fake.state.reachable = true;
    expect((await securityEvents('DIRECTORY_TEST')).length).toBe(2);
  });
});

describe('signing in with a directory account', () => {
  it('a member of an approved group gets the mapped role; the local row has no password; the first sign-in is audited', async () => {
    person('jdoe', [G('LIMS-Analysts')]);
    fake.reset();
    const res = await adLogin('jdoe@corp.example');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'jdoe@corp.example', role: 'Analyst' });
    const row = await userByEmail('jdoe@corp.example');
    expect(row.password_hash).toBeNull();
    expect(row.has_completed_software_training).toBe(false);
    ids.jdoe = row.id;
    const [acct] = await sql('SELECT * FROM directory_accounts WHERE user_id = $1', [row.id]);
    expect(acct).toMatchObject({ kind: 'ldap', dn: 'CN=jdoe,OU=Users,DC=corp,DC=example' });
    expect(acct.groups).toEqual([G('LIMS-Analysts')]);
    const audit = await sql(`SELECT action, user_id, new_value FROM audit_trail WHERE entity = 'User' AND entity_id = $1`, [row.id]);
    expect(audit[0]).toMatchObject({ action: 'Create', user_id: row.id });
    expect(JSON.parse(audit[0].new_value)).toMatchObject({ role: 'Analyst', source: 'directory' });
    const login = (await securityEvents('AUTH_LOGIN')).filter(e => e.actor_id === row.id);
    expect(login).toHaveLength(1);
    expect((await securityEvents('DIRECTORY_AUTH')).filter(e => e.actor_id === row.id)).toHaveLength(1);
    // the user was verified by binding as their own DN, after the service account searched
    expect(fake.state.binds.map(b => b.dn)).toEqual([fake.state.serviceDn, 'CN=jdoe,OU=Users,DC=corp,DC=example']);
    // the session works
    expect((await t.request.get('/api/auth/me').set(bearer(res.body.token))).status).toBe(200);
  });

  it('sAMAccountName and UPN both find the person; the same account is reused (no second row)', async () => {
    expect((await adLogin('JDOE')).status).toBe(200);
    expect(await sql(`SELECT 1 FROM users WHERE lower(email) = 'jdoe@corp.example'`)).toHaveLength(1);
  });

  it('two first sign-ins of the same person at the same moment create one account', async () => {
    person('twin', [G('LIMS-Analysts')]);
    const [one, two] = await Promise.all([adLogin('twin'), adLogin('twin')]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await sql(`SELECT 1 FROM users WHERE lower(email) = 'twin@corp.example'`)).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM directory_accounts a JOIN users u ON u.id = a.user_id WHERE lower(u.email) = 'twin@corp.example'`)).toHaveLength(1);
  });

  it('many concurrent first sign-ins, several people at once: every one succeeds, one account and one Create audit entry per person', async () => {
    // The race is a matter of milliseconds, so it is exercised with several people, three simultaneous sign-ins each, every run.
    const names = Array.from({ length: 12 }, (_, i) => `race${i}`);
    for (const n of names) person(n, [G('LIMS-Analysts')]);
    const results = await Promise.all(names.flatMap(n => [1, 2, 3].map(() => adLogin(n))));
    expect(results.map(r => r.status)).toEqual(results.map(() => 200));
    for (const n of names) {
      const rows = await sql(`SELECT id FROM users WHERE lower(email) = $1`, [`${n}@corp.example`]);
      expect(rows).toHaveLength(1);
      expect(await sql(`SELECT 1 FROM directory_accounts WHERE user_id = $1`, [rows[0].id])).toHaveLength(1);
      expect(await sql(`SELECT 1 FROM audit_trail WHERE entity = 'User' AND entity_id = $1 AND action = 'Create'`, [rows[0].id])).toHaveLength(1);
    }
  });

  it('a wrong directory password is the generic 401 and counts toward the sign-in lock; a locked account is not tried in the directory', async () => {
    person('lockme', [G('LIMS-Analysts')]);
    expect((await adLogin('lockme')).status).toBe(200); // provisioned
    fake.reset();
    for (let i = 0; i < 2; i++) expect((await adLogin('lockme', 'wrong-password')).body.code).toBe('INVALID_CREDENTIALS');
    const third = await adLogin('lockme', 'wrong-password');
    expect(third.body.code).toBe('INVALID_CREDENTIALS');
    expect(third.body.error).toContain('locked');
    const userBinds = () => fake.state.binds.filter(b => b.dn !== fake.state.serviceDn).length;
    expect(userBinds()).toBe(3);
    const locked = await adLogin('lockme'); // right password, but locked here
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(userBinds()).toBe(3); // no fourth try reached the directory: it would also count against the account there
  });

  it('removal from the group takes the role away at the next sign-in and ends the open sessions', async () => {
    person('mover', [G('LIMS-QA')]);
    const first = await adLogin('mover');
    expect(first.body.user.role).toBe('QA');
    fake.state.people.get([...fake.state.people.values()].find(p => p.sam === 'mover')!.guid)!.groups = [G('LIMS-Analysts')];
    const second = await adLogin('mover');
    expect(second.body.user.role).toBe('Analyst');
    expect((await t.request.get('/api/auth/me').set(bearer(first.body.token))).status).toBe(401); // the QA session ended with the role change
    const audit = await sql(`SELECT action, old_value, new_value, reason FROM audit_trail WHERE entity = 'User' AND entity_id = $1 ORDER BY sequence`, [second.body.user.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'DirectorySync']);
    expect(JSON.parse(audit[1].old_value)).toEqual({ role: 'QA' });
    expect(JSON.parse(audit[1].new_value)).toEqual({ role: 'Analyst' });

    fake.state.people.get([...fake.state.people.values()].find(p => p.sam === 'mover')!.guid)!.groups = [G('Unrelated-Group')];
    const third = await adLogin('mover');
    expect(third.status).toBe(401);
    expect(third.body.code).toBe('INVALID_CREDENTIALS'); // generic: the response does not say why
    expect((await t.request.get('/api/auth/me').set(bearer(second.body.token))).status).toBe(401);
    const refused = (await securityEvents('DIRECTORY_ACCOUNT_REFUSED')).filter(e => JSON.parse(e.detail).reason.includes('no approved group mapping'));
    expect(refused.length).toBeGreaterThan(0);
  });

  it('several mapped groups give the least privileged role', async () => {
    person('twogroups', [G('LIMS-QA'), G('LIMS-Reviewers'), G('LIMS-Analysts')]);
    expect((await adLogin('twogroups')).body.user.role).toBe('Analyst');
  });

  it('a person in no approved group is never created, and a Draft mapping is not used', async () => {
    const before = (await sql('SELECT count(*)::int AS n FROM users'))[0].n;
    person('nogroup', [G('Somebody-Else')]);
    person('drafty', [G('LIMS-Pending')]); // mapped to Reviewer, but still a Draft
    expect((await adLogin('nogroup')).status).toBe(401);
    expect((await adLogin('drafty')).status).toBe(401);
    expect((await sql('SELECT count(*)::int AS n FROM users'))[0].n).toBe(before);
    // a retired mapping stops working at the next sign-in
    person('retiring', [G('LIMS-Reviewers')]);
    expect((await adLogin('retiring')).status).toBe(200);
    const [{ version }] = await sql('SELECT version FROM directory_group_roles WHERE id = $1', [ids['LIMS-Reviewers']]);
    const retire = await t.request.post(`/api/directory/mappings/${ids['LIMS-Reviewers']}/retire`).set(qaAuth).send({ expectedVersion: version, reason: 'Group dissolved', password: TEST_PASSWORD });
    expect(retire.status, JSON.stringify(retire.body)).toBe(200);
    expect((await adLogin('retiring')).status).toBe(401);
  });

  it.each([
    ['disabled', { uac: 514 }],
    ['locked', { uac: 528 }],
    ['expired', { accountExpires: String((Date.now() - 86_400_000 + 11_644_473_600_000) * 10_000) }],
  ])('a %s directory account is refused BEFORE its password is tried, with the generic answer', async (reason, over) => {
    const p = person(`acct-${reason}`, [G('LIMS-Analysts')], over);
    fake.reset();
    const res = await adLogin(p.sam);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(fake.state.binds.filter(b => b.dn === p.dn)).toHaveLength(0);
    const ev = (await securityEvents('DIRECTORY_ACCOUNT_REFUSED')).filter(e => JSON.parse(e.detail).externalId === p.guid);
    expect(JSON.parse(ev[0].detail).reason).toBe(reason);
  });

  it('an account disabled in the directory loses its open sessions at the next attempt', async () => {
    const p = person('leaver', [G('LIMS-Analysts')]);
    const res = await adLogin('leaver');
    expect(res.status).toBe(200);
    p.uac = 514;
    expect((await adLogin('leaver')).status).toBe(401);
    expect((await t.request.get('/api/auth/me').set(bearer(res.body.token))).status).toBe(401);
  });

  it('a directory person cannot take over a local account by having its address; the local account is untouched', async () => {
    person('imposter', [G('LIMS-Analysts')], { mail: 'analyst2@gxp.com', upn: 'imposter@corp.example' });
    const res = await adLogin('imposter');
    expect(res.status).toBe(401);
    expect((await userByEmail('analyst2@gxp.com')).role).toBe('Analyst');
    expect(await sql(`SELECT 1 FROM directory_accounts WHERE user_id = 'usr-analyst2'`)).toHaveLength(0);
    // and typing the local address with the directory password reaches only the local check
    fake.reset();
    expect((await adLogin('analyst2@gxp.com', AD_PASSWORD)).status).toBe(401);
    expect(fake.state.connections).toHaveLength(0);
  });

  it('a hostile name is escaped: a wildcard or filter injection finds nobody and the filter keeps its shape', async () => {
    fake.reset();
    for (const evil of ['***', 'jdoe*', 'x)(|(sAMAccountName=*', '*)(objectClass=*']) {
      const res = await adLogin(evil);
      expect(res.status, `${evil} ${JSON.stringify(res.body)}`).toBe(401);
    }
    const filters = fake.state.searches.map(s => s.filter);
    expect(filters).toHaveLength(4);
    for (const f of filters) expect(f).toMatch(/^\(&\(objectClass=user\)\(objectCategory=person\)\(\|\(userPrincipalName=[^()]*\)\(sAMAccountName=[^()]*\)\(mail=[^()]*\)\)\)$/);
    expect(filters[0]).toContain('=\\2a\\2a\\2a)');
  });

  it('an empty password is never sent to the directory (it would be an anonymous bind that succeeds)', async () => {
    fake.reset();
    const res = await ldap.directoryAuthenticate((await ldap.loadDirectoryConfig((await import('../../src/db/index')).db))!, { login: 'jdoe' }, '');
    expect(res.kind).toBe('not-found');
    expect(fake.state.binds).toHaveLength(0);
    expect((await t.request.post('/api/auth/login-local').send({ email: 'jdoe', password: '' })).status).toBe(400);
  });
});

describe('second factor, passwords and re-authentication of a directory account', () => {
  it('the TOTP policy applies as to any account: an enrolled authenticator is asked for after the directory password', async () => {
    person('mfauser', [G('LIMS-Analysts')]);
    const first = await adLogin('mfauser');
    await sql('UPDATE users SET totp_secret = $2, totp_enabled = true WHERE id = $1', [first.body.user.id, SECRET]);
    const step = await adLogin('mfauser');
    expect(step.body.requiresTotp).toBe(true);
    expect(step.body.token).toBeUndefined();
    const done = await t.request.post('/api/auth/totp-verify').send({ tempToken: step.body.tempToken, code: totp() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.user.role).toBe('Analyst');
  });

  it('the policy "MFA required" sends a directory account without an authenticator through enrolment', async () => {
    await sql(`INSERT INTO system_settings (id, mfa_required) VALUES ('default', true) ON CONFLICT (id) DO UPDATE SET mfa_required = true`);
    try {
      person('needsmfa', [G('LIMS-Analysts')]);
      const res = await adLogin('needsmfa');
      expect(res.body.requireTotpSetup).toBe(true);
      expect(res.body.token).toBeUndefined();
    } finally { await sql(`UPDATE system_settings SET mfa_required = false WHERE id = 'default'`); }
  });

  it('the local password is not managed here: change-password and an administrator reset are refused', async () => {
    const res = await adLogin('jdoe');
    const change = await t.request.post('/api/auth/change-password').set(bearer(res.body.token)).send({ currentPassword: AD_PASSWORD, newPassword: 'Another-Pass-2!' });
    expect(change.status).toBe(409);
    expect(change.body.code).toBe('DIRECTORY_MANAGED');
    const reset = await t.request.post(`/api/admin/users/${ids.jdoe}/reset-password`).set(adminAuth).send({ reason: 'forgot', password: TEST_PASSWORD, expectedVersion: (await userByEmail('jdoe@corp.example')).version });
    expect(reset.status).toBe(409);
    expect(reset.body.code).toBe('DIRECTORY_MANAGED');
  });

  it('re-authentication after an idle lock checks the directory password; an unreachable directory is a 503 and counts nothing', async () => {
    const res = await adLogin('jdoe');
    const auth = bearer(res.body.token);
    const bad = await t.request.post('/api/auth/reauth').set(auth).send({ password: 'wrong' });
    expect(bad.status).toBe(401);
    fake.state.reachable = false;
    const down = await t.request.post('/api/auth/reauth').set(auth).send({ password: AD_PASSWORD });
    fake.state.reachable = true;
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('DIRECTORY_UNAVAILABLE');
    expect((await t.request.post('/api/auth/reauth').set(auth).send({ password: AD_PASSWORD })).status).toBe(200);
  });
});

describe('electronic signatures of a directory account', () => {
  let qaAd: { id: string; token: string };
  let sigPerson: ReturnType<typeof person>;

  async function pendingMapping(name: string) {
    const res = await t.request.post('/api/directory/mappings').set(adminAuth).send({ groupDn: G(name), role: 'Analyst', reason: `Group ${name} gets Analyst` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, version: res.body.version as number };
  }
  const sign = (m: { id: string; version: number }, body: Record<string, unknown> = {}) =>
    t.request.post(`/api/directory/mappings/${m.id}/approve`).set(bearer(qaAd.token)).send({ expectedVersion: m.version, reason: 'Reviewed with the AD team', password: AD_PASSWORD, ...body });

  beforeAll(async () => {
    sigPerson = person('qa.signer', [G('LIMS-QA')]);
    const res = await adLogin('qa.signer');
    expect(res.body.user.role).toBe('QA');
    qaAd = { id: res.body.user.id, token: res.body.token };
    await sql('UPDATE users SET has_completed_software_training = true WHERE id = $1', [qaAd.id]);
  });

  it('signs with the directory password: the signature is bound to the record version and carries the meaning', async () => {
    const m = await pendingMapping('Sig-Ok');
    const res = await sign(m);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [sig] = await sql(`SELECT * FROM signatures WHERE entity_id = $1`, [m.id]);
    expect(sig).toMatchObject({ signer_id: qaAd.id, meaning_code: 'DIRECTORY_MAPPING', record_version: m.version + 1, auth_method: 'password' });
  });

  it('a wrong password is counted against the local signing lock (3 wrong, then locked), exactly as for a local account', async () => {
    const m = await pendingMapping('Sig-Wrong');
    for (let i = 0; i < 2; i++) expect((await sign(m, { password: 'wrong-pass' })).body.code).toBe('INVALID_PASSWORD');
    const third = await sign(m, { password: 'wrong-pass' });
    expect(third.body.code).toBe('INVALID_PASSWORD');
    expect(third.body.error).toContain('locked');
    const locked = await sign(m);
    expect(locked.body.code).toBe('SIGNING_LOCKED');
    await sql('UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = $1', [qaAd.id]);
  });

  it('the authenticator code is still required when the signer has one, even though the directory accepted the password', async () => {
    const m = await pendingMapping('Sig-Mfa');
    await sql('UPDATE users SET totp_secret = $2, totp_enabled = true WHERE id = $1', [qaAd.id, SECRET]);
    const missing = await sign(m);
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('MFA_CODE_REQUIRED');
    const wrong = await sign(m, { totpCode: '000000' });
    expect(wrong.body.code).toBe('INVALID_CODE');
    const ok = await sign(m, { totpCode: totp() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [sig] = await sql(`SELECT auth_method FROM signatures WHERE entity_id = $1`, [m.id]);
    expect(sig.auth_method).toBe('password+totp');
    await sql('UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL WHERE id = $1', [qaAd.id]);
  });

  it('an unreachable directory is a 503 and counts nothing', async () => {
    const m = await pendingMapping('Sig-Down');
    fake.state.reachable = false;
    const res = await sign(m);
    fake.state.reachable = true;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DIRECTORY_UNAVAILABLE');
    expect((await sql('SELECT failed_attempts FROM users WHERE id = $1', [qaAd.id]))[0].failed_attempts).toBe(0);
  });

  it('a person disabled in the directory since sign-in cannot sign, and their session ends', async () => {
    const m = await pendingMapping('Sig-Disabled');
    sigPerson.uac = 514;
    try {
      const res = await sign(m);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_PASSWORD');
      expect(await sql(`SELECT 1 FROM signatures WHERE entity_id = $1`, [m.id])).toHaveLength(0);
      expect((await t.request.get('/api/auth/me').set(bearer(qaAd.token))).status).toBe(401);
    } finally { sigPerson.uac = 512; await sql('UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = $1', [qaAd.id]); }
  });
});

describe('local accounts while the directory is on', () => {
  it('plain local accounts keep working unless the Administrator closes local sign-in; break-glass accounts are exempt from that closure', async () => {
    expect((await t.request.post('/api/auth/login-local').send({ email: 'analyst1@gxp.com', password: TEST_PASSWORD })).status).toBe(200);
    const [{ version }] = await sql('SELECT version FROM directory_settings');
    const close = await putSettings({ expectedVersion: version, localAccountsAllowed: false });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    settingsVersion = close.body.version;
    expect((await t.request.post('/api/auth/login-local').send({ email: 'analyst1@gxp.com', password: TEST_PASSWORD })).status).toBe(401);
    const reopen = await putSettings({ expectedVersion: settingsVersion, localAccountsAllowed: true });
    settingsVersion = reopen.body.version;
    expect((await t.request.post('/api/auth/login-local').send({ email: 'analyst1@gxp.com', password: TEST_PASSWORD })).status).toBe(200);
  });
});

describe('the directory is down: break-glass', () => {
  const bgLogin = (password = TEST_PASSWORD) => t.request.post('/api/auth/login-local').send({ email: 'breakglass@gxp.test', password });

  it('directory people get a clear, generic "unavailable" answer and the failure is a security event', async () => {
    fake.state.reachable = false;
    try {
      const before = (await securityEvents('DIRECTORY_UNAVAILABLE')).length;
      const res = await adLogin('jdoe');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('DIRECTORY_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|dc\.corp/);
      expect((await securityEvents('DIRECTORY_UNAVAILABLE')).length).toBe(before + 1);
    } finally { fake.state.reachable = true; }
  });

  it('while the directory answers, the break-glass account is refused (generic) and the refusal is logged', async () => {
    const res = await bgLogin();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect((await securityEvents('BREAK_GLASS_REFUSED')).length).toBe(1);
  });

  it('while it is unreachable, the break-glass account signs in with its password AND its authenticator, and every use is logged', async () => {
    fake.state.reachable = false;
    try {
      const wrong = await bgLogin('not-the-password');
      expect(wrong.status).toBe(401);
      const ok = await bgLogin();
      expect(ok.body.requiresTotp).toBe(true); // the second factor is not skipped
      const done = await t.request.post('/api/auth/totp-verify').send({ tempToken: ok.body.tempToken, code: totp() });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.user.role).toBe('Admin');
      const used = await securityEvents('BREAK_GLASS_USED');
      expect(used.map(e => e.outcome)).toEqual(['failure', 'success']);
      expect(used.every(e => e.actor_id === 'usr-bg')).toBe(true);
      expect(JSON.parse(used[1].detail)).toMatchObject({ passwordAccepted: true });
      expect((await securityEvents('AUTH_LOGIN')).some(e => e.actor_id === 'usr-bg')).toBe(true);
    } finally { fake.state.reachable = true; }
  });

  it('a break-glass account that lost its authenticator is refused even when the directory is down', async () => {
    await sql(`UPDATE users SET totp_enabled = false WHERE id = 'usr-bg'`);
    fake.state.reachable = false;
    try { expect((await bgLogin()).status).toBe(401); } finally { fake.state.reachable = true; await sql(`UPDATE users SET totp_enabled = true WHERE id = 'usr-bg'`); }
  });

  it('the last break-glass account cannot be removed while the directory is on; the directory can still be switched off', async () => {
    const [{ version }] = await sql(`SELECT version FROM directory_accounts WHERE user_id = 'usr-bg'`);
    const rm = await t.request.post('/api/directory/accounts/usr-bg/break-glass').set(adminAuth).send({ enabled: false, reason: 'Remove it', expectedVersion: version, password: TEST_PASSWORD });
    expect(rm.status).toBe(409);
    expect(rm.body.code).toBe('LAST_BREAK_GLASS');
    const off = await putSettings({ enabled: false, expectedVersion: settingsVersion });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    // switched off again: a directory name is just an unknown name and local sign-in is as before
    fake.reset();
    expect((await adLogin('jdoe')).status).toBe(401);
    expect(fake.state.connections).toHaveLength(0);
    expect((await t.request.post('/api/auth/login-local').send({ email: 'analyst2@gxp.com', password: TEST_PASSWORD })).status).toBe(200);
  });
});

describe('key rotation', () => {
  it('moves the service-account password to the new key generation and it still opens', async () => {
    const { createKeystore, setKeystore } = await import('../../src/server/crypto/keystore');
    const { rotateStoredSecrets } = await import('../../src/server/crypto/rotate');
    const { db } = await import('../../src/db/index');
    expect((await sql('SELECT bind_password_enc FROM directory_settings'))[0].bind_password_enc).toMatch(/^v1:/);
    const gen2 = createKeystore({ current: 2, keys: { 1: process.env.JWT_SECRET!, 2: 'k'.repeat(40) } });
    setKeystore(gen2);
    try {
      const report = await rotateStoredSecrets(db, { actor: 'cli:tester', reason: 'Scheduled key rotation', keystore: gen2 });
      expect(report.bindPasswords).toBe(1);
      expect((await sql('SELECT bind_password_enc FROM directory_settings'))[0].bind_password_enc).toMatch(/^v2:/);
      expect((await ldap.loadDirectoryConfig(db))!.bindPassword).toBe(fake.state.servicePassword);
      expect((await rotateStoredSecrets(db, { actor: 'cli:tester', reason: 'Second run', keystore: gen2 })).bindPasswords).toBe(0);
    } finally { setKeystore(null); }
  });
});
