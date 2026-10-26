/**
 * Roadmap M09 (r1-authz): a role is granted by two people. An Administrator requests the change and signs; a second, independent
 * person with the approval privilege signs; only then does the role change, the target's sessions end, and one audit entry per
 * step is written in the transaction of the step. Granting or removing a privileged role (Admin, QA) can no longer be done by one
 * Administrator through PUT /admin/users/:id or POST /admin/users.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

let t: TestApp;
let seq = 0;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

async function newUser(role: string, trained = true) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-rc${process.pid}-${n}`;
  const email = `rc${process.pid}.${n}@gxp.test`;
  await sql(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `uid-${id}`, `Role Change ${n}`, role, email, generatePasswordHash(TEST_PASSWORD), trained]);
  const login = await t.request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD });
  return { id, email, headers: { Authorization: `Bearer ${login.body.token}` } };
}
const versionOf = async (id: string) => ((await sql('SELECT version FROM users WHERE id = $1', [id]))[0]?.version ?? 1) as number;
const roleOf = async (id: string) => (await sql('SELECT role FROM users WHERE id = $1', [id]))[0].role as string;
const resetSigning = () => sql(`UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id IN ('usr-admin','usr-qa')`);

async function request(by: { Authorization: string }, target: string, role: string, extra: Record<string, unknown> = {}) {
  return t.request.post('/api/permissions/role-changes').set(by).send({
    userId: target, role, reason: 'Covers QA absence during audit', expectedVersion: await versionOf(target), password: TEST_PASSWORD, ...extra,
  });
}
const approve = (id: string, by: { Authorization: string }, body: Record<string, unknown> = {}) =>
  t.request.post(`/api/permissions/role-changes/${id}/approve`).set(by).send({ password: TEST_PASSWORD, expectedVersion: 1, ...body });

describe('request, approve', () => {
  it('changes the role only after the second person signs, ends the target\'s sessions, and audits each step', async () => {
    const target = await newUser('Analyst');
    const v0 = await versionOf(target.id);

    const req = await request(H.admin, target.id, 'QA');
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.request).toMatchObject({
      userId: target.id, fromRole: 'Analyst', toRole: 'QA', status: 'Pending', requestedBy: 'usr-admin', requestRecordVersion: v0, version: 1,
    });
    expect(req.body.request.requestSignatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(req.body.request.requestMeaning).toMatch(/request/i);
    expect(await roleOf(target.id)).toBe('Analyst'); // nothing has changed yet
    const id = req.body.request.id as string;

    // The requester cannot approve their own request: separate from the permission check, even though Admin holds the privilege.
    const own = await approve(id, H.admin);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    // Neither can anyone without the approval privilege.
    expect((await approve(id, target.headers)).body.code).toBe('PERMISSION_DENIED');
    expect((await approve(id, H.reviewer)).body.code).toBe('PERMISSION_DENIED');
    const denied = (await sql(`SELECT actor_id, detail FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND detail LIKE $1 ORDER BY sequence`, [`%${id}%`]))
      .map(e => ({ actor: e.actor_id as string, ...JSON.parse(e.detail) }));
    expect(denied.find(d => d.rule === 'role.grant')).toMatchObject({ actor: 'usr-admin', entity: 'UserRole', entityId: id });
    expect(denied.filter(d => d.permission === 'authz.role.approve').map(d => d.actor).sort()).toEqual([target.id, 'usr-reviewer'].sort());

    // A wrong password is not a signature.
    const bad = await approve(id, H.qa, { password: 'not-the-password' });
    expect(bad.status).toBe(401);
    expect(await roleOf(target.id)).toBe('Analyst');
    await resetSigning();

    const ok = await approve(id, H.qa, { reason: 'Verified with the department head' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.request).toMatchObject({ status: 'Approved', decidedBy: 'usr-qa', decisionRecordVersion: v0 + 1, version: 2 });
    expect(ok.body.request.decisionSignatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.body.request.decisionSignatureHash).not.toBe(ok.body.request.requestSignatureHash);
    expect(ok.body.request.decisionMeaning).toMatch(/approv/i);
    expect(ok.body.user).toMatchObject({ id: target.id, role: 'QA', version: v0 + 1 });
    expect(await roleOf(target.id)).toBe('QA');
    expect(await versionOf(target.id)).toBe(v0 + 1);

    // The old session ended; a new sign-in has the new permissions.
    const stale = await t.request.get('/api/samples').set(target.headers);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_REVOKED');
    const login = await t.request.post('/api/auth/login-local').send({ email: target.email, password: TEST_PASSWORD });
    const me = await t.request.get('/api/permissions/me').set({ Authorization: `Bearer ${login.body.token}` });
    expect(me.body.role).toBe('QA');
    expect(me.body.permissions).toContain('spec.approve');

    // One audit entry per step, and one on the user whose role changed.
    const audit = await sql(`SELECT action, entity, entity_id, field, old_value, new_value, user_id, reason FROM audit_trail WHERE entity_id = $1 OR (entity = 'User' AND entity_id = $2) ORDER BY sequence`, [id, target.id]);
    // (the wrong password above is audited too, by the signing-failure bookkeeping of r1-identity)
    expect(audit.map(a => `${a.action}:${a.entity}`)).toEqual(['RoleChangeRequested:UserRole', 'SignatureFailed:UserRole', 'RoleChangeApproved:UserRole', 'RoleChange:User']);
    expect(audit[3]).toMatchObject({ field: 'role', old_value: 'Analyst', new_value: 'QA', user_id: 'usr-qa' });
    expect(audit[0]).toMatchObject({ user_id: 'usr-admin' });
    expect(audit[0].reason).toContain('Covers QA absence');

    // Approving twice is a conflict, not a second change.
    const again = await approve(id, H.qa, { expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REQUEST_NOT_PENDING');
  });

  it('is refused when the user changed after the request (the version the first signer saw is gone)', async () => {
    const target = await newUser('Analyst');
    const req = await request(H.admin, target.id, 'QA');
    expect(req.status).toBe(201);
    await sql('UPDATE users SET version = version + 1 WHERE id = $1', [target.id]); // e.g. an unlock or a deactivation by another Administrator
    const res = await approve(req.body.request.id, H.qa);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(await roleOf(target.id)).toBe('Analyst');
    expect((await sql('SELECT status FROM user_roles WHERE id = $1', [req.body.request.id]))[0].status).toBe('Pending');
  });

  it('is refused when the request itself moved (stale expectedVersion)', async () => {
    const target = await newUser('Analyst');
    const req = await request(H.admin, target.id, 'Reviewer');
    const res = await approve(req.body.request.id, H.qa, { expectedVersion: 7 });
    expect(res.status).toBe(409);
  });

  it('works for a change between two non-privileged roles as well (optional there)', async () => {
    const target = await newUser('Analyst');
    const req = await request(H.admin, target.id, 'Reviewer');
    expect(req.status).toBe(201);
    expect((await approve(req.body.request.id, H.qa)).status).toBe(200);
    expect(await roleOf(target.id)).toBe('Reviewer');
  });

  it('a request that would leave the system without an active Administrator is refused when approved', async () => {
    const other = await newUser('Admin');
    const r1 = await request(H.admin, other.id, 'Analyst');
    const r2 = await request(other.headers, 'usr-admin', 'Analyst');
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const others = (await sql(`SELECT id FROM users WHERE role = 'Admin' AND active AND id NOT IN ('usr-admin', $1)`, [other.id])).map(r => r.id);
    expect(others).toEqual([]); // the harness has exactly one other Administrator

    expect((await approve(r1.body.request.id, H.qa)).status).toBe(200); // 'other' is demoted; usr-admin is now the only Administrator
    const last = await approve(r2.body.request.id, H.qa);
    expect(last.status, JSON.stringify(last.body)).toBe(409);
    expect(last.body.code).toBe('LAST_ADMIN');
    expect(await roleOf('usr-admin')).toBe('Admin');
  });
});

describe('independence', () => {
  it('the person a change is for cannot approve it, even with the approval privilege (a QA officer cannot lift themselves to Admin)', async () => {
    const qa = await newUser('QA');
    const req = await request(H.admin, qa.id, 'Admin');
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const own = await approve(req.body.request.id, qa.headers);
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    expect(await roleOf(qa.id)).toBe('QA');
    const events = await sql(`SELECT actor_id, detail FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = $1`, [qa.id]);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detail)).toMatchObject({ rule: 'role.grant', entityId: req.body.request.id });
    // ... and neither can they reject it: only somebody else decides.
    const reject = await t.request.post(`/api/permissions/role-changes/${req.body.request.id}/reject`).set(qa.headers).send({ password: TEST_PASSWORD, reason: 'No thanks', expectedVersion: 1 });
    expect(reject.status).toBe(403);
    // A different QA officer can.
    expect((await approve(req.body.request.id, H.qa)).status).toBe(200);
    expect(await roleOf(qa.id)).toBe('Admin');
  });
});

describe('request validation', () => {
  it('needs the request privilege (Admin): QA, Reviewer and Analyst get 403', async () => {
    const target = await newUser('Analyst');
    for (const who of ['qa', 'reviewer', 'analyst1']) {
      const res = await request(H[who], target.id, 'Reviewer');
      expect(res.status, who).toBe(403);
      expect(res.body.code, who).toBe('PERMISSION_DENIED');
    }
  });

  it('is strict: unknown keys, an unknown role, the same role, oneself, an unknown user and a stale user version', async () => {
    const target = await newUser('Analyst');
    expect((await request(H.admin, target.id, 'Reviewer', { status: 'Approved' })).status).toBe(400);
    expect((await request(H.admin, target.id, 'Root')).status).toBe(400);
    expect((await request(H.admin, target.id, 'Analyst')).body.code).toBe('NO_CHANGE');
    expect((await request(H.admin, 'usr-admin', 'QA')).body.code).toBe('SELF_CHANGE_FORBIDDEN');
    expect((await request(H.admin, 'usr-nobody', 'QA', { expectedVersion: 1 })).status).toBe(404);
    expect((await request(H.admin, target.id, 'Reviewer', { expectedVersion: 99 })).status).toBe(409);
    expect((await request(H.admin, target.id, 'Reviewer', { reason: 'x' })).status).toBe(400);
    expect((await request(H.admin, target.id, 'Reviewer', { password: 'wrong-password' })).status).toBe(401);
    await resetSigning();
    expect((await sql('SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1', [target.id]))[0].n).toBe(0);
  });

  it('allows one pending request per user', async () => {
    const target = await newUser('Analyst');
    expect((await request(H.admin, target.id, 'Reviewer')).status).toBe(201);
    const second = await request(H.admin, target.id, 'QA');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REQUEST_PENDING');
  });

  it('both signers must have completed the software training', async () => {
    const target = await newUser('Analyst');
    const untrainedAdmin = await newUser('Admin', false);
    const res = await request(untrainedAdmin.headers, target.id, 'Reviewer');
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('TRAINING_REQUIRED');

    const req = await request(H.admin, target.id, 'Reviewer');
    const untrainedQa = await newUser('QA', false);
    const approval = await approve(req.body.request.id, untrainedQa.headers);
    expect(approval.status).toBe(403);
    expect(approval.body.code).toBe('TRAINING_REQUIRED');
    expect(await roleOf(target.id)).toBe('Analyst');
  });
});

describe('reject and cancel', () => {
  it('a second person can reject with a reason; the role does not change', async () => {
    const target = await newUser('Analyst');
    const req = await request(H.admin, target.id, 'QA');
    const noReason = await t.request.post(`/api/permissions/role-changes/${req.body.request.id}/reject`).set(H.qa).send({ password: TEST_PASSWORD, expectedVersion: 1 });
    expect(noReason.status).toBe(400);
    const res = await t.request.post(`/api/permissions/role-changes/${req.body.request.id}/reject`).set(H.qa)
      .send({ password: TEST_PASSWORD, reason: 'Not needed after the audit', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'Rejected', decidedBy: 'usr-qa', decisionReason: 'Not needed after the audit' });
    expect(await roleOf(target.id)).toBe('Analyst');
    expect((await sql(`SELECT action FROM audit_trail WHERE entity = 'UserRole' AND entity_id = $1 ORDER BY sequence`, [req.body.request.id])).map(r => r.action))
      .toEqual(['RoleChangeRequested', 'RoleChangeRejected']);
  });

  it('only the requester can withdraw a pending request', async () => {
    const target = await newUser('Analyst');
    const req = await request(H.admin, target.id, 'Reviewer');
    const path = `/api/permissions/role-changes/${req.body.request.id}/cancel`;
    expect((await t.request.post(path).set(H.qa).send({ reason: 'Not mine', expectedVersion: 1 })).status).toBe(403);
    const res = await t.request.post(path).set(H.admin).send({ reason: 'Entered for the wrong person', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.request.status).toBe('Cancelled');
    // A cancelled request can be replaced by a new one.
    expect((await request(H.admin, target.id, 'Reviewer')).status).toBe(201);
  });

  it('GET /permissions/role-changes lists the requests for Admin and QA, newest first', async () => {
    expect((await t.request.get('/api/permissions/role-changes').set(H.analyst1)).status).toBe(403);
    const res = await t.request.get('/api/permissions/role-changes').set(H.qa);
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBeGreaterThan(3);
    const times = res.body.requests.map((r: any) => new Date(r.requestedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('the one-administrator paths are closed for privileged roles', () => {
  const update = (targetId: string, body: Record<string, unknown>, version: number) =>
    t.request.put(`/api/admin/users/${targetId}`).set(H.admin).send({ reason: 'direct change', expectedVersion: version, password: TEST_PASSWORD, ...body });

  it('PUT /admin/users/:id cannot grant a privileged role or take one away', async () => {
    const analyst = await newUser('Analyst');
    const toQa = await update(analyst.id, { role: 'QA' }, await versionOf(analyst.id));
    expect(toQa.status, JSON.stringify(toQa.body)).toBe(409);
    expect(toQa.body.code).toBe('ROLE_CHANGE_REQUIRES_APPROVAL');
    expect(await roleOf(analyst.id)).toBe('Analyst');

    const qa = await newUser('QA');
    const fromQa = await update(qa.id, { role: 'Analyst' }, await versionOf(qa.id));
    expect(fromQa.status).toBe(409);
    expect(fromQa.body.code).toBe('ROLE_CHANGE_REQUIRES_APPROVAL');
    expect(await roleOf(qa.id)).toBe('QA');
  });

  it('PUT /admin/users/:id still changes between non-privileged roles and still deactivates (unchanged behaviour)', async () => {
    const analyst = await newUser('Analyst');
    const res = await update(analyst.id, { role: 'Reviewer' }, await versionOf(analyst.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await roleOf(analyst.id)).toBe('Reviewer');
    const off = await update(analyst.id, { active: false }, await versionOf(analyst.id));
    expect(off.status).toBe(200);
  });

  it('an Administrator who tries to change their own role still gets the identity answer (403 SELF_CHANGE_FORBIDDEN)', async () => {
    const res = await update('usr-admin', { role: 'Analyst' }, await versionOf('usr-admin'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_CHANGE_FORBIDDEN');
  });

  it('POST /admin/users cannot create an Administrator or a QA officer; an Analyst or Reviewer is created as before', async () => {
    const create = (role: string, n: number) => t.request.post('/api/admin/users').set(H.admin)
      .send({ name: `New Person ${n}`, email: `new.person.${process.pid}.${n}@gxp.test`, role, reason: 'New starter', password: TEST_PASSWORD });
    const admin = await create('Admin', 1);
    expect(admin.status, JSON.stringify(admin.body)).toBe(409);
    expect(admin.body.code).toBe('ROLE_CHANGE_REQUIRES_APPROVAL');
    expect((await create('QA', 2)).status).toBe(409);
    expect((await create('Analyst', 3)).status).toBe(201);
    expect((await create('Reviewer', 4)).status).toBe(201);
    expect((await sql(`SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [`new.person.${process.pid}.%`]))[0].n).toBe(2);
  });
});
