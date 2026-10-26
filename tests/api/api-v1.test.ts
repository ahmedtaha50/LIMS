/**
 * Roadmap M22 (r2-api-v1): the machine integration API.
 *
 * Before: the only credential was an interactive session token, there was no versioned prefix, writing results took one call per
 * result, and an instrument or a middleware system could only act as a person.
 *
 * After (acceptance of M22, each asserted below):
 *   - 500 results in one call, all or nothing, with one audit entry per result, and replaying the Idempotency-Key creates no new rows;
 *   - a results:write token calling any signing endpoint gets 403, and a revoked token gets 401;
 *   - (openapi.json and the docs page: tests/api/api-v1-openapi.test.ts).
 * Plus: API clients are created and revoked by an Administrator with an e-signature (ADMIN_AUTHORISATION, bound to the record version),
 * the token is shown once and only its SHA-256 is stored, every write is attributed to the client's own service account, the same
 * result rules apply as at the bench (state, limits, calibration, OOS investigation), and every error is application/problem+json.
 */
import { createHash } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, race, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
const PW = 'password';
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows as any[]);
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});

const ALL_SCOPES = ['samples:read', 'samples:write', 'results:write', 'specifications:read', 'batches:read'];

/** Creates an API client as the Administrator and returns it with its token (shown once). */
async function createClient(scopes: string[] = ALL_SCOPES, over: Record<string, unknown> = {}) {
  const res = await t.request.post('/api/api-clients').set(H.admin)
    .send({ name: uniq('HPLC-bridge'), scopes, expiresInDays: 30, password: PW, reason: 'Connect the chromatography data system', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { token: string; client: { id: string; userId: string; version: number; status: string; tokenPrefix: string; scopes: string[] } };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const v1 = {
  get: (path: string, token: string) => t.request.get(`/api/v1${path}`).set(bearer(token)),
  post: (path: string, token: string, body: unknown, key: string | null = uniq('idem')) => {
    const r = t.request.post(`/api/v1${path}`).set(bearer(token));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body as object);
  },
};

const PARAMS = [
  { name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null },
  { name: 'Impurity A', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2, text: null },
  { name: 'Impurity B', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2, text: null },
  { name: 'Water', unit: '%', limit_kind: 'NMT', lower: null, upper: 2.0, decimals: 1, text: null },
  { name: 'pH', unit: '', limit_kind: 'RANGE', lower: 5.0, upper: 7.0, decimals: 1, text: null },
];
const IN_SPEC: Record<string, string> = { Assay: '99.5', 'Impurity A': '0.10', 'Impurity B': '0.12', Water: '0.8', pH: '6.1' };

/** Registers `n` samples of a new material through the session API and moves them to Testing; returns their results. */
async function samplesInTesting(n: number, token?: string) {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, PARAMS as any);
  const ids: string[] = [];
  if (token) {
    const res = await v1.post('/samples:batch', token, { items: Array.from({ length: n }, () => ({ material, batch: uniq('B') })) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ids.push(...res.body.samples.map((s: any) => s.id));
  } else {
    for (let i = 0; i < n; i++) {
      const res = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      ids.push(res.body.id);
    }
  }
  await sql(`UPDATE samples SET state = 'Testing', version = version + 1 WHERE id = ANY($1)`, [ids]);
  const results = await sql('SELECT id, sample_id, parameter, version FROM results WHERE sample_id = ANY($1) ORDER BY sample_id, parameter', [ids]);
  return { material, ids, results: results as Array<{ id: string; sample_id: string; parameter: string; version: number }> };
}
const itemsOf = (rows: Array<{ id: string; sample_id: string; parameter: string; version: number }>, value?: (p: string) => string) =>
  rows.map(r => ({ sampleId: r.sample_id, resultId: r.id, value: value ? value(r.parameter) : IN_SPEC[r.parameter], expectedVersion: r.version }));

const isProblem = (res: { status: number; headers: Record<string, string>; body: any }, status: number, code?: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ status, title: expect.any(String), type: expect.any(String), requestId: expect.any(String) });
  if (code) expect(res.body.code).toBe(code);
};

describe('API clients: created and revoked by an Administrator with an e-signature', () => {
  it('shows the token once, stores only its hash, binds a service account and signs the creation', async () => {
    const { token, client } = await createClient(['results:write']);
    expect(token).toMatch(/^lims_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(client).toMatchObject({ status: 'Active', scopes: ['results:write'], version: 1 });
    expect(token.startsWith(client.tokenPrefix)).toBe(true);

    const row = await one('SELECT * FROM api_clients WHERE id = $1', [client.id]);
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token.slice(client.tokenPrefix.length + 1));

    const user = await one('SELECT role, active, email, password_hash FROM users WHERE id = $1', [client.userId]);
    expect(user).toEqual({ role: 'Instrument', active: true, email: null, password_hash: null });

    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'ApiClient' AND entity_id = $1`, [client.id]);
    expect(sig).toMatchObject({ meaning_code: 'ADMIN_AUTHORISATION', signer_id: 'usr-admin', record_version: 1, hash_version: 2 });
    const audit = await sql(`SELECT action, entity, user_id FROM audit_trail WHERE entity_id IN ($1, $2) ORDER BY sequence`, [client.id, client.userId]);
    expect(audit).toEqual([
      { action: 'Create', entity: 'User', user_id: 'usr-admin' },
      { action: 'Create', entity: 'ApiClient', user_id: 'usr-admin' },
    ]);
    expect(sig.audit_entry_id).toBe((await one(`SELECT id FROM audit_trail WHERE entity = 'ApiClient' AND entity_id = $1`, [client.id])).id);

    const verify = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.admin);
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('valid');

    const list = await t.request.get('/api/api-clients').set(H.admin);
    expect(list.status).toBe(200);
    const listed = list.body.clients.find((c: any) => c.id === client.id);
    expect(listed).toMatchObject({ status: 'Active', tokenPrefix: client.tokenPrefix });
    expect(JSON.stringify(list.body)).not.toMatch(/token_hash|tokenHash/);
    expect(list.body.scopes.map((s: any) => s.scope)).toEqual(ALL_SCOPES);
  });

  it('refuses a wrong password (nothing created), an unknown scope, a server field, and a non-Administrator', async () => {
    const name = uniq('Bridge');
    const before = Number((await one('SELECT count(*) FROM api_clients')).count);
    const failedBefore = (await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-admin'`)).n;
    const bad = await t.request.post('/api/api-clients').set(H.admin).send({ name, scopes: ['results:write'], expiresInDays: 30, password: 'wrong', reason: 'Connect it' });
    expect(bad.status).toBe(401);
    expect(Number((await one('SELECT count(*) FROM api_clients')).count)).toBe(before);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-admin'`)).n).toBe(failedBefore + 1);
    await sql(`UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-admin'`);

    const scope = await t.request.post('/api/api-clients').set(H.admin).send({ name, scopes: ['admin:all'], expiresInDays: 30, password: PW, reason: 'Connect it' });
    expect(scope.status).toBe(400);
    const server = await t.request.post('/api/api-clients').set(H.admin).send({ name, scopes: ['results:write'], expiresInDays: 30, password: PW, reason: 'Connect it', status: 'Active' });
    expect(server.status).toBe(400);
    const tooLong = await t.request.post('/api/api-clients').set(H.admin).send({ name, scopes: ['results:write'], expiresInDays: 400, password: PW, reason: 'Connect it' });
    expect(tooLong.status).toBe(400);
    const qa = await t.request.post('/api/api-clients').set(H.qa).send({ name, scopes: ['results:write'], expiresInDays: 30, password: PW, reason: 'Connect it' });
    expect(qa.status).toBe(403);
    expect((await t.request.get('/api/api-clients').set(H.analyst1)).status).toBe(403);
    expect(Number((await one('SELECT count(*) FROM api_clients')).count)).toBe(before);
  });

  it('revokes with a signature and the version the screen showed: a stale version is 409, the token stops working (401)', async () => {
    const { token, client } = await createClient(['samples:read']);
    expect((await v1.get('/samples?limit=1', token)).status).toBe(200);

    const stale = await t.request.post(`/api/api-clients/${client.id}/revoke`).set(H.admin).send({ expectedVersion: 7, password: PW, reason: 'Instrument retired' });
    expect(stale.status).toBe(409);
    const ok = await t.request.post(`/api/api-clients/${client.id}/revoke`).set(H.admin).send({ expectedVersion: client.version, password: PW, reason: 'Instrument retired' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'Revoked', version: 2, revokedBy: 'usr-admin', revokedReason: 'Instrument retired' });
    expect(await one('SELECT active FROM users WHERE id = $1', [client.userId])).toEqual({ active: false });
    const sigs = await sql(`SELECT record_version FROM signatures WHERE entity_type = 'ApiClient' AND entity_id = $1 ORDER BY timestamp`, [client.id]);
    expect(sigs.map(s => s.record_version)).toEqual([1, 2]);

    isProblem(await v1.get('/samples?limit=1', token), 401, 'TOKEN_REVOKED');
    const again = await t.request.post(`/api/api-clients/${client.id}/revoke`).set(H.admin).send({ expectedVersion: 2, password: PW, reason: 'Instrument retired' });
    expect(again.status).toBe(423);
  });

  it('an expired token is 401, and so is an unknown one or a session token on /api/v1', async () => {
    const { token, client } = await createClient(['samples:read']);
    await sql(`UPDATE api_clients SET expires_at = now() - interval '1 minute' WHERE id = $1`, [client.id]);
    isProblem(await v1.get('/samples', token), 401, 'TOKEN_EXPIRED');
    isProblem(await v1.get('/samples', 'lims_AAAAAAAA_' + 'x'.repeat(43)), 401, 'INVALID_TOKEN');
    isProblem(await t.request.get('/api/v1/samples'), 401, 'UNAUTHORIZED');
    isProblem(await t.request.get('/api/v1/samples').set(H.analyst1), 401, 'INVALID_TOKEN');
  });
});

