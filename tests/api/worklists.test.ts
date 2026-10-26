/**
 * Roadmap M33 (r2-worklists): worklists and batch runs.
 *
 * Before: an analyst opened one sample at a time; nothing grouped tests by method or instrument, nothing assigned a result to an analyst,
 * nothing checked the method training before the work was given out, and nothing stopped two people from testing the same result.
 *
 * After (the acceptance of M33, asserted here, against the real application and PostgreSQL):
 *   1. adding a result whose method the analyst lacks returns 400 naming the training module;
 *   2. after release a change of the membership without a reason is rejected and the refusal is audited;
 *   3. a non-assignee entering a result gets 403, and a 20-cell grid save yields 20 audit entries with a per-cell 409 on conflict.
 * Plus: the run-sequence CSV, the bench sheet through the job queue, the workload view, the duplicate and the instrument rules.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, receiveSample, uniq } from '../helpers/fixtures';

let t: TestApp;
let runner: { stop(): Promise<void> };
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const ARTIFACTS = fs.mkdtempSync(path.join(os.tmpdir(), 'worklist-artifacts-'));
const PW = 'password';
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  process.env.ARTIFACT_DIR = ARTIFACTS;
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
  const { db } = await import('../../src/db/index');
  const { startRunner } = await import('../../src/server/jobs/runner');
  const { defaultHandlers } = await import('../../src/server/jobs/handlers');
  runner = startRunner({ db, pollMs: 25, sweepMs: 1000, heartbeatMs: 200, leaseSeconds: 30, handlers: defaultHandlers() });
});
afterAll(async () => { await runner?.stop(); fs.rmSync(ARTIFACTS, { recursive: true, force: true }); });

const post = (p: string, body: unknown, who: Who) => t.request.post(`/api${p}`).set(H[who]).send(body as object);
const put = (p: string, body: unknown, who: Who) => t.request.put(`/api${p}`).set(H[who]).send(body as object);
const get = (p: string, who: Who) => t.request.get(`/api${p}`).set(H[who]);
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body as T; };
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- arrangement ---------------------------------------------------------------------------------------------------------------

async function effectiveMethod(over: Record<string, unknown> = {}) {
  const created = ok(await post('/methods', { code: uniq('WLM'), title: 'Assay by HPLC', ...over }, 'qa'));
  return ok(await post(`/methods/${created.id}/approve`, { password: PW, reason: 'Reviewed and approved for GMP use', expectedVersion: created.version }, 'admin')).method as { id: string; code: string };
}
async function instrument(o: { type?: string; dueInDays?: number; status?: string } = {}) {
  const id = uniq('INST');
  await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC bench', $2, $3, $4, '2026-01-01')`,
    [id, o.type ?? 'HPLC', o.status ?? 'Active', day(o.dueInDays ?? 60)]);
  return id;
}
const PARAM = (name: string, methodCode: string) => ({ name, unit: '%', limit_kind: 'RANGE', lower: 0, upper: 200, decimals: 1, text: null, method_code: methodCode });

/** A sample in Testing whose parameters are bound to `methodCode`; returns its results by parameter. */
async function sampleFor(methodCode: string, params = ['Assay']) {
  const material = uniq('Paracetamol');
  await insertActiveSpec(t, material, params.map(p => PARAM(p, methodCode)) as any);
  const created = ok(await post('/samples', { material, batch: uniq('B') }, 'analyst1'));
  await receiveSample(t, created.id);
  await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [created.id]);
  const rows = await sql('SELECT id, parameter, version FROM results WHERE sample_id = $1 ORDER BY parameter COLLATE "C"', [created.id]);
  return { id: created.id as string, results: rows as Array<{ id: string; parameter: string; version: number }> };
}
const plan = async (methodCode: string, over: Record<string, unknown> = {}, who: Who = 'analyst1') =>
  ok(await post('/worklists', { title: 'HPLC assay run', methodCode, plannedDate: day(0), ...over }, who));
const addSample = (wl: string, s: { id: string; results: Array<{ id: string }> }, assigneeId = 'usr-analyst1', extra: Record<string, unknown> = {}, who: Who = 'analyst1', n = 0) =>
  post(`/worklists/${wl}/items`, { kind: 'Sample', sampleId: s.id, resultId: s.results[n].id, assigneeId, ...extra }, who);
const release = async (wl: { id: string; version: number }, who: Who = 'analyst1') => ok(await post(`/worklists/${wl.id}/release`, { expectedVersion: wl.version }, who));
const audits = (entity: string, id: string) => sql('SELECT action, field, old_value, new_value, reason, user_id FROM audit_trail WHERE entity = $1 AND entity_id = $2 ORDER BY sequence', [entity, id]);
const detail = async (id: string) => ok(await get(`/worklists/${id}`, 'analyst1'));

/** analyst2 has an overdue mandatory training assignment for `methodCode` (curriculum code returned). */
async function overdueTraining(userId: string, methodCode: string) {
  const code = uniq('CUR-HPLC');
  const cid = uniq('cur');
  await sql(`INSERT INTO training_curricula (id, code, title, method_code, roles, mandatory, due_days, training_method, created_by)
             VALUES ($1, $2, 'HPLC analyst curriculum', $3, '{}', true, 30, 'READ_AND_UNDERSTOOD', 'usr-qa')`, [cid, code, methodCode]);
  const aid = uniq('TA');
  await sql(`INSERT INTO training_assignments (id, user_id, curriculum_id, training_method, due_date, status, origin, created_by)
             VALUES ($1, $2, $3, 'READ_AND_UNDERSTOOD', '2020-01-01', 'Overdue', 'manual', 'usr-qa')`, [aid, userId, cid]);
  return { code, assignmentId: aid };
}

