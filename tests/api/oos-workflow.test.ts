/**
 * Roadmap M26 (r2-oos-workflow): the OOS investigation workflow (FDA guidance "Investigating OOS Test Results", 21 CFR 211.192).
 *
 *   Phase I      a due date from the settings (overdue once past it), checklist tasks from a template, an assignable cause recorded
 *                by the investigator and confirmed by QA with a signature (OOS_INVALIDATION): the original result is invalidated
 *   retests      only under a retest plan QA signed (OOS_RETEST_AUTHORISATION) with a justification and a maximum number of retests,
 *                after an invalidation or in Phase II; never by the analyst of the original result (configurable); never more
 *                than the plan allows
 *   closure      a decision (Confirmed OOS, Inconclusive, Invalidated) signed by QA who is not the investigator. Invalidated needs the
 *                confirmed assignable cause and a recorded retest; Confirmed OOS and Inconclusive need Phase II; a confirmed OOS opens
 *                a deviation (roadmap M27) in the closure's transaction
 *   vocabulary   a status, phase or decision outside the vocabulary blocks approval and release (fail closed)
 *
 * Needs the gate patch (docs/changes/r2-oos-workflow.gate.patch): the route module, the route table and the two permissions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const PW = 'password';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

/** An OOS result entered by analyst1 (the original analyst): the investigation opens by itself in Phase I. */
async function oosInvestigation() {
  const s = await registerSample(t);
  const sub = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: s.version });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const ent = await t.request.put(`/api/samples/${s.id}/results/${s.result.id}`).set(H.analyst1).send({ value: '90.0', reason: 'routine entry', expectedVersion: s.result.version });
  expect(ent.status, JSON.stringify(ent.body)).toBe(200);
  const id = ent.body.oosInvestigationId as string;
  expect(id).toMatch(/^OOS-/);
  return { sampleId: s.id, resultId: s.result.id, id };
}
const detail = async (id: string, who = 'qa') => {
  const res = await t.request.get(`/api/oos/${id}`).set(H[who]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
// The version is read BEFORE the request is built: a supertest request left idle across an await can lose its server (tests/helpers/app.ts).
const versionOf = async (id: string) => (await detail(id)).version as number;
const put = async (id: string, body: Record<string, unknown>, who = 'qa') => {
  const expectedVersion = await versionOf(id);
  return t.request.put(`/api/oos/${id}`).set(H[who]).send({ ...body, expectedVersion });
};
const close = async (id: string, decision: string, who = 'qa', extra: Record<string, unknown> = {}) => {
  const expectedVersion = await versionOf(id);
  return t.request.post(`/api/oos/${id}/close`).set(H[who])
    .send({ rootCause: 'Root cause as investigated', conclusion: 'Conclusion of the investigation', decision, password: PW, expectedVersion, ...extra });
};
const recordCause = async (id: string, who = 'analyst2') => {
  const expectedVersion = await versionOf(id);
  return t.request.put(`/api/oos/${id}/assignable-cause`).set(H[who])
    .send({ category: 'SAMPLE_PREPARATION_ERROR', description: 'Wrong dilution: 10 mL flask used instead of 25 mL (worksheet p.4).', expectedVersion });
};
const confirmCause = async (id: string, who = 'qa', password = PW) => {
  const expectedVersion = await versionOf(id);
  return t.request.post(`/api/oos/${id}/assignable-cause/confirm`).set(H[who])
    .send({ password, reason: 'Phase I evidence reviewed: laboratory error confirmed', expectedVersion });
};
const plan = async (id: string, maxRetests = 2, who = 'qa') => {
  const expectedVersion = await versionOf(id);
  return t.request.post(`/api/oos/${id}/retest-plan`).set(H[who])
    .send({ justification: 'Retest of the same sample solution by a second analyst', maxRetests, password: PW, expectedVersion });
};
const retest = (id: string, who: string, value = '99.5') =>
  t.request.post(`/api/oos/${id}/retests`).set(H[who]).send({ value, reason: 'Retest under the approved plan' });
const assign = (id: string, userId: string) => put(id, { assignedTo: userId });

describe('Phase I due date and overdue', () => {
  it('a new investigation is due after the Phase I period of the settings and is not overdue', async () => {
    const { id } = await oosInvestigation();
    const d = await detail(id);
    expect(d).toMatchObject({ phase: 'Phase I', dueDate: inDays(10), overdue: false });
  });

  it('a Phase I investigation past its due date appears as overdue: on the record, in the list and in GET /oos/overdue', async () => {
    const { id } = await oosInvestigation();
    await sql('UPDATE oos_investigations SET date_raised = $2 WHERE id = $1', [id, inDays(-30)]);
    expect(await detail(id)).toMatchObject({ overdue: true, dueDate: inDays(-20) });
    const list = await t.request.get('/api/oos').set(H.qa);
    expect(list.body.find((o: any) => o.id === id)).toMatchObject({ overdue: true });
    const overdue = await t.request.get('/api/oos/overdue').set(H.analyst1);
    expect(overdue.status, JSON.stringify(overdue.body)).toBe(200);
    expect(overdue.body.find((o: any) => o.id === id)).toMatchObject({ stage: 'Phase I', dueDate: inDays(-20), daysOverdue: 20 });
    // and on the dashboard (the gate patch's hunk in src/server/routes/dashboard.ts)
    const dash = await t.request.get('/api/dashboard').set(H.qa);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body.overdueOos).toBe(overdue.body.length);
    expect(dash.body.complianceOverview.pendingApprovals.items.find((i: any) => i.id === id)).toMatchObject({ urgency: 'Critical', title: expect.stringMatching(/overdue/i) });
  });

  it('moving to Phase II starts it, sets the Phase II due date, and the move is audited', async () => {
    const { id } = await oosInvestigation();
    const res = await put(id, { phase: 'Phase II' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = await detail(id);
    expect(d).toMatchObject({ phase: 'Phase II', dueDate: inDays(30), overdue: false });
    expect(d.phase2StartedAt).toBeTruthy();
    expect(await sql("SELECT field, new_value FROM audit_trail WHERE entity = 'OOS' AND entity_id = $1 AND field = 'due_date'", [id])).toEqual([{ field: 'due_date', new_value: inDays(30) }]);
  });
});

describe('checklist tasks', () => {
  it('a template is instantiated once as tasks; a task is completed with a finding, audited, then frozen; open tasks block the closure', async () => {
    const { id } = await oosInvestigation();
    const templates = await t.request.get('/api/oos/checklist-templates').set(H.analyst2);
    expect(templates.status).toBe(200);
    const phase1 = templates.body.find((x: any) => x.phase === 'Phase I' && x.active);
    expect(phase1.items.length).toBeGreaterThanOrEqual(5);

    const applied = await t.request.post(`/api/oos/${id}/tasks`).set(H.analyst2).send({ templateId: phase1.id });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toHaveLength(phase1.items.length);
    expect(applied.body[0]).toMatchObject({ phase: 'Phase I', status: 'Open', templateId: phase1.id });
    expect((await t.request.post(`/api/oos/${id}/tasks`).set(H.analyst2).send({ templateId: phase1.id })).status).toBe(409);

    const adhoc = await t.request.post(`/api/oos/${id}/tasks`).set(H.analyst2).send({ title: 'Interview the analyst', ownerId: 'usr-analyst2', dueDate: inDays(3) });
    expect(adhoc.status, JSON.stringify(adhoc.body)).toBe(200);
    const task = adhoc.body[0];

    const noFinding = await t.request.put(`/api/oos/${id}/tasks/${task.id}`).set(H.analyst2).send({ status: 'Done', expectedVersion: task.version });
    expect(noFinding.status).toBe(400);
    const done = await t.request.put(`/api/oos/${id}/tasks/${task.id}`).set(H.analyst2).send({ status: 'Done', finding: 'Analyst followed the method; no deviation recalled.', expectedVersion: task.version });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'Done', completedBy: 'usr-analyst2' });
    const frozen = await t.request.put(`/api/oos/${id}/tasks/${task.id}`).set(H.analyst2).send({ finding: 'Rewritten afterwards', expectedVersion: done.body.version });
    expect(frozen.status).toBe(423);
    const audits = await sql("SELECT field, new_value FROM audit_trail WHERE entity = 'OOSTask' AND entity_id = $1 ORDER BY sequence", [task.id]);
    expect(audits.map((a: any) => a.field)).toEqual(['all', 'status']);

    await put(id, { phase: 'Phase II' });
    const blocked = await close(id, 'Confirmed OOS');
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.code).toBe('TASKS_OPEN');
  });
});

