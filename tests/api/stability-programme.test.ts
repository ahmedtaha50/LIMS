/**
 * Roadmap M31 (r2-stability), the stability programme, against the real application and PostgreSQL.
 *
 * Before: pull points were fixed at [1,3,6,9,12] and the screen could not change them; a study had no link to a protocol, batch,
 * sample, specification or test; no due date, chamber or overdue logic; PUT /stability let anyone change product, batch and condition.
 *
 * Acceptance:
 *   1. 8 months x 2 conditions generate 16 timepoints with correct dates across month ends and leap years.
 *   2. A timepoint turns Due and Missed with no user action, including after the PC was off (the scheduler's start-up catch-up).
 *   3. A pull creates a sample linked to its stability timepoint, with the result rows of the test plan. Editing an Approved
 *      protocol is refused (409).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, receiveSample, uniq } from '../helpers/fixtures';
import { addDays } from '../../src/server/stability/calendar';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const SIGN = { password: 'password' };
const pad = (n: number) => String(n).padStart(2, '0');
const localToday = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const post = (path: string, body: unknown, who: Who) => t.request.post(`/api${path}`).set(H[who]).send(body as object);
const put = (path: string, body: unknown, who: Who) => t.request.put(`/api${path}`).set(H[who]).send(body as object);
const get = (path: string, who: Who) => t.request.get(`/api${path}`).set(H[who]);
function ok<T = any>(res: { status: number; body: any }, status = 200): T {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}

/** A product with an Active specification (Assay, Dissolution, Appearance), an Effective stability test plan (Assay, Appearance) and a batch. */
async function product() {
  const name = uniq('Amlodipine 5 mg');
  const p = ok(await post('/products', { code: uniq('AML'), name }, 'qa'));
  const b = ok(await post('/batches', { productId: p.id, batchNo: uniq('B') }, 'qa'));
  await insertActiveSpec(t, name, [{ name: 'Assay', min: 95, max: 105 }, { name: 'Dissolution', min: 80, max: 100 }, { name: 'Appearance', min: 0, max: 0 }] as any);
  const planCode = uniq('TP-STAB');
  await t.db.pool.query(`INSERT INTO test_plans (id, code, name, material, purpose, parameters, revision, status) VALUES ($1, $2, 'Stability pull', $3, 'Stability', '["Assay","Appearance"]'::jsonb, 1, 'Effective')`, [uniq('TPL'), planCode, name]);
  return { productId: p.id as string, name, batchId: b.id as string, batchNo: b.batchNo as string, planCode };
}

/** A protocol drafted by the Reviewer and approved by QA. */
async function approvedProtocol(pr: Awaited<ReturnType<typeof product>>, over: Record<string, unknown> = {}) {
  const draft = ok(await post('/stability/protocols', {
    code: uniq('SP'), title: 'Long term and accelerated', productId: pr.productId, testPlanCode: pr.planCode,
    conditionIds: ['STC-LT-25-60', 'STC-ACC-40-75'], monthPoints: [0, 3, 6], windowDays: 7, ...over,
  }, 'reviewer'));
  const signed = ok(await post(`/stability/protocols/${draft.id}/approve`, { ...SIGN, expectedVersion: draft.version }, 'qa'));
  return signed.protocol as { id: string; code: string; revision: number; version: number; status: string };
}