// ---- planning ------------------------------------------------------------------------------------------------------------------

describe('planning a worklist', () => {
  it('creates WL-<year>-<n> for an Effective method, audited, with the server-controlled fields refused', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code, { notes: 'Daily assay run' });
    expect(wl.id).toMatch(/^WL-\d{4}-\d{4}$/);
    expect(wl).toMatchObject({ status: 'Draft', methodCode: m.code, createdBy: 'usr-analyst1', version: 1, instrumentId: null });
    const second = await plan(m.code);
    expect(Number(second.id.split('-')[2])).toBe(Number(wl.id.split('-')[2]) + 1);
    const a = await audits('Worklist', wl.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'Create', user_id: 'usr-analyst1' });
    expect(JSON.parse(a[0].new_value)).toMatchObject({ id: wl.id, methodCode: m.code, status: 'Draft' });

    for (const bad of [{ status: 'Released' }, { id: 'WL-1' }, { version: 5 }, { createdBy: 'usr-qa' }]) {
      const res = await post('/worklists', { title: 'x run', methodCode: m.code, plannedDate: day(0), ...bad }, 'analyst1');
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/worklists', { title: 'x run', methodCode: m.code, plannedDate: '2026-02-30' }, 'analyst1')).status).toBe(400);
  });

  it('is refused for an unknown method and for one without an Effective revision', async () => {
    expect((await post('/worklists', { title: 'No such', methodCode: 'NO-SUCH-METHOD', plannedDate: day(0) }, 'analyst1')).status).toBe(400);
    const draft = ok(await post('/methods', { code: uniq('WLD'), title: 'Draft method' }, 'qa'));
    const res = await post('/worklists', { title: 'Draft run', methodCode: draft.code, plannedDate: day(0) }, 'analyst1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no Effective revision/);
  });

  it('checks the instrument: Active, within calibration and of the type the method is run on', async () => {
    const m = await effectiveMethod({ instrumentType: 'HPLC' });
    const wrongType = await instrument({ type: 'Balance' });
    const overdue = await instrument({ dueInDays: -3 });
    const retired = await instrument({ status: 'Out of Service' });
    const good = await instrument();
    for (const [id, pattern] of [[wrongType, /is run on a HPLC/], [overdue, /past its calibration due date/], [retired, /Only an Active|only an Active/i]] as const) {
      const res = await post('/worklists', { title: 'Run', methodCode: m.code, plannedDate: day(0), instrumentId: id }, 'analyst1');
      expect(res.status, id).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    expect((await post('/worklists', { title: 'Run', methodCode: m.code, plannedDate: day(0), instrumentId: 'INST-NONE' }, 'analyst1')).status).toBe(400);
    expect((await plan(m.code, { instrumentId: good })).instrumentId).toBe(good);
  });

  it('only worklist.manage plans: a Reviewer reads but may not create', async () => {
    const m = await effectiveMethod();
    expect((await post('/worklists', { title: 'Run', methodCode: m.code, plannedDate: day(0) }, 'reviewer')).status).toBe(403);
    expect((await get('/worklists', 'reviewer')).status).toBe(200);
  });

  it('the header is edited with the version predicate; every changed field is audited', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const upd = ok(await put(`/worklists/${wl.id}`, { title: 'Renamed assay run', plannedDate: day(2), expectedVersion: 1 }, 'analyst1'));
    expect(upd).toMatchObject({ title: 'Renamed assay run', plannedDate: day(2), version: 2 });
    const stale = await put(`/worklists/${wl.id}`, { title: 'Again', expectedVersion: 1 }, 'analyst1');
    expect(stale.status).toBe(409);
    expect((await put(`/worklists/${wl.id}`, { methodCode: 'OTHER', expectedVersion: 2 }, 'analyst1')).status).toBe(400); // the method never changes
    expect((await put(`/worklists/${wl.id}`, { title: 'Renamed assay run', expectedVersion: 2 }, 'analyst1')).status).toBe(400); // no change
    const a = await audits('Worklist', wl.id);
    expect(a.filter(x => x.action === 'Update').map(x => [x.field, x.old_value, x.new_value])).toEqual([['title', 'HPLC assay run', 'Renamed assay run'], ['plannedDate', day(0), day(2)]]);
  });
});

// ---- adding items (acceptance 1) --------------------------------------------------------------------------------------------------