describe('invalidation and retests (acceptance)', () => {
  it('closing as Invalidated without an assignable cause, without the QA signature on it, or without a linked retest is rejected', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-analyst2');
    const noCause = await close(id, 'Invalidated');
    expect(noCause.status, JSON.stringify(noCause.body)).toBe(409);
    expect(noCause.body.code).toBe('ASSIGNABLE_CAUSE_REQUIRED');

    expect((await recordCause(id)).status).toBe(200);
    const unconfirmed = await close(id, 'Invalidated');
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe('ASSIGNABLE_CAUSE_REQUIRED');
    // a refused closure costs the signer no attempt
    expect((await sql("SELECT failed_attempts FROM users WHERE id = 'usr-qa'"))[0].failed_attempts).toBe(0);

    expect((await confirmCause(id)).status).toBe(200);
    const noRetest = await close(id, 'Invalidated');
    expect(noRetest.status).toBe(409);
    expect(noRetest.body.code).toBe('RETEST_REQUIRED');
    expect((await sql('SELECT status FROM oos_investigations WHERE id = $1', [id]))[0].status).toBe('Open');
  });

  it('QA confirms the assignable cause with a signature that verifies; the investigator and a non-QA cannot; a wrong password is counted', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-analyst2');
    expect((await recordCause(id)).status).toBe(200);
    expect((await confirmCause(id, 'analyst2')).status).toBe(403);
    const wrong = await confirmCause(id, 'qa', 'wrong');
    expect(wrong.status).toBe(401);
    await sql("UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-qa'");

    const ok = await confirmCause(id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const d = await detail(id);
    expect(d).toMatchObject({ assignableCauseCategory: 'SAMPLE_PREPARATION_ERROR', invalidatedBy: 'usr-qa' });
    const [sig] = await sql("SELECT id, meaning_code, sample_id FROM signatures WHERE entity_type = 'OOSInvalidation' AND entity_id = $1", [id]);
    expect(sig.meaning_code).toBe('OOS_INVALIDATION');
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true });
    // the cause is frozen once confirmed
    expect((await recordCause(id)).status).toBe(409);
  });

  it('the investigator cannot confirm the cause they are assigned to (403 SOD_VIOLATION)', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-qa');
    expect((await recordCause(id, 'qa')).status).toBe(200);
    const res = await confirmCause(id, 'qa');
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
  });

  it('a retest needs a signed plan; the original analyst is refused; the third retest on a plan limited to two is refused', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-analyst2');
    expect((await retest(id, 'analyst2')).status).toBe(409); // no plan
    expect((await plan(id)).status).toBe(409);               // no confirmed cause and not in Phase II
    await recordCause(id);
    await confirmCause(id);
    expect((await plan(id, 99)).status).toBe(400);            // more than the settings allow
    const p = await plan(id, 2);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.plan).toMatchObject({ maxRetests: 2, basis: 'Assignable cause', approvedBy: 'usr-qa' });
    const [sig] = await sql("SELECT id, meaning_code FROM signatures WHERE entity_type = 'OOSRetestPlan' AND entity_id = $1", [p.body.plan.id]);
    expect(sig.meaning_code).toBe('OOS_RETEST_AUTHORISATION');
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true });
    expect((await plan(id, 1)).status).toBe(409);             // one plan per investigation

    const original = await retest(id, 'analyst1');
    expect(original.status, JSON.stringify(original.body)).toBe(403);
    expect(original.body.code).toBe('SOD_VIOLATION');
    expect((await retest(id, 'reviewer')).status).toBe(403); // results are entered by Analyst or Admin

    const first = await retest(id, 'analyst2', '99.5');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ seq: 1, value: '99.5', isOos: false, analystId: 'usr-analyst2', retestOf: (await detail(id)).resultId });
    expect((await retest(id, 'analyst2', 'garbage')).status).toBe(400);
    expect((await retest(id, 'analyst2', '97.0')).body).toMatchObject({ seq: 2, isOos: true });
    const third = await retest(id, 'admin', '99.9');
    expect(third.status, JSON.stringify(third.body)).toBe(409);
    expect(third.body.code).toBe('RETEST_LIMIT');
    expect((await detail(id)).retests).toHaveLength(2);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'OOSRetest' AND action = 'Create'")).not.toEqual([{ n: 0 }]);
  });

  it('an Invalidated closure is refused while any retest under the plan is OOS (no testing into compliance)', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-analyst2');
    await recordCause(id);
    await confirmCause(id);
    await plan(id, 2);
    expect((await retest(id, 'analyst2', '97.0')).body).toMatchObject({ seq: 1, isOos: true });
    expect((await retest(id, 'analyst2', '99.5')).body).toMatchObject({ seq: 2, isOos: false });
    const res = await close(id, 'Invalidated');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('RETEST_OOS');
    expect((await sql('SELECT status FROM oos_investigations WHERE id = $1', [id]))[0].status).toBe('Open');
  });

  it('an investigator who reassigns the investigation to someone else still may not confirm its cause, authorise its retests or close it', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-qa');
    await assign(id, 'usr-analyst2'); // QA hands the investigation over, then tries to sign its steps
    await recordCause(id);
    const confirm = await confirmCause(id, 'qa');
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(403);
    expect(confirm.body.code).toBe('SOD_VIOLATION');
    expect((await confirmCause(id, 'admin')).status).toBe(200);
    expect((await plan(id, 1, 'qa')).status).toBe(403);
    expect((await plan(id, 1, 'admin')).status).toBe(200);
    expect((await retest(id, 'analyst2')).status).toBe(200);
    const own = await close(id, 'Invalidated', 'qa');
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    expect((await close(id, 'Invalidated', 'admin')).status).toBe(200);
  });

  it('closing by the assignee is rejected; QA who is not the investigator closes as Invalidated', async () => {
    const { id } = await oosInvestigation();
    await assign(id, 'usr-analyst2');
    await recordCause(id);
    await confirmCause(id);
    await plan(id, 1);
    expect((await retest(id, 'analyst2')).status).toBe(200);
    await assign(id, 'usr-qa');
    const own = await close(id, 'Invalidated');
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    const ok = await close(id, 'Invalidated', 'admin');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await sql('SELECT status, decision FROM oos_investigations WHERE id = $1', [id])).toEqual([{ status: 'Closed', decision: 'Invalidated' }]);
  });
});