describe('protocols: drafted, signed by someone else, never edited once Approved', () => {
  it('a Reviewer drafts, QA signs STABILITY_PROTOCOL_APPROVAL bound to the new version; the author may not approve (403 SOD_VIOLATION)', async () => {
    const pr = await product();
    const draft = ok(await post('/stability/protocols', { code: uniq('SP'), title: 'T', productId: pr.productId, testPlanCode: pr.planCode, conditionIds: ['STC-LT-25-60'], monthPoints: [0, 6, 12], windowDays: 14 }, 'qa'));
    expect(draft).toMatchObject({ status: 'Draft', revision: 1, monthPoints: [0, 6, 12], windowDays: 14 });
    expect(draft.conditions).toEqual([expect.objectContaining({ conditionId: 'STC-LT-25-60', code: 'LT-25-60', temperatureC: '25', humidityRh: '60' })]);
    const self = await post(`/stability/protocols/${draft.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'qa');
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.code).toBe('SOD_VIOLATION');
    expect((await post(`/stability/protocols/${draft.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'reviewer')).status).toBe(403); // no stability.approve
    const signed = ok(await post(`/stability/protocols/${draft.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin'));
    expect(signed.protocol).toMatchObject({ status: 'Approved', approvedBy: 'usr-admin', version: 2 });
    expect(signed.signature).toMatchObject({ entityType: 'StabilityProtocol', meaningCode: 'STABILITY_PROTOCOL_APPROVAL', recordVersion: 2 });
    const verify = ok(await get(`/signatures/verify/${signed.signature.id}`, 'qa'));
    expect(verify.valid, JSON.stringify(verify)).toBe(true);
  });

  it('editing an Approved protocol is refused (409 PROTOCOL_LOCKED, acceptance M31.3); a change is a new revision, signed again, which supersedes the old one', async () => {
    const pr = await product();
    const p1 = await approvedProtocol(pr);
    for (const change of [{ monthPoints: [0, 1] }, { windowDays: 30 }, { title: 'x' }, { conditionIds: ['STC-LT-30-65'] }]) {
      const res = await put(`/stability/protocols/${p1.id}`, { ...change, expectedVersion: p1.version }, 'reviewer');
      expect(res.status, JSON.stringify(change)).toBe(409);
      expect(res.body.code).toBe('PROTOCOL_LOCKED');
    }
    expect((await put(`/stability/protocols/${p1.id}`, { windowDays: 30, expectedVersion: p1.version }, 'analyst1')).status).toBe(403);
    expect(await one('SELECT window_days, version, status FROM stability_protocols WHERE id = $1', [p1.id])).toEqual({ window_days: 7, version: 2, status: 'Approved' });

    const r2 = ok(await post(`/stability/protocols/${p1.id}/revise`, {}, 'reviewer'));
    expect(r2).toMatchObject({ code: p1.code, revision: 2, status: 'Draft' });
    expect((await post(`/stability/protocols/${p1.id}/revise`, {}, 'reviewer')).status).toBe(409); // one Draft at a time
    const edited = ok(await put(`/stability/protocols/${r2.id}`, { monthPoints: [0, 3, 6, 9, 12], expectedVersion: 1 }, 'reviewer'));
    expect(edited.monthPoints).toEqual([0, 3, 6, 9, 12]);
    expect((await put(`/stability/protocols/${r2.id}`, { monthPoints: [0, 3], expectedVersion: 1 }, 'reviewer')).status).toBe(409); // stale
    const audit = await one(`SELECT user_id, field, old_value, new_value FROM audit_trail WHERE entity = 'StabilityProtocol' AND entity_id = $1 AND action = 'Update'`, [r2.id]);
    expect(audit).toEqual({ user_id: 'usr-reviewer', field: 'monthPoints', old_value: '[0,3,6]', new_value: '[0,3,6,9,12]' });
    ok(await post(`/stability/protocols/${r2.id}/approve`, { ...SIGN, expectedVersion: 2 }, 'qa'));
    expect((await sql('SELECT revision, status FROM stability_protocols WHERE code = $1 ORDER BY revision', [p1.code]))).toEqual([{ revision: 1, status: 'Superseded' }, { revision: 2, status: 'Approved' }]);
    // a new study is started only under the Approved revision
    const res = await post('/stability', { protocolId: p1.id, batchId: pr.batchId, startDate: addDays(localToday(), 1) }, 'analyst1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTOCOL_NOT_APPROVED');
  });

  it('approval needs the Effective test plan of the product: a plan of another material or no Effective plan is 409, before the password is checked', async () => {
    const pr = await product();
    const other = await product();
    const wrong = ok(await post('/stability/protocols', { code: uniq('SP'), title: 'T', productId: pr.productId, testPlanCode: other.planCode, conditionIds: ['STC-LT-25-60'], monthPoints: [0], windowDays: 0 }, 'reviewer'));
    const r1 = await post(`/stability/protocols/${wrong.id}/approve`, { password: 'wrong', expectedVersion: 1 }, 'qa');
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('TEST_PLAN_MISMATCH');
    const none = ok(await post('/stability/protocols', { code: uniq('SP'), title: 'T', productId: pr.productId, testPlanCode: 'NO-SUCH-PLAN', conditionIds: ['STC-LT-25-60'], monthPoints: [0], windowDays: 0 }, 'reviewer'));
    expect((await post(`/stability/protocols/${none.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'qa')).body.code).toBe('TEST_PLAN_NOT_EFFECTIVE');
  });

  it('strict input: server fields, bad month points, unknown conditions and an Analyst are refused', async () => {
    const pr = await product();
    const base = { code: uniq('SP'), title: 'T', productId: pr.productId, testPlanCode: pr.planCode, conditionIds: ['STC-LT-25-60'], monthPoints: [0, 3], windowDays: 7 };
    for (const bad of [{ status: 'Approved' }, { revision: 3 }, { version: 1 }, { monthPoints: [3, 1] }, { monthPoints: [0, 0] }, { monthPoints: [121] }, { monthPoints: [] }, { windowDays: 61 }, { conditionIds: [] }, { conditionIds: ['STC-LT-25-60', 'STC-LT-25-60'] }]) {
      expect((await post('/stability/protocols', { ...base, ...bad }, 'reviewer')).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/stability/protocols', { ...base, conditionIds: ['STC-NOPE'] }, 'reviewer')).status).toBe(400);
    expect((await post('/stability/protocols', base, 'analyst1')).status).toBe(403);
    ok(await post('/stability/protocols', base, 'reviewer'));
    expect((await post('/stability/protocols', { ...base, code: base.code.toLowerCase() }, 'reviewer')).status).toBe(409);
  });
});

describe('studies: from an Approved protocol and a master batch, with their timepoints', () => {
  it('8 month points x 2 conditions give 16 timepoints with the right due dates across month ends and a leap year (acceptance M31.1)', async () => {
    const pr = await product();
    const p = await approvedProtocol(pr, { monthPoints: [0, 1, 2, 3, 6, 9, 12, 13], windowDays: 7 });
    const study = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: '2027-11-30' }, 'analyst1'));
    expect(study).toMatchObject({ product: pr.name, batch: pr.batchNo, condition: 'LT-25-60, ACC-40-75', pullPoints: [0, 1, 2, 3, 6, 9, 12, 13], status: 'Ongoing', protocolId: p.id, batchId: pr.batchId });
    const rows = await sql('SELECT condition_code, month, due_date, window_start, window_end, status FROM stability_timepoints WHERE study_id = $1 ORDER BY condition_code COLLATE "C", month', [study.id]);
    expect(rows).toHaveLength(16);
    const dates = ['2027-11-30', '2027-12-30', '2028-01-30', '2028-02-29', '2028-05-30', '2028-08-30', '2028-11-30', '2028-12-30'];
    for (const code of ['ACC-40-75', 'LT-25-60']) expect(rows.filter(r => r.condition_code === code).map(r => r.due_date), code).toEqual(dates);
    expect(rows.find(r => r.month === 3)).toMatchObject({ window_start: '2028-02-22', window_end: '2028-03-07', status: 'Scheduled' });
    expect(new Set(rows.map(r => r.status))).toEqual(new Set(['Scheduled']));
    expect((await one(`SELECT count(*)::int n FROM audit_trail WHERE entity = 'StabilityTimepoint' AND action = 'Create' AND entity_id IN (SELECT id FROM stability_timepoints WHERE study_id = $1)`, [study.id])).n).toBe(16);
    expect(await one('SELECT protocol_id, batch_id, product_id, created_by FROM stability_study_links WHERE study_id = $1', [study.id]))
      .toEqual({ protocol_id: p.id, batch_id: pr.batchId, product_id: pr.productId, created_by: 'usr-analyst1' });
    const detail = ok(await get(`/stability/studies/${study.id}`, 'reviewer'));
    expect(detail.timepoints).toHaveLength(16);
    expect(detail.protocol).toMatchObject({ id: p.id, revision: 1 });
  });

  it('refuses free text (the old body), a batch of another product, a chamber of another condition, and a start whose windows already closed', async () => {
    const pr = await product();
    const p = await approvedProtocol(pr);
    const other = await product();
    const old = await post('/stability', { product: 'P', batch: 'B', condition: '25C/60%RH', startDate: '2026-01-15' }, 'analyst1');
    expect(old.status).toBe(400);
    expect((await post('/stability', { protocolId: p.id, batchId: other.batchId, startDate: localToday() }, 'analyst1')).status).toBe(400);
    const ch = ok(await post('/stability/chambers', { code: uniq('CH'), name: 'Walk-in 1', conditionId: 'STC-ACC-40-75' }, 'reviewer'));
    expect((await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday(), chambers: { 'STC-LT-25-60': ch.id } }, 'analyst1')).status).toBe(400);
    const late = await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: addDays(localToday(), -30) }, 'analyst1');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('START_DATE_TOO_EARLY');
    const good = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday(), chambers: { 'STC-ACC-40-75': ch.id } }, 'analyst1'));
    const tps = await sql('SELECT condition_code, chamber_id, status, month FROM stability_timepoints WHERE study_id = $1 ORDER BY condition_code COLLATE "C", month', [good.id]);
    expect(tps.filter(r => r.condition_code === 'ACC-40-75').every(r => r.chamber_id === ch.id)).toBe(true);
    expect(tps.filter(r => r.month === 0).map(r => r.status)).toEqual(['Due', 'Due']); // month 0: the window is open today
  });

  it('PUT no longer edits product, batch or condition; it ends a study with a reason; Completed needs every timepoint finished; a finished study is final', async () => {
    const pr = await product();
    const p = await approvedProtocol(pr);
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: addDays(localToday(), 1) }, 'analyst1'));
    for (const change of [{ product: 'X' }, { batch: 'X' }, { condition: '40C/75%RH' }, { pullPoints: [1] }]) {
      expect((await put(`/stability/${s.id}`, { ...change, expectedVersion: 1 }, 'analyst1')).status, JSON.stringify(change)).toBe(400);
    }
    expect((await put(`/stability/${s.id}`, { status: 'Aborted', expectedVersion: 1 }, 'analyst1')).status).toBe(400); // no reason
    const done = await put(`/stability/${s.id}`, { status: 'Completed', reason: 'All pulls tested', expectedVersion: 1 }, 'analyst1');
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('TIMEPOINTS_OPEN');
    ok(await put(`/stability/${s.id}`, { status: 'Aborted', reason: 'Batch recalled by the manufacturer', expectedVersion: 1 }, 'analyst1'));
    expect(await one(`SELECT old_value, new_value, reason, user_id FROM audit_trail WHERE entity = 'StabilityStudy' AND entity_id = $1 AND action = 'StatusChange'`, [s.id]))
      .toEqual({ old_value: 'Ongoing', new_value: 'Aborted', reason: 'Batch recalled by the manufacturer', user_id: 'usr-analyst1' });
    expect((await put(`/stability/${s.id}`, { status: 'Completed', reason: 'again please', expectedVersion: 2 }, 'analyst1')).status).toBe(423);
    expect(await one('SELECT product, batch, condition FROM stability_studies WHERE id = $1', [s.id])).toEqual({ product: pr.name, batch: pr.batchNo, condition: 'LT-25-60, ACC-40-75' });
  });
});