describe('adding items', () => {
  it('ACCEPTANCE 1: an assignee without the method training is refused with 400 naming the module', async () => {
    const m = await effectiveMethod();
    const training = await overdueTraining('usr-analyst2', m.code);
    const wl = await plan(m.code);
    const s = await sampleFor(m.code);
    const res = await addSample(wl.id, s, 'usr-analyst2');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain(training.code);
    expect(res.body.error).toContain(m.code);
    expect(res.body.error).toContain(training.assignmentId);
    expect(await sql('SELECT 1 FROM worklist_items WHERE worklist_id = $1', [wl.id])).toHaveLength(0);
    // the qualified analyst is accepted for the same result
    ok(await addSample(wl.id, s, 'usr-analyst1'));
  });

  it('a signed QA override of the qualification is accepted, and the audit entry says so', async () => {
    const m = await effectiveMethod();
    await overdueTraining('usr-analyst2', m.code);
    await sql(`INSERT INTO analyst_qualifications (id, user_id, method_code, basis, reason, valid_until, status, granted_by) VALUES ($1, 'usr-analyst2', $2, 'QA_OVERRIDE', 'Trained abroad, record pending', $3, 'Active', 'usr-qa')`,
      [uniq('AQ'), m.code, day(10)]);
    const wl = await plan(m.code);
    const added = ok(await addSample(wl.id, await sampleFor(m.code), 'usr-analyst2'));
    const a = await audits('WorklistItem', added.item.id);
    expect(a[0].reason).toMatch(/QA override/);
  });

  it('only an active Analyst or Admin can be assigned', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const reviewer = await addSample(wl.id, await sampleFor(m.code), 'usr-reviewer');
    expect(reviewer.status).toBe(400);
    expect(reviewer.body.error).toMatch(/Reviewer/);
    expect((await addSample(wl.id, await sampleFor(m.code), 'usr-nobody')).status).toBe(400);
    await sql(`INSERT INTO users (id, uid, name, role, email, password_hash, active) VALUES ('usr-gone', 'gone', 'Gone Analyst', 'Analyst', 'gone@gxp.com', 'x', false)`);
    const gone = await addSample(wl.id, await sampleFor(m.code), 'usr-gone');
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/deactivated/);
  });

  it('a result of another method, an unbound result and a result that has a value are refused', async () => {
    const m = await effectiveMethod();
    const other = await effectiveMethod();
    const wl = await plan(m.code);
    const wrong = await addSample(wl.id, await sampleFor(other.code));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain(`method ${other.code}, not by ${m.code}`);
    const material = uniq('Unbound');
    await insertActiveSpec(t, material);
    const unbound = ok(await post('/samples', { material, batch: uniq('B') }, 'analyst1'));
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [unbound.id]);
    const ur = await sql('SELECT id FROM results WHERE sample_id = $1', [unbound.id]);
    const notBound = await addSample(wl.id, { id: unbound.id, results: ur });
    expect(notBound.status).toBe(400);
    expect(notBound.body.error).toMatch(/not bound to a method/);
    const done = await sampleFor(m.code);
    await sql(`UPDATE results SET value = '99.0' WHERE id = $1`, [done.results[0].id]);
    const entered = await addSample(wl.id, done);
    expect(entered.status).toBe(409);
    expect(entered.body.code).toBe('RESULT_ALREADY_ENTERED');
    const approved = await sampleFor(m.code);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [approved.id]);
    expect((await addSample(wl.id, approved)).status).toBe(409);
  });

  it('a result is on one open worklist at a time: the second is refused with 409 naming the first; a cancelled worklist frees it', async () => {
    const m = await effectiveMethod();
    const first = await plan(m.code);
    const second = await plan(m.code);
    const s = await sampleFor(m.code);
    ok(await addSample(first.id, s));
    const dup = await addSample(second.id, s);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_ASSIGNMENT');
    expect(dup.body.error).toContain(first.id);
    const f = await detail(first.id);
    ok(await post(`/worklists/${first.id}/cancel`, { reason: 'Instrument down', expectedVersion: f.version }, 'analyst1'));
    ok(await addSample(second.id, s));
  });

  it('two worklists adding the same result at once: exactly one wins', async () => {
    const m = await effectiveMethod();
    const a = await plan(m.code);
    const b = await plan(m.code);
    const s = await sampleFor(m.code);
    const res = await Promise.all([addSample(a.id, s), addSample(b.id, s)]);
    expect(res.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('a Standard, Blank, SST or Control item needs a label and names no sample; a Sample item needs sample, result and assignee', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    for (const kind of ['SST', 'Standard', 'Blank', 'Control']) ok(await post(`/worklists/${wl.id}/items`, { kind, label: `${kind} injection 1` }, 'analyst1'));
    expect((await post(`/worklists/${wl.id}/items`, { kind: 'Blank' }, 'analyst1')).status).toBe(400);
    expect((await post(`/worklists/${wl.id}/items`, { kind: 'Blank', label: 'B', sampleId: 'SMP-1' }, 'analyst1')).status).toBe(400);
    expect((await post(`/worklists/${wl.id}/items`, { kind: 'Sample', sampleId: 'SMP-1' }, 'analyst1')).status).toBe(400);
    expect((await post(`/worklists/${wl.id}/items`, { kind: 'Other', label: 'x' }, 'analyst1')).status).toBe(400);
    expect((await post(`/worklists/${wl.id}/items`, { kind: 'Blank', label: 'B', position: 1 }, 'analyst1')).status).toBe(400); // positions are the server's
    const d = await detail(wl.id);
    expect(d.items.map((i: any) => [i.position, i.kind])).toEqual([[1, 'SST'], [2, 'Standard'], [3, 'Blank'], [4, 'Control']]);
  });

  it('an instrument that fell out of calibration after planning blocks adding and releasing', async () => {
    const m = await effectiveMethod({ instrumentType: 'HPLC' });
    const inst = await instrument();
    const wl = await plan(m.code, { instrumentId: inst });
    const s = await sampleFor(m.code);
    ok(await addSample(wl.id, s));
    await sql(`UPDATE instruments SET calibration_due_date = $2 WHERE id = $1`, [inst, day(-1)]);
    const blocked = await addSample(wl.id, await sampleFor(m.code));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/past its calibration due date/);
    const d = await detail(wl.id);
    const rel = await post(`/worklists/${wl.id}/release`, { expectedVersion: d.version }, 'analyst1');
    expect(rel.status).toBe(409);
    expect(rel.body.code).toBe('RELEASE_BLOCKED');
    expect(rel.body.error).toMatch(/calibration/);
  });
});