describe('API tokens never sign and never use the interactive API', () => {
  it('a results:write token gets 403 on every signing endpoint (and on the rest of the session API), a revoked one 401', async () => {
    const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
    const signing = Object.keys(ROUTE_RULES).filter(r => /^(POST|PUT) /.test(r) && /sign|approve|close|release|transition|certify|calibrate|revoke|reject|complete|effectiveness|status/.test(r));
    expect(signing.length).toBeGreaterThan(15);
    const { token, client } = await createClient(['results:write']);
    for (const route of signing) {
      const [method, path] = route.split(' ');
      const url = '/api' + path.replace(/:[A-Za-z]+/g, 'X1');
      const res = await (t.request as any)[method.toLowerCase()](url).set(bearer(token)).send({ password: PW, expectedVersion: 1 });
      expect(res.status, `${route}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.code, route).toBe('API_TOKEN_NOT_ALLOWED');
    }
    expect((await t.request.get('/api/samples').set(bearer(token))).status).toBe(403);
    const denied = await one(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = $1`, [client.userId]);
    expect(denied.n).toBe(signing.length + 1);

    await t.request.post(`/api/api-clients/${client.id}/revoke`).set(H.admin).send({ expectedVersion: 1, password: PW, reason: 'Rotation' }).expect(200);
    const revoked = await t.request.post('/api/samples/X1/transition').set(bearer(token)).send({ action: 'approve', password: PW, expectedVersion: 1 });
    expect(revoked.status).toBe(401);
  });

  it('the service account holds no permission of the interactive API and has no credential to sign in with', async () => {
    const { client } = await createClient(['results:write']);
    const user = await one('SELECT role, email, password_hash FROM users WHERE id = $1', [client.userId]);
    expect((await sql('SELECT 1 FROM roles WHERE name = $1', [user.role])).length).toBe(0); // a role the matrix does not know holds nothing
    expect([user.email, user.password_hash]).toEqual([null, null]);
  });
});

describe('POST /v1/results:batch', () => {
  it('writes 500 results in one call with one audit entry each, attributed to the service account; replaying the key writes nothing', async () => {
    const { token, client } = await createClient();
    const { results } = await samplesInTesting(100, token);
    expect(results.length).toBe(500);
    const items = itemsOf(results);
    const auditBefore = Number((await one('SELECT count(*) FROM audit_trail')).count);
    const key = uniq('run');

    const res = await v1.post('/results:batch', token, { items }, key);
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(200);
    expect(res.body.count).toBe(500);
    expect(res.body.results[0]).toMatchObject({ sampleId: items[0].sampleId, resultId: items[0].resultId, version: 2, isOos: false, oosInvestigationId: null });
    const audit = await sql(`SELECT user_id, reason FROM audit_trail WHERE entity = 'Result' AND entity_id = ANY($1)`, [items.map(i => i.resultId)]);
    expect(audit.length).toBe(500);
    expect(new Set(audit.map(a => a.user_id))).toEqual(new Set([client.userId]));
    expect(audit[0].reason).toContain(key);
    const written = await sql(`SELECT entered_by, version FROM results WHERE id = ANY($1)`, [items.map(i => i.resultId)]);
    expect(written.every(r => r.entered_by === client.userId && r.version === 2)).toBe(true);
    const auditAfter = Number((await one('SELECT count(*) FROM audit_trail')).count);
    expect(auditAfter - auditBefore).toBe(500);

    const replay = await v1.post('/results:batch', token, { items }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.text).toBe(res.text);
    expect(Number((await one('SELECT count(*) FROM audit_trail')).count)).toBe(auditAfter);
    expect(await one(`SELECT count(*)::int AS n FROM results WHERE id = ANY($1) AND version = 2`, [items.map(i => i.resultId)])).toEqual({ n: 500 });

    isProblem(await v1.post('/results:batch', token, { items: items.slice(0, 2) }, key), 422, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('is all or nothing: one refused item writes no result and no audit entry, and the problem names the item', async () => {
    const { token } = await createClient();
    const { results } = await samplesInTesting(1);
    const items = itemsOf(results);
    items[3] = { ...items[3], value: '1,234.5' };
    const auditBefore = Number((await one('SELECT count(*) FROM audit_trail')).count);
    const res = await v1.post('/results:batch', token, { items });
    isProblem(res, 400);
    expect(res.body.errors).toEqual([expect.objectContaining({ index: 3, pointer: '/items/3', detail: expect.any(String) })]);
    expect(Number((await one('SELECT count(*) FROM audit_trail')).count)).toBe(auditBefore);
    expect(await one(`SELECT count(*)::int AS n FROM results WHERE id = ANY($1) AND value IS NOT NULL`, [items.map(i => i.resultId)])).toEqual({ n: 0 });

    // The key of a refused call was not spent: the corrected call goes through under the same key.
    const key = uniq('retry');
    isProblem(await v1.post('/results:batch', token, { items }, key), 400);
    items[3] = { ...items[3], value: '0.9' };
    expect((await v1.post('/results:batch', token, { items }, key)).status).toBe(200);
  });

  it('applies the bench rules: state, version, calibration, OOS investigation, first entry only', async () => {
    const { token } = await createClient();
    const { results, ids } = await samplesInTesting(1);
    const items = itemsOf(results);

    await sql(`UPDATE samples SET state = 'Pending Review' WHERE id = $1`, [ids[0]]);
    isProblem(await v1.post('/results:batch', token, { items: items.slice(0, 1) }), 409);
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [ids[0]]);

    isProblem(await v1.post('/results:batch', token, { items: [{ ...items[0], expectedVersion: 9 }] }), 409);

    const inst = uniq('INST');
    await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC', 'HPLC', 'Active', '2020-01-01', '2019-01-01')`, [inst]);
    const cal = await v1.post('/results:batch', token, { items: [{ ...items[0], instrumentId: inst }] });
    isProblem(cal, 400);
    expect(cal.body.errors[0].detail).toMatch(/calibration/);

    const assay = items.find(i => results.find(r => r.id === i.resultId)!.parameter === 'Assay')!;
    const oos = await v1.post('/results:batch', token, { items: [{ ...assay, value: '97.94' }] });
    expect(oos.status, JSON.stringify(oos.body)).toBe(200);
    expect(oos.body.results[0].isOos).toBe(true);
    expect(oos.body.results[0].oosInvestigationId).toMatch(/^OOS-\d{4}-\d{5}$/);
    const announced = await t.db.pool.query("SELECT actor_id FROM outbox_events WHERE type = 'result.oos_detected' AND payload->>'investigationId' = $1", [oos.body.results[0].oosInvestigationId]);
    expect(announced.rows).toHaveLength(1); // the OOS event of the outbox (r2-events), attributed to the service account
    expect(announced.rows[0].actor_id).toMatch(/^usr-api-/);

    // A value already entered is corrected by a person, not by the machine.
    const water = items.find(i => results.find(r => r.id === i.resultId)!.parameter === 'Water')!;
    expect((await v1.post('/results:batch', token, { items: [water] })).status).toBe(200);
    isProblem(await v1.post('/results:batch', token, { items: [{ ...water, value: '0.7', expectedVersion: 2 }] }), 409, 'RESULT_ALREADY_ENTERED');
  });

  it('needs the results:write scope, an Idempotency-Key, at most 500 items, strict items and distinct results', async () => {
    const { token: readOnly, client } = await createClient(['samples:read']);
    const { token } = await createClient();
    const { results } = await samplesInTesting(1);
    const items = itemsOf(results);
    isProblem(await v1.post('/results:batch', readOnly, { items }), 403, 'INSUFFICIENT_SCOPE');
    expect((await one(`SELECT count(*)::int AS n FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = $1`, [client.userId])).n).toBe(1);
    isProblem(await v1.post('/results:batch', token, { items }, null), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    isProblem(await v1.post('/results:batch', token, { items: Array.from({ length: 501 }, () => items[0]) }), 400, 'VALIDATION_FAILED');
    isProblem(await v1.post('/results:batch', token, { items: [{ ...items[0], enteredBy: 'usr-qa' }] }), 400, 'VALIDATION_FAILED');
    isProblem(await v1.post('/results:batch', token, { items: [items[0], items[0]] }), 400, 'VALIDATION_FAILED');
    isProblem(await v1.post('/results:batch', token, { items: [{ ...items[0], value: 99.5 }] }), 400, 'VALIDATION_FAILED');
  });

  it('two simultaneous calls with one key write once', async () => {
    const { token } = await createClient();
    const { results } = await samplesInTesting(1);
    const items = itemsOf(results);
    const key = uniq('twin');
    const codes = await race(2, () => v1.post('/results:batch', token, { items }, key));
    expect(codes).toEqual([200, 200]);
    expect((await sql(`SELECT 1 FROM audit_trail WHERE entity = 'Result' AND entity_id = ANY($1)`, [items.map(i => i.resultId)])).length).toBe(items.length);
  });
});

describe('POST /v1/samples:batch', () => {
  it('registers up to 500 samples all or nothing, attributed to the service account, and replays its key', async () => {
    const { token, client } = await createClient(['samples:write']);
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const key = uniq('reg');
    const items = Array.from({ length: 3 }, () => ({ material, batch: uniq('B') }));
    const res = await v1.post('/samples:batch', token, { items }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.count).toBe(3);
    const ids = res.body.samples.map((s: any) => s.id);
    expect(await sql('SELECT created_by, state FROM samples WHERE id = ANY($1)', [ids])).toEqual(ids.map(() => ({ created_by: client.userId, state: 'Logged' })));
    expect((await sql(`SELECT 1 FROM results WHERE sample_id = ANY($1)`, [ids])).length).toBe(15);
    const count = Number((await one('SELECT count(*) FROM samples')).count);
    const replay = await v1.post('/samples:batch', token, { items }, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(res.body);
    expect(Number((await one('SELECT count(*) FROM samples')).count)).toBe(count);

    const bad = await v1.post('/samples:batch', token, { items: [...items, { material: uniq('NoSpec'), batch: 'B' }] });
    isProblem(bad, 400);
    expect(bad.body.errors[0]).toMatchObject({ index: 3, pointer: '/items/3' });
    expect(Number((await one('SELECT count(*) FROM samples')).count)).toBe(count);
  });
});

describe('reads', () => {
  it('GET /v1/samples pages by cursor; GET /v1/samples/{id} gives the results with their versions', async () => {
    const { token } = await createClient(['samples:read', 'samples:write']);
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const batch = uniq('BATCH');
    await v1.post('/samples:batch', token, { items: Array.from({ length: 5 }, () => ({ material, batch })) }).expect(201);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await v1.get(`/samples?batch=${batch}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.map((s: any) => s.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    isProblem(await v1.get('/samples?cursor=garbage', token), 400);
    isProblem(await v1.get('/samples?limit=5000', token), 400, 'VALIDATION_FAILED');

    const detail = await v1.get(`/samples/${seen[0]}`, token);
    expect(detail.status).toBe(200);
    expect(detail.body.sample).toMatchObject({ id: seen[0], material, batch, state: 'Logged' });
    expect(detail.body.results.map((r: any) => r.parameter).sort()).toEqual(PARAMS.map(p => p.name).sort());
    expect(detail.body.results[0]).toEqual(expect.objectContaining({ id: expect.any(String), version: 1, value: null }));
    expect(JSON.stringify(detail.body)).not.toContain('attachmentData');
    isProblem(await v1.get('/samples/SMP-NONE', token), 404, 'NOT_FOUND');
  });

  it('GET /v1/specifications/active and GET /v1/batches/{batch}/disposition', async () => {
    const { token } = await createClient(['specifications:read', 'batches:read', 'samples:write']);
    const material = uniq('Mat');
    const specId = await insertActiveSpec(t, material, PARAMS as any);
    const spec = await v1.get(`/specifications/active?material=${encodeURIComponent(material.toUpperCase())}`, token);
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    expect(spec.body.data).toEqual([expect.objectContaining({ id: specId, material, parameters: expect.any(Array) })]);
    expect((await v1.get(`/specifications/active?material=${uniq('none')}`, token)).body.data).toEqual([]);

    const batch = uniq('BATCH');
    await v1.post('/samples:batch', token, { items: [{ material, batch }] }).expect(201);
    const disp = await v1.get(`/batches/${batch}/disposition`, token);
    expect(disp.status, JSON.stringify(disp.body)).toBe(200);
    expect(disp.body).toMatchObject({ batch, status: 'Quarantine Hold', releasable: false, samples: [{ state: 'Logged' }] });
    expect(disp.body.blockers.length).toBeGreaterThan(0);
    isProblem(await v1.get(`/batches/${uniq('NOPE')}/disposition`, token), 404);
    isProblem(await v1.get(`/specifications/active`, (await createClient(['samples:read'])).token), 403, 'INSUFFICIENT_SCOPE');
  });

  it('answers problem+json for an unknown route, a wrong method and malformed JSON', async () => {
    const { token } = await createClient(['results:write']);
    isProblem(await v1.get('/nothing-here', token), 404, 'NOT_FOUND');
    const wrong = await t.request.delete('/api/v1/samples').set(bearer(token));
    isProblem(wrong as any, 405, 'METHOD_NOT_ALLOWED');
    const bad = await t.request.post('/api/v1/results:batch').set(bearer(token)).set('Idempotency-Key', 'k1').set('Content-Type', 'application/json').send('{"items": [');
    isProblem(bad as any, 400, 'INVALID_JSON');
  });
});
