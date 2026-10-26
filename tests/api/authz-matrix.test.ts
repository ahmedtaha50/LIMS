/**
 * Roadmap M09 (r1-authz): the permission matrix is enforced by the server for every role, from one table.
 *
 *  - the default matrix reproduces the role checks the handlers made before (so validated behaviour does not move), and binds the
 *    routes that had no check at all to a privilege;
 *  - a role the matrix does not know gets nothing (the `roles` column used to be free text);
 *  - every refusal is recorded (security event AUTHZ_DENIED) and answers 403 with the permission that was missing;
 *  - the migrated tables equal the catalog in src/lib/permissions.ts, and GET /permissions/* show the matrix for access review.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
let seq = 0;

beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});

async function userWithRole(role: string) {
  const { generatePasswordHash } = await import('../../src/db/utils');
  const n = ++seq;
  const id = `usr-m${process.pid}-${n}`;
  const email = `m${process.pid}.${n}@gxp.test`;
  await t.db.pool.query(
    `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [id, `uid-${id}`, `Matrix Test ${n}`, role, email, generatePasswordHash(TEST_PASSWORD)],
  );
  const login = await t.request.post('/api/auth/login-local').send({ email, password: TEST_PASSWORD });
  return { id, email, headers: { Authorization: `Bearer ${login.body.token}` } };
}

const send = (method: string, path: string, who: { Authorization: string }, body?: unknown) => {
  const req = (t.request as any)[method.toLowerCase()](`/api${path}`).set(who);
  return body === undefined ? req : req.send(body);
};

// Role, route, body. `allowed` = the request gets past authorisation to the handler (the handler may still answer 400/404/401 for
// a nonexistent record or a wrong password); `denied` = 403.
type Case = [role: string, method: string, path: string, body: unknown, expected: 'allowed' | 'denied'];
const SIGN = { password: TEST_PASSWORD };
const CASES: Case[] = [
  // Role checks the handlers already made: the default matrix must reproduce them exactly.
  ['analyst1', 'GET', '/audit', undefined, 'denied'],
  ['reviewer', 'GET', '/audit', undefined, 'denied'],
  ['qa', 'GET', '/audit', undefined, 'allowed'],
  ['admin', 'GET', '/audit', undefined, 'allowed'],
  ['analyst1', 'GET', '/audit/history?entity=Sample&entityId=SMP-NONE', undefined, 'denied'],
  ['reviewer', 'GET', '/audit/history?entity=Sample&entityId=SMP-NONE', undefined, 'allowed'],
  ['reviewer', 'POST', '/samples', { material: 'M', batch: 'B' }, 'denied'],
  ['qa', 'POST', '/samples', { material: 'M', batch: 'B' }, 'denied'],
  ['analyst1', 'POST', '/samples', { material: 'No such material', batch: 'B' }, 'allowed'],
  ['admin', 'POST', '/samples', { material: 'No such material', batch: 'B' }, 'allowed'],
  ['reviewer', 'POST', '/samples/bulk-import', { items: [] }, 'denied'],
  ['analyst1', 'POST', '/samples/bulk-import', { items: [] }, 'allowed'],
  ['analyst1', 'POST', '/samples/SMP-NONE/transition', { action: 'submit', expectedVersion: 1 }, 'allowed'],
  ['qa', 'POST', '/samples/SMP-NONE/transition', { action: 'submit', expectedVersion: 1 }, 'allowed'],
  ['reviewer', 'PUT', '/samples/SMP-NONE/results/res-none', { value: '1', reason: 'entry', expectedVersion: 1 }, 'allowed'],
  ['analyst1', 'POST', '/oos/OOS-NONE/close', { rootCause: 'abcde', conclusion: 'abcde', password: TEST_PASSWORD }, 'denied'],
  ['reviewer', 'POST', '/oos/OOS-NONE/close', { rootCause: 'abcde', conclusion: 'abcde', password: TEST_PASSWORD }, 'denied'],
  ['qa', 'POST', '/oos/OOS-NONE/close', { rootCause: 'abcde', conclusion: 'abcde', password: TEST_PASSWORD }, 'allowed'],
  // (no password: the handler answers 400 to a caller it lets in, and nothing is released)
  ['analyst1', 'POST', '/traceability/batch/B-NONE/release', {}, 'denied'],
  ['reviewer', 'POST', '/traceability/batch/B-NONE/release', {}, 'denied'],
  ['qa', 'POST', '/traceability/batch/B-NONE/release', {}, 'allowed'],
  ['analyst1', 'POST', '/training/usr-none/certify', { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' }, 'denied'],
  ['qa', 'POST', '/training/usr-none/certify', { password: TEST_PASSWORD, moduleName: 'LIMS Core Software' }, 'allowed'],
  ['analyst1', 'GET', '/admin/users', undefined, 'denied'],
  ['reviewer', 'GET', '/admin/users', undefined, 'denied'],
  ['qa', 'GET', '/admin/users', undefined, 'allowed'],
  ['qa', 'GET', '/admin/settings', undefined, 'denied'],
  ['admin', 'GET', '/admin/settings', undefined, 'allowed'],
  ['qa', 'PUT', '/admin/settings', { x: 1 }, 'denied'],
  ['analyst1', 'GET', '/admin/jobs', undefined, 'denied'],
  ['qa', 'GET', '/admin/jobs', undefined, 'allowed'],
  ['analyst1', 'GET', '/admin/backup/status', undefined, 'denied'],
  ['qa', 'GET', '/admin/backup/status', undefined, 'allowed'],
  ['qa', 'POST', '/admin/backup', { password: TEST_PASSWORD }, 'denied'],
  ['analyst1', 'GET', '/security-events', undefined, 'denied'],
  ['qa', 'GET', '/security-events', undefined, 'allowed'],
  ['analyst1', 'POST', '/audit/verify', {}, 'denied'],
  ['qa', 'POST', '/audit/verify', {}, 'allowed'],
  // Reads are open to every role, as before.
  ['analyst1', 'GET', '/samples', undefined, 'allowed'],
  ['reviewer', 'GET', '/specifications', undefined, 'allowed'],
  ['analyst2', 'GET', '/system/info', undefined, 'allowed'],
  // Handlers that had no check at all are now bound to a privilege. Approving a specification is Admin and QA.
  ['analyst1', 'POST', '/specifications/SPEC-NONE/approve', SIGN, 'denied'],
  ['reviewer', 'POST', '/specifications/SPEC-NONE/approve', SIGN, 'denied'],
  ['qa', 'POST', '/specifications/SPEC-NONE/approve', SIGN, 'allowed'],
  ['admin', 'POST', '/specifications/SPEC-NONE/approve', SIGN, 'allowed'],
  // Creating and editing stay open to the roles that could (r1-core's tests rely on it); QA decides whether to tighten them.
  ['analyst1', 'POST', '/specifications', { material: 'M-matrix', version: 1, effectiveDate: '2026-01-01' }, 'allowed'],
];

describe('the default matrix reproduces today\'s role checks and binds the unprotected routes', () => {
  it.each(CASES)('%s %s %s -> %s', async (role, method, path, body, expected) => {
    const res = await send(method, path, H[role], body);
    if (expected === 'denied') {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    } else {
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
      expect(res.status, JSON.stringify(res.body)).not.toBe(401);
    }
  });
});

describe('a refusal names the missing permission and is recorded', () => {
  it('answers 403 PERMISSION_DENIED with the code, and writes a security event with who, what and where', async () => {
    const before = (await t.db.pool.query(`SELECT coalesce(max(sequence), 0)::int AS n FROM security_events`)).rows[0].n as number;
    const res = await t.request.post('/api/specifications/SPEC-NONE/approve').set(H.analyst1).send(SIGN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(res.body.details).toMatchObject({ permission: 'spec.approve' });

    const events = (await t.db.pool.query(
      `SELECT event_type, outcome, actor_id, actor_role, detail FROM security_events WHERE sequence > $1 AND event_type = 'AUTHZ_DENIED'`, [before])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'denied', actor_id: 'usr-analyst1', actor_role: 'Analyst' });
    expect(JSON.parse(events[0].detail)).toMatchObject({ permission: 'spec.approve', method: 'POST', route: '/specifications/:id/approve' });
  });

  it('a denied request changes nothing and the security chain still verifies', async () => {
    await t.request.post('/api/specifications/SPEC-NONE/approve').set(H.reviewer).send(SIGN);
    const verify = await t.request.post('/api/security-events/verify').set(H.qa).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.isValid).toBe(true);
  });

  it('an unauthenticated call to a protected route is 401, not 403, and an unknown API route is still 404', async () => {
    expect((await t.request.get('/api/samples')).status).toBe(401);
    expect((await t.request.post('/api/specifications/SPEC-NONE/approve').send(SIGN)).status).toBe(401);
    expect((await t.request.get('/api/definitely-not-a-route').set(H.admin)).status).toBe(404);
    expect((await t.request.delete('/api/samples/SMP-1').set(H.admin)).status).toBe(404); // a method no module registers
  });
});

describe('deny by default', () => {
  it('a user whose role is not in the matrix holds no permission: every protected route is 403', async () => {
    const root = await userWithRole('Root'); // the column is free text; the API only ever writes the four roles
    for (const [method, path] of [['GET', '/samples'], ['GET', '/specifications'], ['GET', '/dashboard'], ['GET', '/system/info'], ['POST', '/oos']] as const) {
      const res = await send(method, path, root.headers, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Self-service routes need no privilege: the account can still see who it is and sign out.
    expect((await t.request.get('/api/auth/me').set(root.headers)).status).toBe(200);
    const me = await t.request.get('/api/permissions/me').set(root.headers);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'Root', permissions: [] });
  });

  it('a session that must change its password reaches no protected route (the identity guard is not bypassed)', async () => {
    const u = await userWithRole('Analyst');
    await t.db.pool.query(`UPDATE users SET must_change_password = true WHERE id = $1`, [u.id]);
    const res = await t.request.get('/api/samples').set(u.headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('a deactivated user is refused before any permission is looked at', async () => {
    const u = await userWithRole('Admin');
    await t.db.pool.query(`UPDATE users SET active = false WHERE id = $1`, [u.id]);
    const res = await t.request.get('/api/samples').set(u.headers);
    expect(res.status).toBe(401);
  });
});

describe('the matrix on screen and in the database', () => {
  it('GET /permissions/me lists the permission codes of the signed-in role', async () => {
    const analyst = await t.request.get('/api/permissions/me').set(H.analyst1);
    expect(analyst.status).toBe(200);
    expect(analyst.body.role).toBe('Analyst');
    expect(analyst.body.permissions).toEqual(expect.arrayContaining(['sample.register', 'result.enter']));
    expect(analyst.body.permissions).not.toContain('spec.approve');
    const { DEFAULT_MATRIX } = await import('../../src/lib/permissions');
    expect([...analyst.body.permissions].sort()).toEqual([...DEFAULT_MATRIX.Analyst].sort());
    const admin = await t.request.get('/api/permissions/me').set(H.admin);
    expect([...admin.body.permissions].sort()).toEqual([...DEFAULT_MATRIX.Admin].sort());
  });

  it('GET /permissions/matrix is for Admin and QA and shows every role against every code', async () => {
    expect((await t.request.get('/api/permissions/matrix').set(H.analyst1)).status).toBe(403);
    const res = await t.request.get('/api/permissions/matrix').set(H.qa);
    expect(res.status).toBe(200);
    const { PERMISSIONS, ROLE_NAMES, DEFAULT_MATRIX } = await import('../../src/lib/permissions');
    expect(res.body.roles.map((r: any) => r.name).sort()).toEqual([...ROLE_NAMES].sort());
    expect(res.body.permissions).toHaveLength(PERMISSIONS.length);
    for (const role of ROLE_NAMES) expect([...res.body.grants[role]].sort()).toEqual([...DEFAULT_MATRIX[role]].sort());
    expect(res.body.roles.find((r: any) => r.name === 'Admin').requiresApproval).toBe(true);
    expect(res.body.roles.find((r: any) => r.name === 'Analyst').requiresApproval).toBe(false);
  });

  it('GET /permissions/matrix?format=csv is the export for access review', async () => {
    const res = await t.request.get('/api/permissions/matrix?format=csv').set(H.qa);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('permission,category,description,Admin,QA,Reviewer,Analyst,routes');
    expect(lines.find(l => l.startsWith('spec.approve,'))).toMatch(/,X,X,,,POST \/specifications\/:id\/approve$/);
  });

  it('the migrated tables equal the catalog (a change to the catalog without a migration fails here)', async () => {
    const { PERMISSIONS, ROLE_NAMES, DEFAULT_MATRIX, ROLES_REQUIRING_APPROVAL } = await import('../../src/lib/permissions');
    const q = (sql: string) => t.db.pool.query(sql).then(r => r.rows);
    expect((await q(`SELECT code FROM permissions ORDER BY code`)).map(r => r.code)).toEqual(PERMISSIONS.map(p => p.code).sort());
    expect((await q(`SELECT name FROM roles WHERE is_system ORDER BY name`)).map(r => r.name)).toEqual([...ROLE_NAMES].sort());
    for (const role of ROLE_NAMES) {
      const granted = (await q(`SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = '${role}' ORDER BY 1`)).map(r => r.permission_code);
      expect(granted, role).toEqual([...DEFAULT_MATRIX[role]].sort());
    }
    expect((await q(`SELECT name FROM roles WHERE requires_approval ORDER BY name`)).map(r => r.name)).toEqual([...ROLES_REQUIRING_APPROVAL].sort());
    expect((await q(`SELECT code FROM sod_rules ORDER BY code`)).map(r => r.code)).toEqual(['role.grant', 'spec.approve']);
  });

  it('every permission is held by at least one role and every code has the shape domain.action', async () => {
    const { PERMISSIONS, DEFAULT_MATRIX, ROLE_NAMES } = await import('../../src/lib/permissions');
    const held = new Set(ROLE_NAMES.flatMap(r => DEFAULT_MATRIX[r]));
    for (const p of PERMISSIONS) {
      expect(held.has(p.code), p.code).toBe(true);
      expect(p.code).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
    // Admin holds everything; nobody else holds the administration permissions.
    expect(DEFAULT_MATRIX.Admin).toHaveLength(PERMISSIONS.length);
    for (const role of ['QA', 'Reviewer', 'Analyst'] as const) {
      expect(DEFAULT_MATRIX[role].filter(c => /^admin\.(users\.manage|settings|integrations|broadcast|activity|backup\.run)/.test(c))).toEqual([]);
    }
  });
});