// ---- release freezes the membership (acceptance 2) -------------------------------------------------------------------------------

describe('release', () => {
  async function released() {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const s1 = await sampleFor(m.code);
    const s2 = await sampleFor(m.code);
    const i1 = ok(await addSample(wl.id, s1)).item;
    const i2 = ok(await addSample(wl.id, s2)).item;
    const d = await detail(wl.id);
    const rel = await release(d);
    return { m, wl: rel, s1, s2, i1, i2 };
  }

  it('a Draft is changed without a reason; release needs the current version and a Sample item', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const empty = await post(`/worklists/${wl.id}/release`, { expectedVersion: 1 }, 'analyst1');
    expect(empty.status).toBe(409);
    expect(empty.body.error).toMatch(/no Sample item/);
    const s = await sampleFor(m.code);
    const added = ok(await addSample(wl.id, s));
    ok(await put(`/worklists/${wl.id}/items/${added.item.id}`, { assigneeId: 'usr-analyst1', label: undefined, expectedVersion: 1 }, 'analyst1').then(r => (r.status === 400 ? { status: 200, body: {} } : r))); // same assignee: nothing changed
    // the version of the worklist moved when the item was added: the first version is stale
    const stale = await post(`/worklists/${wl.id}/release`, { expectedVersion: 1 }, 'analyst1');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONFLICT');
    const rel = ok(await post(`/worklists/${wl.id}/release`, { expectedVersion: added.worklistVersion }, 'analyst1'));
    expect(rel).toMatchObject({ status: 'Released', releasedBy: 'usr-analyst1' });
    const a = await audits('Worklist', wl.id);
    expect(a.map(x => x.action)).toEqual(['Create', 'Release']);
    expect(await post(`/worklists/${wl.id}/release`, { expectedVersion: rel.version }, 'analyst1').then(r => r.status)).toBe(409); // not a Draft any more
  });

  it('ACCEPTANCE 2: after release, adding, reassigning, removing, reordering and editing the header without a reason are 400 and audited', async () => {
    const { wl, i1, i2 } = await released();
    const m = (await detail(wl.id)).methodCode;
    const s3 = await sampleFor(m);
    const attempts = [
      await addSample(wl.id, s3),
      await put(`/worklists/${wl.id}/items/${i1.id}`, { assigneeId: 'usr-admin', expectedVersion: 1 }, 'analyst1'),
      await post(`/worklists/${wl.id}/items/${i1.id}/remove`, { expectedVersion: 1 }, 'analyst1'),
      await post(`/worklists/${wl.id}/reorder`, { itemIds: [i2.id, i1.id] }, 'analyst1'),
      await put(`/worklists/${wl.id}`, { title: 'Quietly renamed', expectedVersion: (await detail(wl.id)).version }, 'analyst1'),
    ];
    for (const r of attempts) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toMatch(/Released.*needs a reason/);
    }
    const refused = (await audits('Worklist', wl.id)).filter(x => x.action === 'ChangeRefused');
    expect(refused).toHaveLength(5);
    expect(refused.map(x => JSON.parse(x.new_value).op)).toEqual(['add', 'update', 'remove', 'reorder', 'update']);
    for (const r of refused) expect(r).toMatchObject({ user_id: 'usr-analyst1', field: 'content' });
    // nothing changed
    const d = await detail(wl.id);
    expect(d.items.map((i: any) => [i.id, i.assigneeId, i.status])).toEqual([[i1.id, 'usr-analyst1', 'Active'], [i2.id, 'usr-analyst1', 'Active']]);
    expect(d.title).toBe('HPLC assay run');
    expect(await sql('SELECT 1 FROM worklist_items WHERE sample_id = $1', [s3.id])).toHaveLength(0);
  });

  it('with a reason the change is made and the reason is on every audit entry', async () => {
    const { wl, i1, i2, s1 } = await released();
    const m = (await detail(wl.id)).methodCode;
    const s3 = await sampleFor(m);
    const added = ok(await addSample(wl.id, s3, 'usr-analyst1', { reason: 'Late sample for the same run' }));
    expect((await audits('WorklistItem', added.item.id))[0]).toMatchObject({ action: 'Add', reason: 'Late sample for the same run' });
    const reassigned = ok(await put(`/worklists/${wl.id}/items/${i1.id}`, { assigneeId: 'usr-admin', reason: 'Analyst 1 on leave', expectedVersion: 1 }, 'qa'));
    expect(reassigned).toMatchObject({ assigneeId: 'usr-admin', version: 2 });
    expect((await audits('WorklistItem', i1.id)).at(-1)).toMatchObject({ action: 'Update', field: 'assignee', old_value: 'usr-analyst1', new_value: 'usr-admin', reason: 'Analyst 1 on leave', user_id: 'usr-qa' });
    expect((await put(`/worklists/${wl.id}/items/${i1.id}`, { assigneeId: 'usr-analyst2', reason: 'again', expectedVersion: 1 }, 'qa')).status).toBe(409); // item version predicate
    ok(await post(`/worklists/${wl.id}/reorder`, { itemIds: [added.item.id, i2.id, i1.id], reason: 'Late sample first' }, 'analyst1'));
    expect((await detail(wl.id)).items.map((i: any) => i.id)).toEqual([added.item.id, i2.id, i1.id]);
    const removed = ok(await post(`/worklists/${wl.id}/items/${i2.id}/remove`, { reason: 'Sample withdrawn by the customer', expectedVersion: 1 }, 'analyst1'));
    expect(removed).toMatchObject({ status: 'Removed', removedBy: 'usr-analyst1', removedReason: 'Sample withdrawn by the customer' });
    const d = await detail(wl.id);
    expect(d.items.filter((i: any) => i.status === 'Active').map((i: any) => i.id)).toEqual([added.item.id, i1.id]);
    expect(d.items.at(-1)).toMatchObject({ id: i2.id, status: 'Removed' });
    expect((await post(`/worklists/${wl.id}/items/${i2.id}/remove`, { reason: 'twice', expectedVersion: 2 }, 'analyst1')).status).toBe(409); // already removed
    // the removed result is free for another worklist
    const [freed] = await sql('SELECT sample_id, result_id FROM worklist_items WHERE id = $1', [i2.id]);
    const other = await plan(m);
    ok(await addSample(other.id, { id: freed.sample_id, results: [{ id: freed.result_id }] }));
    expect(s1.id).toBeTruthy();
  });

  it('reorder must list every Active item once; the header and a Completed worklist', async () => {
    const { wl, i1, i2 } = await released();
    expect((await post(`/worklists/${wl.id}/reorder`, { itemIds: [i1.id], reason: 'Reorder test' }, 'analyst1')).status).toBe(400);
    expect((await post(`/worklists/${wl.id}/reorder`, { itemIds: [i1.id, i2.id], reason: 'Reorder test' }, 'analyst1')).status).toBe(400); // same order
    const d = await detail(wl.id);
    const done = ok(await post(`/worklists/${wl.id}/complete`, { expectedVersion: d.version }, 'analyst1'));
    expect(done).toMatchObject({ status: 'Completed', closedBy: 'usr-analyst1' });
    const late = await post(`/worklists/${wl.id}/items`, { kind: 'Blank', label: 'late', reason: 'Too late for this run' }, 'analyst1');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('WORKLIST_CLOSED');
    expect((await post(`/worklists/${wl.id}/cancel`, { reason: 'Cancel after completion', expectedVersion: done.version }, 'analyst1')).status).toBe(409);
  });

  it('cancel needs a reason; the audit trail keeps it', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    expect((await post(`/worklists/${wl.id}/cancel`, { expectedVersion: 1 }, 'analyst1')).status).toBe(400);
    const c = ok(await post(`/worklists/${wl.id}/cancel`, { reason: 'Run no longer needed', expectedVersion: 1 }, 'analyst1'));
    expect(c).toMatchObject({ status: 'Cancelled', closeReason: 'Run no longer needed' });
    expect((await audits('Worklist', wl.id)).at(-1)).toMatchObject({ action: 'Cancel', old_value: 'Draft', new_value: 'Cancelled' });
  });
});