describe('the pull: a normal sample with the test plan, inside the window', () => {
  it('creates a sample linked to its timepoint, with only the test plan\'s result rows and the limits of the specification in force (acceptance M31.3)', async () => {
    const pr = await product();
    const p = await approvedProtocol(pr);
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday() }, 'analyst1'));
    const tp = await one(`SELECT id, version FROM stability_timepoints WHERE study_id = $1 AND condition_code = 'LT-25-60' AND month = 0`, [s.id]);
    expect((await post(`/stability/timepoints/${tp.id}/pull`, { expectedVersion: tp.version }, 'reviewer')).status).toBe(403); // sample.register
    expect((await post(`/stability/timepoints/${tp.id}/pull`, { expectedVersion: tp.version + 5 }, 'analyst2')).status).toBe(409);
    const pulled = ok(await post(`/stability/timepoints/${tp.id}/pull`, { expectedVersion: tp.version }, 'analyst2'));
    expect(pulled.timepoint).toMatchObject({ id: tp.id, status: 'Pulled', sampleId: pulled.sample.id, pulledBy: 'usr-analyst2' });
    expect(pulled.sample).toMatchObject({ material: pr.name, batch: pr.batchNo, state: 'Logged', createdBy: 'usr-analyst2' });
    const results = await sql('SELECT parameter, spec_min, spec_max FROM results WHERE sample_id = $1 ORDER BY parameter COLLATE "C"', [pulled.sample.id]);
    expect(results.map(r => r.parameter)).toEqual(['Appearance', 'Assay']); // not Dissolution: the plan names Assay and Appearance
    expect(results.find(r => r.parameter === 'Assay')).toMatchObject({ spec_min: 95, spec_max: 105 });
    expect(await one('SELECT sample_id FROM stability_timepoints WHERE id = $1', [tp.id])).toEqual({ sample_id: pulled.sample.id });
    expect(await one('SELECT product_id, batch_id, origin FROM sample_context WHERE sample_id = $1', [pulled.sample.id])).toEqual({ product_id: pr.productId, batch_id: pr.batchId, origin: 'stability' });
    const created = await one(`SELECT reason FROM audit_trail WHERE entity = 'Sample' AND entity_id = $1 AND action = 'Create'`, [pulled.sample.id]);
    expect(created.reason).toContain(tp.id);
    expect(await one(`SELECT user_id, old_value, new_value FROM audit_trail WHERE entity = 'StabilityTimepoint' AND entity_id = $1 AND action = 'Pull'`, [tp.id]))
      .toEqual({ user_id: 'usr-analyst2', old_value: 'Due', new_value: 'Pulled' });
    // the same timepoint again: 409, and no second sample
    const again = await post(`/stability/timepoints/${tp.id}/pull`, { expectedVersion: tp.version + 1 }, 'analyst2');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PULLED');
    expect((await one(`SELECT count(*)::int n FROM samples WHERE material = $1`, [pr.name])).n).toBe(1);
  });

  it('is refused before the window opens (409 PULL_NOT_DUE) and on a Missed timepoint, with no sample written', async () => {
    const pr = await product();
    const p = await approvedProtocol(pr);
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday() }, 'analyst1'));
    const m3 = await one(`SELECT id, version, window_start FROM stability_timepoints WHERE study_id = $1 AND condition_code = 'LT-25-60' AND month = 3`, [s.id]);
    const early = await post(`/stability/timepoints/${m3.id}/pull`, { expectedVersion: m3.version }, 'analyst1');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('PULL_NOT_DUE');
    expect(early.body.error).toContain(m3.window_start);
    expect((await one(`SELECT count(*)::int n FROM samples WHERE material = $1`, [pr.name])).n).toBe(0);
  });
});