describe('Phase II decisions', () => {
  it('Confirmed OOS and Inconclusive need Phase II; a confirmed OOS opens a deviation linked to the investigation', async () => {
    const { id } = await oosInvestigation();
    const early = await close(id, 'Confirmed OOS');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('PHASE_II_REQUIRED');
    expect((await close(id, 'Inconclusive')).body.code).toBe('PHASE_II_REQUIRED');
    expect((await close(id, 'Whatever')).status).toBe(400);
    expect((await t.request.post(`/api/oos/${id}/close`).set(H.qa).send({ rootCause: 'abcdef', conclusion: 'abcdef', password: PW, expectedVersion: 1 })).status).toBe(400); // decision required

    await put(id, { phase: 'Phase II' });
    // in Phase II a retest plan may be authorised without an assignable cause (a protocol); invalidation is not possible
    expect((await recordCause(id, 'analyst2')).status).toBe(409);
    const ok = await close(id, 'Confirmed OOS');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.deviationId).toMatch(/^DEV-/);
    const [dev] = await sql("SELECT id, type, state, origin FROM qms_records WHERE source_type = 'OOS' AND source_id = $1", [id]);
    expect(dev).toMatchObject({ id: ok.body.deviationId, type: 'Deviation', state: 'QA Triage', origin: 'auto:oos-confirmed' });
    expect((await detail(id)).deviations).toEqual([expect.objectContaining({ id: dev.id, relation: 'source' })]);
  });

  it('a retest plan in Phase II is based on the protocol', async () => {
    const { id } = await oosInvestigation();
    await put(id, { phase: 'Phase II' });
    const p = await plan(id, 1);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.plan.basis).toBe('Phase II protocol');
  });
});