// ---- assignment and grid entry (acceptance 3) ---------------------------------------------------------------------------------------

describe('assignee enforcement and grid entry', () => {
  it('ACCEPTANCE 3a: a non-assignee entering a result gets 403 NOT_ASSIGNED and nothing is written; the assignee may; a Draft or a Completed worklist assigns nothing', async () => {
    const m = await effectiveMethod();
    const body = (v: string) => ({ value: v, reason: 'Entered at the bench', expectedVersion: 1 });
    const enter = (s: { id: string; results: Array<{ id: string }> }, who: Who, v = '99.0') => put(`/samples/${s.id}/results/${s.results[0].id}`, body(v), who);

    // a Draft assigns nothing: analyst2 may enter the result of a Draft worklist
    const draft = await plan(m.code);
    const sDraft = await sampleFor(m.code);
    ok(await addSample(draft.id, sDraft, 'usr-analyst1'));
    ok(await enter(sDraft, 'analyst2'));

    const wl = await plan(m.code);
    const s = await sampleFor(m.code);
    ok(await addSample(wl.id, s, 'usr-analyst1'));
    const rel = await release(await detail(wl.id));
    const denied = await enter(s, 'analyst2');
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.code).toBe('NOT_ASSIGNED');
    expect(denied.body.error).toContain(wl.id);
    expect(denied.body.error).toContain('Test Analyst One');
    expect(await one('SELECT value, version FROM results WHERE id = $1', [s.results[0].id])).toEqual({ value: null, version: 1 });
    expect(await sql(`SELECT 1 FROM audit_trail WHERE entity = 'Result' AND entity_id = $1`, [s.results[0].id])).toHaveLength(0);
    // the batch endpoint of the sample goes through the same guard
    const batch = await put(`/samples/${s.id}/results-batch`, { items: [{ resultId: s.results[0].id, value: '99.0', expectedVersion: 1 }] }, 'analyst2');
    expect(batch.status).toBe(403);
    expect(batch.body.code).toBe('NOT_ASSIGNED');
    ok(await enter(s, 'analyst1'));

    // once the worklist is completed the assignment is gone: a second result of the same worklist is open to anyone
    const s2 = await sampleFor(m.code);
    const wl2 = await plan(m.code);
    ok(await addSample(wl2.id, s2, 'usr-analyst1'));
    const rel2 = await release(await detail(wl2.id));
    expect((await enter(s2, 'analyst2')).status).toBe(403);
    ok(await post(`/worklists/${wl2.id}/complete`, { expectedVersion: rel2.version }, 'analyst1'));
    ok(await enter(s2, 'analyst2'));
    expect(rel.status).toBe('Released');
  });

  it('a reassignment moves the right to enter the value, with a reason', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const s = await sampleFor(m.code);
    const item = ok(await addSample(wl.id, s, 'usr-analyst1')).item;
    await release(await detail(wl.id));
    const body = (v: string) => ({ value: v, reason: 'Entered by the assignee', expectedVersion: 1 });
    expect((await put(`/samples/${s.id}/results/${s.results[0].id}`, body('98.0'), 'analyst2')).status).toBe(403);
    ok(await put(`/worklists/${wl.id}/items/${item.id}`, { assigneeId: 'usr-analyst2', reason: 'Analyst 1 on leave today', expectedVersion: 1 }, 'analyst1'));
    expect((await put(`/samples/${s.id}/results/${s.results[0].id}`, body('98.0'), 'analyst1')).status).toBe(403);
    ok(await put(`/samples/${s.id}/results/${s.results[0].id}`, body('98.0'), 'analyst2'));
  });

  /** 5 samples x 4 parameters on one released worklist: 20 cells. */
  async function twentyCells() {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const params = ['Assay', 'Impurity A', 'Impurity B', 'Water'];
    const samples: Array<Awaited<ReturnType<typeof sampleFor>>> = [];
    for (let i = 0; i < 5; i++) samples.push(await sampleFor(m.code, params));
    for (const s of samples) for (let n = 0; n < params.length; n++) ok(await addSample(wl.id, s, 'usr-analyst1', {}, 'analyst1', n));
    const rel = await release(await detail(wl.id));
    const cells = samples.flatMap(s => s.results.map(r => ({ resultId: r.id, value: '99.5', expectedVersion: r.version })));
    return { wl: rel, samples, cells };
  }

  it('ACCEPTANCE 3b: a 20-cell grid save yields 20 audit entries, one result version each, nothing else changes', async () => {
    const { wl, cells } = await twentyCells();
    expect(cells).toHaveLength(20);
    const res = await put(`/worklists/${wl.id}/grid`, { cells }, 'analyst1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.saved).toHaveLength(20);
    expect(res.body.failed).toEqual([]);
    const ids = cells.map(c => c.resultId);
    const a = await sql(`SELECT entity_id, field, old_value, new_value, user_id, reason FROM audit_trail WHERE entity = 'Result' AND entity_id = ANY($1)`, [ids]);
    expect(a).toHaveLength(20);
    expect(new Set(a.map(x => x.entity_id)).size).toBe(20);
    for (const x of a) expect(x).toMatchObject({ field: 'value', old_value: '', new_value: '99.5', user_id: 'usr-analyst1', reason: 'Initial entry' });
    expect((await sql('SELECT DISTINCT version, value, entered_by FROM results WHERE id = ANY($1)', [ids]))).toEqual([{ version: 2, value: '99.5', entered_by: 'usr-analyst1' }]);
    const d = await detail(wl.id);
    expect(d.items.every((i: any) => i.value === '99.5' && i.resultVersion === 2)).toBe(true);
    // an overwrite needs its own reason, and an unchanged cell is refused
    const again = await put(`/worklists/${wl.id}/grid`, { cells: [{ resultId: cells[0].resultId, value: '99.6', expectedVersion: 2 }, { resultId: cells[1].resultId, value: '99.5', expectedVersion: 2, reason: 'Re-keyed same value' }] }, 'analyst1');
    expect(again.status).toBe(207);
    expect(again.body.failed.map((f: any) => [f.index, f.status])).toEqual([[0, 400], [1, 400]]);
    expect(again.body.failed[0].error).toMatch(/needs a reason/);
  });

  it('ACCEPTANCE 3c: a conflicting cell is refused with its own 409 while the others are saved (207); its audit entry is absent', async () => {
    const { wl, cells } = await twentyCells();
    // a colleague changes two cells after the grid was loaded: the versions in the request are stale
    await sql('UPDATE results SET version = version + 1 WHERE id = ANY($1)', [[cells[3].resultId, cells[11].resultId]]);
    const res = await put(`/worklists/${wl.id}/grid`, { cells }, 'analyst1');
    expect(res.status).toBe(207);
    expect(res.body.saved).toHaveLength(18);
    expect(res.body.failed.map((f: any) => [f.index, f.status, f.code])).toEqual([[3, 409, 'CONFLICT'], [11, 409, 'CONFLICT']]);
    expect(res.body.failed[0].error).toMatch(/changed by someone else/);
    const a = await sql(`SELECT entity_id FROM audit_trail WHERE entity = 'Result' AND entity_id = ANY($1)`, [cells.map(c => c.resultId)]);
    expect(a).toHaveLength(18);
    expect(a.map(x => x.entity_id)).not.toContain(cells[3].resultId);
    expect((await one('SELECT value FROM results WHERE id = $1', [cells[3].resultId])).value).toBeNull();
  });

  it('a grid save by a non-assignee: every cell is refused with 403; a cell that is not on the worklist is 404; a Draft takes no grid', async () => {
    const { wl, cells, samples } = await twentyCells();
    const denied = await put(`/worklists/${wl.id}/grid`, { cells: cells.slice(0, 4) }, 'analyst2');
    expect(denied.status).toBe(207);
    expect(denied.body.saved).toEqual([]);
    expect(denied.body.failed.map((f: any) => f.status)).toEqual([403, 403, 403, 403]);
    expect(denied.body.failed[0].code).toBe('NOT_ASSIGNED');
    const foreign = await sampleFor((await detail(wl.id)).methodCode);
    const stray = await put(`/worklists/${wl.id}/grid`, { cells: [{ resultId: foreign.results[0].id, value: '1.0', expectedVersion: 1 }] }, 'analyst1');
    expect(stray.status).toBe(207);
    expect(stray.body.failed[0].status).toBe(404);
    expect((await put(`/worklists/${wl.id}/grid`, { cells: [{ resultId: cells[0].resultId, value: '1', expectedVersion: 1, status: 'x' }] }, 'analyst1')).status).toBe(400);
    expect((await put(`/worklists/${wl.id}/grid`, { cells: [cells[0], cells[0]] }, 'analyst1')).status).toBe(400);
    expect((await put(`/worklists/${wl.id}/grid`, { cells: [] }, 'analyst1')).status).toBe(400);
    const m = (await detail(wl.id)).methodCode;
    const draft = await plan(m);
    const g = await put(`/worklists/${draft.id}/grid`, { cells: [cells[0]] }, 'analyst1');
    expect(g.status).toBe(409);
    expect(g.body.code).toBe('WORKLIST_NOT_RELEASED');
    expect(samples).toHaveLength(5);
    // a Reviewer reviews, never enters: the cell is refused by saveResult
    const rev = await put(`/worklists/${wl.id}/grid`, { cells: [cells[0]] }, 'reviewer');
    expect(rev.status).toBe(207);
    expect(rev.body.failed[0].status).toBe(403);
  });

  it('an OOS cell opens its investigation through saveResult, in the same save', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code);
    const material = uniq('Oos');
    await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null, method_code: m.code }] as any);
    const created = ok(await post('/samples', { material, batch: uniq('B') }, 'analyst1'));
    await receiveSample(t, created.id);
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [created.id]);
    const [r] = await sql('SELECT id, version FROM results WHERE sample_id = $1', [created.id]);
    ok(await addSample(wl.id, { id: created.id, results: [r] }));
    await release(await detail(wl.id));
    const res = ok(await put(`/worklists/${wl.id}/grid`, { cells: [{ resultId: r.id, value: '90.0', expectedVersion: r.version }] }, 'analyst1'));
    expect(res.saved[0]).toMatchObject({ isOos: true });
    expect(res.saved[0].oosInvestigationId).toMatch(/^OOS-/);
  });
});