describe('Due and Missed with no user action (acceptance M31.2)', () => {
  it('the sweep moves Scheduled to Due when the window opens and to Missed when it closes, and a missed pull opens a deviation', async () => {
    const { runStabilitySweep } = await import('../../src/server/stability/sweep');
    const pr = await product();
    const p = await approvedProtocol(pr, { conditionIds: ['STC-LT-25-60'], monthPoints: [1, 2], windowDays: 5 });
    const start = addDays(localToday(), 1);
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: start }, 'analyst1'));
    const tps = await sql('SELECT id, month, due_date, window_start, window_end FROM stability_timepoints WHERE study_id = $1 ORDER BY month', [s.id]);
    const [m1, m2] = tps;
    const status = async () => (await sql('SELECT status FROM stability_timepoints WHERE study_id = $1 ORDER BY month', [s.id])).map(r => r.status);
    const at = (day: string) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, 12, 0); };

    const { db } = await import('../../src/db/index');
    expect(await status()).toEqual(['Scheduled', 'Scheduled']);
    await runStabilitySweep(db, { now: at(addDays(m1.window_start, -1)) });
    expect(await status()).toEqual(['Scheduled', 'Scheduled']);
    expect(await runStabilitySweep(db, { now: at(m1.window_start) })).toMatchObject({ due: 1, missed: 0 });
    expect(await status()).toEqual(['Due', 'Scheduled']);
    const overdue = ok<any[]>(await get('/stability/timepoints?status=Due', 'analyst1')).find(x => x.id === m1.id);
    expect(overdue).toMatchObject({ status: 'Due' });

    // the PC is off from before the first window closes until after the second one closed: one run catches up both
    const r = await runStabilitySweep(db, { now: at(addDays(m2.window_end, 1)) });
    expect(r).toMatchObject({ missed: 2 });
    expect(await status()).toEqual(['Missed', 'Missed']);
    const rows = await sql(`SELECT t.id, t.deviation_id, q.type, q.state, q.origin, q.source_type, q.source_id FROM stability_timepoints t JOIN qms_records q ON q.id = t.deviation_id WHERE t.study_id = $1 ORDER BY t.month`, [s.id]);
    expect(rows).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({ id: tps[i].id, type: 'Deviation', state: 'QA Triage', origin: 'auto:stability-pull-missed', source_type: 'StabilityTimepoint', source_id: tps[i].id });
    }
    const audit = await sql(`SELECT user_id, old_value, new_value FROM audit_trail WHERE entity = 'StabilityTimepoint' AND entity_id = $1 AND action = 'StatusChange' ORDER BY sequence`, [m2.id]);
    expect(audit).toEqual([{ user_id: 'svc-scheduler', old_value: 'Scheduled', new_value: 'Missed' }]); // straight to Missed: the PC was off over the whole window
    // a missed pull cannot be pulled afterwards; a second run changes nothing and opens no second deviation
    const v = await one('SELECT version FROM stability_timepoints WHERE id = $1', [m1.id]);
    expect((await post(`/stability/timepoints/${m1.id}/pull`, { expectedVersion: v.version }, 'analyst1')).body.code).toBe('PULL_MISSED');
    expect(await runStabilitySweep(db, { now: at(addDays(m2.window_end, 2)) })).toMatchObject({ due: 0, missed: 0 });
    expect((await one(`SELECT count(*)::int n FROM qms_records WHERE source_type = 'StabilityTimepoint' AND source_id = ANY($1)`, [tps.map(x => x.id)])).n).toBe(2);
  });

  it('after the PC was off, the scheduler runs the sweep once at start-up, as the service principal, with nobody signed in', async () => {
    const sched = await import('../../src/server/scheduler');
    const { SCHEDULES } = await import('../../src/server/schedules/index');
    const { startRunner } = await import('../../src/server/jobs/runner');
    const { db } = await import('../../src/db/index');
    expect(SCHEDULES.map(s => s.name)).toContain('stability.timepoints');

    const pr = await product();
    const p = await approvedProtocol(pr, { conditionIds: ['STC-LT-25-60'], monthPoints: [0, 1], windowDays: 3 });
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday() }, 'analyst1'));
    // Arrange "registered six weeks ago": the calendar of the study as it was planned then (the PC was off since).
    await t.db.pool.query(`UPDATE stability_timepoints SET due_date = $2, window_start = $2, window_end = $3, status = 'Scheduled' WHERE study_id = $1 AND month = 0`, [s.id, addDays(localToday(), -42), addDays(localToday(), -39)]);
    await t.db.pool.query(`UPDATE stability_timepoints SET window_start = $2, due_date = $3, window_end = $4, status = 'Scheduled' WHERE study_id = $1 AND month = 1`, [s.id, addDays(localToday(), -15), addDays(localToday(), -12), addDays(localToday(), -9)]);

    const offSince = new Date(Date.now() - 6 * 3600_000);
    await t.db.pool.query(`DELETE FROM scheduled_jobs WHERE name = 'stability.timepoints'`);
    await sched.ensureSchedules(db, SCHEDULES.filter(x => x.name === 'stability.timepoints'), offSince);
    const { enqueued } = await sched.runDueSchedules(db, { now: new Date() });
    const run = enqueued.find(e => e.name === 'stability.timepoints')!;
    expect(run.missed).toBeGreaterThanOrEqual(4); // several hourly slots passed while off: ONE job
    const runner = startRunner({ db, pollMs: 25, sweepMs: 500, heartbeatMs: 200, leaseSeconds: 30, handlers: { 'stability.timepoints': (await import('../../src/server/schedules/stability')).stabilityTimepointsHandler } });
    try {
      for (let i = 0; i < 200; i++) {
        const job = await one('SELECT status FROM jobs WHERE id = $1', [run.jobId]);
        if (job.status === 'completed' || job.status === 'failed') break;
        await new Promise(r => setTimeout(r, 50));
      }
    } finally { await runner.stop(); }
    const job = await one('SELECT status, created_by, last_error FROM jobs WHERE id = $1', [run.jobId]);
    expect(job, JSON.stringify(job)).toMatchObject({ status: 'completed', created_by: 'svc-scheduler' });
    expect((await sql('SELECT status FROM stability_timepoints WHERE study_id = $1 ORDER BY month', [s.id])).map(r => r.status)).toEqual(['Missed', 'Missed']);
  });

  it('a pulled timepoint follows its sample: InTesting when the sample is submitted, Complete when it is approved', async () => {
    const { runStabilitySweep } = await import('../../src/server/stability/sweep');
    const { db } = await import('../../src/db/index');
    const pr = await product();
    const p = await approvedProtocol(pr, { conditionIds: ['STC-LT-25-60'], monthPoints: [0], windowDays: 3 });
    const s = ok(await post('/stability', { protocolId: p.id, batchId: pr.batchId, startDate: localToday() }, 'analyst1'));
    const tp = await one('SELECT id, version FROM stability_timepoints WHERE study_id = $1', [s.id]);
    const pulled = ok(await post(`/stability/timepoints/${tp.id}/pull`, { expectedVersion: tp.version }, 'analyst1'));
    await receiveSample(t, pulled.sample.id); // M29: testing starts only on a received sample
    ok(await post(`/samples/${pulled.sample.id}/transition`, { action: 'submit', expectedVersion: 1 }, 'analyst1'));
    await runStabilitySweep(db);
    expect((await one('SELECT status FROM stability_timepoints WHERE id = $1', [tp.id])).status).toBe('InTesting');
    // (approval needs results and signatures; the sample state is arranged directly here, the sweep is under test)
    await t.db.pool.query(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [pulled.sample.id]);
    await runStabilitySweep(db);
    expect((await one('SELECT status FROM stability_timepoints WHERE id = $1', [tp.id])).status).toBe('Complete');
    ok(await put(`/stability/${s.id}`, { status: 'Completed', reason: 'All pulls tested and approved', expectedVersion: 1 }, 'analyst1'));
  });
});