describe('vocabulary guard (release blockers and sample approval)', () => {
  it('a decision or status outside the vocabulary blocks approval and release, a legacy closure without a decision does not', async () => {
    const { RELEASE_BLOCKERS } = await import('../../src/server/release-blockers');
    const { TRANSITION_GUARDS } = await import('../../src/server/workflow/guards');
    const { db } = await import('../../src/db/index');
    const blocker = RELEASE_BLOCKERS.find(b => b.name === 'oos-vocabulary')!;
    const guard = TRANSITION_GUARDS.Approved.find(g => g.name === 'oos-vocabulary')!;
    expect(blocker).toBeTruthy();
    expect(guard).toBeTruthy();

    const s = await registerSample(t);
    const ins = (decision: string | null, status = 'Closed') => sql(
      `INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status, decision) VALUES ($1, $2, $3, 'Assay (%)', '2026-01-01', $4, $5) RETURNING id`,
      [uniq('OOS'), s.id, s.result.id, status, decision]).then(r => r[0].id as string);
    await ins(null);
    const sample = { id: s.id, state: 'Pending Review', batch: 'B', material: 'M' };
    expect(await blocker.check(db as any, 'B', [sample])).toEqual([]);
    expect(await guard.check(db as any, sample)).toBeNull();
    const bad = await ins('Passed on retest');
    expect((await blocker.check(db as any, 'B', [sample])).join(' ')).toContain(bad);
    expect(await guard.check(db as any, sample)).toContain('Passed on retest');
  });
});