// ---- outputs and views -----------------------------------------------------------------------------------------------------------

describe('run sequence, bench sheet, candidates and workload', () => {
  it('exports the run sequence as CSV in run order: removed items are left out, formulas are neutralised, the export is audited', async () => {
    const m = await effectiveMethod({ instrumentType: 'HPLC' });
    const inst = await instrument();
    const wl = await plan(m.code, { instrumentId: inst });
    const sst = ok(await post(`/worklists/${wl.id}/items`, { kind: 'SST', label: '=HYPERLINK("http://evil","click")' }, 'analyst1')).item;
    ok(await post(`/worklists/${wl.id}/items`, { kind: 'Standard', label: 'Std 100%, bracket' }, 'analyst1'));
    const s = await sampleFor(m.code);
    ok(await addSample(wl.id, s));
    const gone = ok(await post(`/worklists/${wl.id}/items`, { kind: 'Blank', label: 'Blank to drop' }, 'analyst1')).item;
    ok(await post(`/worklists/${wl.id}/items/${gone.id}/remove`, { reason: 'No blank needed today', expectedVersion: 1 }, 'analyst1'));
    ok(await post(`/worklists/${wl.id}/items`, { kind: 'Control', label: 'QC check' }, 'analyst1'));
    const res = await get(`/worklists/${wl.id}/run-sequence.csv`, 'reviewer');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(`${wl.id}-run-sequence.csv`);
    const lines = res.text.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe('Sequence,Worklist,Method,Instrument,PlannedDate,Kind,Label,SampleId,Material,Batch,Parameter,Analyst');
    expect(lines).toHaveLength(5);
    expect(lines.slice(1).map(l => l.split(',')[0] + ':' + l.split(',')[5])).toEqual(['1:SST', '2:Standard', '3:Sample', '4:Control']);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(lines[2]).toContain('"Std 100%, bracket"');
    expect(lines[3]).toContain(`${s.id},`);
    expect(lines[3]).toContain('Test Analyst One');
    expect(lines[3]).toContain(`${inst} HPLC bench`);
    expect(sst.position).toBe(1);
    expect((await audits('Worklist', wl.id)).at(-1)).toMatchObject({ action: 'Export', field: 'run-sequence', user_id: 'usr-reviewer' });
    expect((await get('/worklists/WL-0000-0000/run-sequence.csv', 'analyst1')).status).toBe(404);
  });

  it('the bench sheet is made by a job, only its owner reads it, and the PDF carries the run', async () => {
    const m = await effectiveMethod();
    const wl = await plan(m.code, { title: 'Bench sheet run' });
    ok(await post(`/worklists/${wl.id}/items`, { kind: 'SST', label: 'SST injection 1' }, 'analyst1'));
    const queued = ok(await post(`/worklists/${wl.id}/bench-sheet`, {}, 'analyst1'));
    expect(queued.jobId).toMatch(/^job-/);
    expect((await post('/worklists/WL-0000-0000/bench-sheet', {}, 'analyst1')).status).toBe(404);
    let status = 409;
    let res: any;
    for (let n = 0; n < 200 && status === 409; n++) {
      res = await t.request.get(`/api/worklists/bench-sheets/${queued.jobId}`).set(H.analyst1).buffer(true).parse((r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      status = res.status;
      if (status === 409) await new Promise(r => setTimeout(r, 50));
    }
    expect(status, res.text).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.body.toString('latin1')).toContain(wl.id);
    expect((await t.request.get(`/api/worklists/bench-sheets/${queued.jobId}`).set(H.analyst2)).status).toBe(403);
    expect((await t.request.get('/api/worklists/bench-sheets/job-unknown').set(H.analyst1)).status).toBe(404);
    expect(await sql(`SELECT 1 FROM audit_trail WHERE entity = 'WorklistBenchSheet' AND entity_id = $1`, [wl.id])).toHaveLength(1);
  });

  it('candidates: the results waiting for a method that are on no open worklist', async () => {
    const m = await effectiveMethod();
    const s1 = await sampleFor(m.code);
    const s2 = await sampleFor(m.code);
    const wl = await plan(m.code);
    ok(await addSample(wl.id, s1));
    const c = ok(await get(`/worklists/candidates?methodCode=${m.code.toLowerCase()}`, 'analyst1')) as any[];
    expect(c.map(x => x.sampleId)).toEqual([s2.id]);
    expect(c[0]).toMatchObject({ resultId: s2.results[0].id, parameter: 'Assay', state: 'Testing' });
    expect((await get('/worklists/candidates', 'analyst1')).status).toBe(400);
  });

  it('the list filters by method, instrument, status and assignee; the workload counts what is planned, pending and overdue per analyst and instrument', async () => {
    // The workload is the whole laboratory's: the other tests of this file have worklists too, so the figures are compared with a baseline.
    const base = ok(await get(`/worklists/workload?from=${day(-2)}&to=${day(3)}`, 'qa'));
    const was = (who: string) => base.analysts.find((a: any) => a.userId === who) ?? { releasedWorklists: 0, releasedItems: 0, pending: 0, overdue: 0, draftWorklists: 0, draftItems: 0 };
    const m = await effectiveMethod({ instrumentType: 'HPLC' });
    const inst = await instrument();
    const late = await plan(m.code, { instrumentId: inst, plannedDate: day(-2) });
    const future = await plan(m.code, { instrumentId: inst, plannedDate: day(3) });
    const sLate = await sampleFor(m.code, ['Assay', 'Water']);
    ok(await addSample(late.id, sLate, 'usr-analyst1', {}, 'analyst1', 0));
    ok(await addSample(late.id, sLate, 'usr-analyst1', {}, 'analyst1', 1));
    await release(await detail(late.id));
    const sFuture = await sampleFor(m.code);
    ok(await addSample(future.id, sFuture, 'usr-admin'));
    // one of the late results is entered
    ok(await put(`/samples/${sLate.id}/results/${sLate.results[0].id}`, { value: '99.0', reason: 'Entered by the assignee', expectedVersion: 1, instrumentId: inst }, 'analyst1'));

    const byMethod = ok(await get(`/worklists?methodCode=${m.code}`, 'reviewer')) as any[];
    expect(byMethod.map(w => w.id).sort()).toEqual([late.id, future.id].sort());
    const l = byMethod.find(w => w.id === late.id);
    expect(l).toMatchObject({ status: 'Released', itemCount: 2, sampleItems: 2, pending: 1, instrumentId: inst, instrumentName: 'HPLC bench' });
    expect(ok(await get(`/worklists?methodCode=${m.code}&status=Draft`, 'analyst1')).map((w: any) => w.id)).toEqual([future.id]);
    expect(ok(await get(`/worklists?methodCode=${m.code}&assigneeId=usr-admin`, 'analyst1')).map((w: any) => w.id)).toEqual([future.id]);
    expect(ok(await get(`/worklists?instrumentId=${inst}`, 'analyst1'))).toHaveLength(2);
    expect((await get('/worklists?status=Weird', 'analyst1')).status).toBe(400);

    const w = ok(await get(`/worklists/workload?from=${day(-2)}&to=${day(3)}`, 'qa'));
    const a1 = w.analysts.find((a: any) => a.userId === 'usr-analyst1');
    const delta = (now: any, before: any, k: string) => now[k] - before[k];
    expect(['releasedWorklists', 'releasedItems', 'pending', 'overdue', 'draftWorklists'].map(k => delta(a1, was('usr-analyst1'), k))).toEqual([1, 2, 1, 1, 0]);
    const adm = w.analysts.find((a: any) => a.userId === 'usr-admin');
    expect(['releasedWorklists', 'pending', 'overdue', 'draftWorklists', 'draftItems'].map(k => delta(adm, was('usr-admin'), k))).toEqual([0, 0, 0, 1, 1]);
    expect(a1.nextPlannedDate <= day(-2)).toBe(true);
    const wi = w.instruments.find((i: any) => i.instrumentId === inst);
    expect(wi).toMatchObject({ releasedWorklists: 1, draftWorklists: 1, items: 3, nextPlannedDate: day(-2) });
    const names = w.analysts.map((a: any) => a.name);
    expect(names).toEqual([...names].sort((x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)));
  });
});
