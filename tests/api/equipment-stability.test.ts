/**
 * Roadmap M13 (r1-quality-fixes), stability studies, as M31 (r2-stability) now defines them.
 *
 * Before M13: the server wrote 'Ongoing', the screen styled 'Active' and the edit form offered 'Ongoing / Completed / Aborted' while the
 * route accepted any string as a status; PUT changed the product, batch and condition of a study at any time, finished or not; the
 * pull points were always 1, 3, 6, 9 and 12.
 *
 * After: one vocabulary (Ongoing, Completed, Aborted) enforced by the server and shared with the screen; a finished study (Completed
 * or Aborted) is final (423). Since M31 a study is started from an Approved protocol and a master batch (product, batch, condition
 * and pull points come from them), and PUT only ends a study, with a reason: product, batch and condition are never edited.
 * The programme itself (protocols, timepoints, pulls) is tested in tests/api/stability-programme.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
let protocolId: string;
let batchId: string;
const tomorrow = () => { const d = new Date(Date.now() + 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
  const name = uniq('Paracetamol 500 mg');
  const p = await t.request.post('/api/products').set(H.qa).send({ code: uniq('PCM'), name });
  const b = await t.request.post('/api/batches').set(H.qa).send({ productId: p.body.id, batchNo: uniq('B') });
  batchId = b.body.id;
  await insertActiveSpec(t, name);
  const plan = uniq('TP');
  await t.db.pool.query(`INSERT INTO test_plans (id, code, name, material, purpose, parameters, revision, status) VALUES ($1, $2, 'Stability', $3, 'Stability', '["Assay (%)"]'::jsonb, 1, 'Effective')`, [uniq('TPL'), plan, name]);
  const draft = await t.request.post('/api/stability/protocols').set(H.reviewer).send({ code: uniq('SP'), title: 'Long term', productId: p.body.id, testPlanCode: plan, conditionIds: ['STC-LT-25-60'], monthPoints: [3, 6, 12, 24, 36], windowDays: 7 });
  const signed = await t.request.post(`/api/stability/protocols/${draft.body.id}/approve`).set(H.qa).send({ password: 'password', expectedVersion: 1 });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
  protocolId = draft.body.id;
});

async function study(over: Record<string, unknown> = {}) {
  const res = await t.request.post('/api/stability').set(H.analyst1).send({ protocolId, batchId, startDate: tomorrow(), ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; status: string; pullPoints: number[] };
}
const edit = (id: string, body: Record<string, unknown>, who: keyof typeof H = 'analyst1') => t.request.put(`/api/stability/${id}`).set(H[who]).send(body);
const REASON = 'End of the study';

describe('the status vocabulary', () => {
  it('a new study is Ongoing', async () => {
    expect((await study()).status).toBe('Ongoing');
  });

  it('a status outside Completed / Aborted is refused (400): "Active", "Approved", "Ongoing", free text', async () => {
    const s = await study();
    for (const status of ['Active', 'Approved', 'Ongoing', 'whatever', '', 7 as any]) {
      const res = await edit(s.id, { status, reason: REASON, expectedVersion: 1 });
      expect(res.status, `${String(status)}: ${JSON.stringify(res.body)}`).toBe(400);
    }
    expect((await one('SELECT status, version FROM stability_studies WHERE id = $1', [s.id]))).toEqual({ status: 'Ongoing', version: 1 });
  });

  it('a study cannot be created with a status of its own (the server starts it)', async () => {
    const res = await t.request.post('/api/stability').set(H.analyst1).send({ protocolId, batchId, startDate: tomorrow(), status: 'Completed' });
    expect(res.status).toBe(400);
  });
});

describe('the lock on a finished study', () => {
  it('product, batch and condition are never edited, also on an Ongoing study (400): they come from the protocol and the batch', async () => {
    const s = await study();
    for (const change of [{ product: 'Another product' }, { batch: 'Another batch' }, { condition: '30C/65%RH' }]) {
      const res = await edit(s.id, { ...change, expectedVersion: 1 });
      expect(res.status, JSON.stringify(change) + JSON.stringify(res.body)).toBe(400);
    }
    expect((await one('SELECT condition, version FROM stability_studies WHERE id = $1', [s.id]))).toEqual({ condition: 'LT-25-60', version: 1 });
  });

  it.each(['Completed', 'Aborted'])('a %s study can no longer be written (423) and the record is untouched', async (terminal) => {
    const s = await study();
    if (terminal === 'Completed') await t.db.pool.query(`UPDATE stability_timepoints SET status = 'Missed' WHERE study_id = $1`, [s.id]); // every pull finished
    expect((await edit(s.id, { status: terminal, reason: REASON, expectedVersion: 1 })).status).toBe(200);
    for (const status of ['Completed', 'Aborted']) {
      const res = await edit(s.id, { status, reason: REASON, expectedVersion: 2 });
      expect(res.status, status + JSON.stringify(res.body)).toBe(423);
      expect(res.body.code).toBe('RECORD_LOCKED');
    }
    expect(await one('SELECT status, version FROM stability_studies WHERE id = $1', [s.id])).toMatchObject({ status: terminal, version: 2 });
  });

  it('ending a study is audited with its old and new status and the reason', async () => {
    const s = await study();
    await edit(s.id, { status: 'Aborted', reason: 'Stored at the wrong condition', expectedVersion: 1 });
    const audit = await one(`SELECT * FROM audit_trail WHERE entity = 'StabilityStudy' AND entity_id = $1 AND action = 'StatusChange'`, [s.id]);
    expect(audit).toMatchObject({ user_id: 'usr-analyst1', field: 'status', old_value: 'Ongoing', new_value: 'Aborted', reason: 'Stored at the wrong condition' });
  });
});

describe('the rest of the contract', () => {
  it('a stale version is 409; a missing version is 400; an unknown study is 404; unknown keys are 400', async () => {
    const s = await study();
    expect((await edit(s.id, { status: 'Aborted', reason: REASON, expectedVersion: 9 })).status).toBe(409);
    expect((await edit(s.id, { status: 'Aborted', reason: REASON })).status).toBe(400);
    expect((await edit('STB-NOPE', { status: 'Aborted', reason: REASON, expectedVersion: 1 })).status).toBe(404);
    expect((await edit(s.id, { status: 'Aborted', reason: REASON, expectedVersion: 1, pullPoints: [1] })).status).toBe(400);
  });

  it('the pull points are the protocol\'s, never sent with the study', async () => {
    expect((await study()).pullPoints).toEqual([3, 6, 12, 24, 36]);
    const res = await t.request.post('/api/stability').set(H.analyst1).send({ protocolId, batchId, startDate: tomorrow(), pullPoints: [1, 3] });
    expect(res.status).toBe(400);
  });

  it('the start date must be a real date', async () => {
    for (const startDate of ['soon', '2026-02-30', '15/01/2026', '']) {
      const res = await t.request.post('/api/stability').set(H.analyst1).send({ protocolId, batchId, startDate });
      expect(res.status, startDate).toBe(400);
    }
  });
});