describe('the condition master and the chambers', () => {
  it('ships the ICH Q1A(R2) conditions; a site adds its own (unique code), edits with a reason (audited) and deactivates; a chamber needs an Active condition', async () => {
    const list = ok<any[]>(await get('/stability/conditions', 'analyst1'));
    expect(list.map(c => c.code)).toEqual(expect.arrayContaining(['LT-25-60', 'LT-30-65', 'INT-30-65', 'ACC-40-75', 'LT-5', 'ACC-25-60', 'LT-M20']));
    const code = uniq('PHOTO');
    const c = ok(await post('/stability/conditions', { code, name: 'Photostability cabinet', category: 'Stress', temperatureC: 25, temperatureToleranceC: 2 }, 'reviewer'));
    expect(c).toMatchObject({ status: 'Active', origin: 'entry', humidityRh: null });
    expect((await post('/stability/conditions', { code: code.toLowerCase(), name: 'x', category: 'Stress', temperatureC: 25, temperatureToleranceC: 2 }, 'reviewer')).status).toBe(409);
    expect((await post('/stability/conditions', { code: uniq('X'), name: 'x', category: 'Stress', temperatureC: 25, temperatureToleranceC: 2, humidityRh: 60 }, 'reviewer')).status).toBe(400);
    expect((await post('/stability/conditions', { code: uniq('X'), name: 'x', category: 'Stress', temperatureC: 25, temperatureToleranceC: 2 }, 'analyst1')).status).toBe(403);
    expect((await put(`/stability/conditions/${c.id}`, { status: 'Inactive', expectedVersion: 1 }, 'reviewer')).status).toBe(400); // reason required
    ok(await put(`/stability/conditions/${c.id}`, { status: 'Inactive', reason: 'Cabinet decommissioned', expectedVersion: 1 }, 'reviewer'));
    expect(await one(`SELECT field, old_value, new_value, reason FROM audit_trail WHERE entity = 'StabilityCondition' AND entity_id = $1 AND action = 'Update'`, [c.id]))
      .toEqual({ field: 'status', old_value: 'Active', new_value: 'Inactive', reason: 'Cabinet decommissioned' });
    const ch = await post('/stability/chambers', { code: uniq('CH'), name: 'Cabinet', conditionId: c.id }, 'reviewer');
    expect(ch.status).toBe(409);
    expect(ch.body.code).toBe('CONDITION_INACTIVE');
  });
});
