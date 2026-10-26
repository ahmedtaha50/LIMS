/**
 * Platform-level safety nets (roadmap M01 acceptance and the "any authenticated user can crash the server" defect):
 *  - a malformed credential never reaches scrypt / jwt and never takes the process down,
 *  - errors leave the server as JSON with a request id and without SQL text,
 *  - a pre-MFA token is not a session.
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { generateSync } from 'otplib';
import { startTestApp, type TestApp } from '../../helpers/app';
import { TEST_PASSWORD } from '../../helpers/db';
import { uniq } from '../../helpers/fixtures';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });

const alive = async () => expect((await t.request.get('/api/samples').set(await t.auth('qa@gxp.com')).timeout(5000)).status).toBe(200);

// Every route that takes a password, with the minimum other fields. The guard must answer before any handler logic.
const passwordRoutes: Array<[method: 'post' | 'put', path: string, user: string | null, body: Record<string, unknown>]> = [
  ['post', '/api/auth/login-local', null, { email: 'qa@gxp.com' }],
  ['post', '/api/samples/SMP-NONE/notebook', 'analyst1@gxp.com', { content: 'observation' }],
  ['post', '/api/samples/SMP-NONE/transition', 'analyst1@gxp.com', { action: 'submit', expectedVersion: 1 }],
  ['post', '/api/eln/ELN-NONE/sign', 'analyst1@gxp.com', {}],
  ['post', '/api/training/usr-analyst1/certify', 'qa@gxp.com', { moduleName: 'GxP basics' }],
  ['post', '/api/traceability/batch/B-NONE/release', 'qa@gxp.com', {}],
  ['post', '/api/oos/OOS-NONE/close', 'qa@gxp.com', { rootCause: 'abcde', conclusion: 'abcde' }],
  ['post', '/api/specifications/SPEC-NONE/approve', 'qa@gxp.com', {}],
  ['post', '/api/instruments/INST-NONE/calibrate', 'qa@gxp.com', { newDueDate: '2030-01-01' }],
  ['put', '/api/admin/settings', 'admin@gxp.com', {}],
  ['put', '/api/admin/users/usr-qa', 'admin@gxp.com', {}],
  ['post', '/api/admin/backup', 'admin@gxp.com', { passphrase: 'a long enough passphrase' }],
  ['post', '/api/admin/backup/verify', 'admin@gxp.com', { file: 'none.bak' }],
];

describe('non-string password', () => {
  for (const bad of [123, { $ne: '' }, ['a'], null]) {
    it(`is refused with 400 on every password route (${JSON.stringify(bad)}) and the server stays up`, async () => {
      for (const [method, path, user, body] of passwordRoutes) {
        const headers = user ? await t.auth(user) : {};
        const res = await t.request[method](path).set(headers).timeout(5000).send({ ...body, password: bad });
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(400);
        expect(res.body.error, `${path}`).toMatch(/password/i);
      }
      await alive();
    });
  }

  it('is also refused for passphrase and tempToken', async () => {
    const admin = await t.auth('admin@gxp.com');
    expect((await t.request.post('/api/admin/backup').set(admin).timeout(5000).send({ password: TEST_PASSWORD, passphrase: 42 })).status).toBe(400);
    expect((await t.request.post('/api/auth/totp-verify').timeout(5000).send({ tempToken: {}, code: '000000' })).status).toBe(400);
    await alive();
  });
});

describe('malformed input to a handler that has no schema yet', () => {
  it('non-string notebook content is a 400, not a crash', async () => {
    const res = await t.request.post('/api/samples/SMP-NONE/notebook').set(await t.auth('analyst1@gxp.com')).timeout(5000)
      .send({ content: { not: 'text' }, password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    await alive();
  });

  it('an unknown field on the notebook route is rejected (strict schema)', async () => {
    const res = await t.request.post('/api/samples/SMP-NONE/notebook').set(await t.auth('analyst1@gxp.com')).timeout(5000)
      .send({ content: 'text', password: TEST_PASSWORD, enteredBy: 'someone-else' });
    expect(res.status).toBe(400);
  });
});

describe('create routes keep their strict contract after moving to validate()', () => {
  it('a server-controlled field is a 400, the legacy message is unchanged', async () => {
    const headers = await t.auth('analyst1@gxp.com');
    const res = await t.request.post('/api/stability').set(headers).send({ protocolId: 'STP-NONE', batchId: 'B-NONE', startDate: '2026-01-01', status: 'Completed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unrecognized key/);
  });

  it('valid input is created and audited as before', async () => {
    const headers = await t.auth('analyst1@gxp.com');
    const { startableStudy } = await import('../../api/stability-fixture');
    const f = await startableStudy(t);
    const res = await t.request.post('/api/stability').set(headers).send({ protocolId: f.protocolId, batchId: f.batchId, startDate: f.startDate });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'Ongoing', pullPoints: [3, 6] });
    const audits = await t.db.pool.query("SELECT user_id FROM audit_trail WHERE entity = 'StabilityStudy' AND entity_id = $1", [res.body.id]);
    expect(audits.rows.map(r => r.user_id)).toEqual(['usr-analyst1']); // actor comes from the token, not the body
  });
});

describe('error responses', () => {
  it('unknown API route is a JSON 404 with a request id', async () => {
    const res = await t.request.get('/api/does-not-exist').timeout(5000);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', error: expect.any(String), requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('malformed JSON is a JSON 400 without a stack trace', async () => {
    const res = await t.request.post('/api/auth/login-local').set('content-type', 'application/json').timeout(5000).send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ code: 'INVALID_JSON', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+.*\.(js|ts):\d+/);
  });

  it('a database failure never puts SQL text or parameters into the response', async () => {
    // version "abc" becomes NaN, which PostgreSQL rejects inside the handler's transaction.
    const res = await t.request.post('/api/specifications').set(await t.auth('analyst1@gxp.com')).timeout(5000)
      .send({ material: uniq('M'), version: 'abc', effectiveDate: '2026-01-01' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toMatch(/insert into|Failed query|params:/i);
    expect(res.body.requestId).toEqual(expect.any(String));
  });
});

describe('pre-MFA token', () => {
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  afterEach(async () => { await t.db.pool.query("UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = 'usr-reviewer'"); });

  it('is not accepted as a session, and the real second factor still is', async () => {
    await t.db.pool.query("UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = 'usr-reviewer'", [SECRET]);
    const login = await t.request.post('/api/auth/login-local').send({ email: 'reviewer@gxp.com', password: TEST_PASSWORD });
    expect(login.body).toMatchObject({ requiresTotp: true });
    expect(login.body.token).toBeUndefined();

    const withTemp = await t.request.get('/api/samples').set('Authorization', `Bearer ${login.body.tempToken}`).timeout(5000);
    expect(withTemp.status).toBe(401);

    const verified = await t.request.post('/api/auth/totp-verify').send({ tempToken: login.body.tempToken, code: generateSync({ secret: SECRET }) });
    expect(verified.status).toBe(200);
    const session = await t.request.get('/api/samples').set('Authorization', `Bearer ${verified.body.token}`);
    expect(session.status).toBe(200);
  });
});