describe('settings', () => {
  it('only the quality unit changes them, with a signature; the retest limit and the second-analyst rule follow them', async () => {
    const before = await t.request.get('/api/oos/settings').set(H.analyst1);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ retestAnalystMustDiffer: true, maxRetests: 2, phase1DueDays: 10, phase2DueDays: 30 });
    const body = { retestAnalystMustDiffer: false, maxRetests: 3, phase1DueDays: 10, phase2DueDays: 30, password: PW, reason: 'Approved SOP revision', expectedVersion: before.body.version };
    expect((await t.request.post('/api/oos/settings').set(H.analyst1).send(body)).status).toBe(403);
    const changed = await t.request.post('/api/oos/settings').set(H.qa).send(body);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await sql("SELECT meaning_code FROM signatures WHERE entity_type = 'OOSSettings'")).toEqual([{ meaning_code: 'OOS_SETTING_CHANGE' }]);

    const { id } = await oosInvestigation();
    await put(id, { phase: 'Phase II' });
    expect((await plan(id, 3)).status).toBe(200);
    expect((await retest(id, 'analyst1')).status).toBe(200); // the original analyst, now allowed by the setting

    const stale = await t.request.post('/api/oos/settings').set(H.qa).send(body);
    expect(stale.status).toBe(409);
  });
});
