/**
 * Roadmap M24 (r2-ui-foundation): GET /api/lookup/:kind, the source of EntityPicker. Pickers are guidance only (the server still
 * validates every id a form sends); what a lookup returns must be small, current and must not leak what a picker does not need.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let h: { Authorization: string };
const get = (p: string) => t.request.get(`/api/lookup/${p}`).set(h);

beforeAll(async () => {
  t = await startTestApp();
  h = await t.auth('analyst1@gxp.com');
  await t.db.pool.query(`INSERT INTO samples (id, material, batch, state, created_by, version) VALUES
    ('SMP-LK-1', 'Lookup Paracetamol', 'LK-B1', 'Testing', 'usr-analyst1', 1),
    ('SMP-LK-2', 'Lookup Ibuprofen', 'LK-B2', 'Logged', 'usr-analyst1', 1)`);
  await t.db.pool.query(`INSERT INTO results (id, sample_id, parameter, value, is_oos, version) VALUES
    ('res-lk-1', 'SMP-LK-1', 'Assay (%)', '91.0', true, 1), ('res-lk-2', 'SMP-LK-1', 'Water (%)', '0.2', false, 1)`);
  await t.db.pool.query(`INSERT INTO users (id, uid, name, role, email, active) VALUES ('usr-lk-gone', 'lk-gone', 'Lookup Departed', 'Analyst', 'gone@gxp.com', false)`);
});

describe('lookups', () => {
  it('samples: matches id, material or batch and labels each option', async () => {
    const res = await get('samples?q=paracet');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([{ id: 'SMP-LK-1', label: 'SMP-LK-1', detail: 'Lookup Paracetamol · LK-B1 · Testing' }]);
    expect(res.body.truncated).toBe(false);
    expect((await get('samples?id=SMP-LK-2')).body.items.map((i: any) => i.id)).toEqual(['SMP-LK-2']);
  });

  it('results: of one sample, and only the out-of-specification ones when asked', async () => {
    const all = await get('results?sampleId=SMP-LK-1');
    expect(all.body.items.map((i: any) => i.id).sort()).toEqual(['res-lk-1', 'res-lk-2']);
    const oos = await get('results?sampleId=SMP-LK-1&oos=true');
    expect(oos.body.items).toEqual([{ id: 'res-lk-1', label: 'SMP-LK-1 · Assay (%)', detail: 'Result 91.0 · OOS' }]);
  });

  it('users: active accounts only, name and role, never e-mail, hashes or secrets', async () => {
    const res = await get('users?q=test');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(5);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(['detail', 'id', 'label']);
    expect(JSON.stringify(res.body)).not.toMatch(/@gxp\.com|password|totp/i);
    expect((await get('users?q=departed')).body.items).toEqual([]);
    expect((await get('users?role=QA')).body.items.map((i: any) => i.id)).toEqual(['usr-qa']);
  });

  // r2-api-v1: an API client acts as its own service account (role 'Instrument', name 'API client: ...'). Nobody assigns work to it,
  // so it is not an option in a user picker, also not when the picker asks for that role.
  it('users: never offers an API client service account', async () => {
    await t.db.pool.query(`INSERT INTO users (id, uid, name, role, email, active) VALUES ('usr-lk-svc', 'api-client:lk', 'API client: Lookup HPLC', 'Instrument', 'svc-lk@api.local', true)`);
    await t.db.pool.query(`INSERT INTO api_clients (id, name, user_id, token_prefix, token_hash, scopes, expires_at, created_by)
      VALUES ('apc-lk', 'Lookup HPLC', 'usr-lk-svc', 'lk00', 'lk-hash', '[]', now() + interval '30 days', 'usr-admin')`);
    expect((await get('users?q=lookup')).body.items).toEqual([]);
    expect((await get('users?q=api%20client')).body.items).toEqual([]);
    expect((await get('users?role=Instrument')).body.items).toEqual([]);
    expect((await get('users?id=usr-lk-svc')).body.items).toEqual([]);
  });

  it('specifications and instruments answer in the same shape', async () => {
    await t.db.pool.query(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters) VALUES ('SPEC-LK', 'Lookup Paracetamol', 1, 2, '2026-01-01', 'Active', '[]')`);
    expect((await get('specifications?q=paracet')).body.items).toEqual([{ id: 'SPEC-LK', label: 'Lookup Paracetamol Rev 2', detail: 'Active' }]);
    await t.db.pool.query(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('INS-LK', 'Lookup HPLC', 'HPLC', 'Active', '2027-01-01', '2026-01-01')`);
    expect((await get('instruments?q=hplc')).body.items).toEqual([{ id: 'INS-LK', label: 'Lookup HPLC', detail: 'HPLC · Active' }]);
  });

  it('says when there are more matches than it returns', async () => {
    const res = await get('users?limit=2');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.truncated).toBe(true);
  });

  it('is strict and needs a session; an unknown kind is not a route', async () => {
    expect((await get('samples?foo=1')).status).toBe(400);
    expect((await get('samples?limit=500')).status).toBe(400);
    expect((await get('passwords?q=a')).status).toBe(404);
    expect((await t.request.get('/api/lookup/samples')).status).toBe(401);
  });
});
