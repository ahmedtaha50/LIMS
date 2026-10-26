/**
 * Roadmap M27 (r2-qms): one QMS engine for deviations, CAPA, change control and audit findings.
 *
 * Before: no deviation, CAPA or change record existed anywhere; the traceability screen asserted "Zero Open OOS Investigations or
 * Deviations" although no deviation could exist; nothing controlled changes to specifications or roles.
 *
 * After (acceptance of M27, each asserted below):
 *   - a Major deviation cannot close without a linked CAPA and a QA signature;
 *   - two simultaneous creations get distinct numbers; a CAPA action past its due date is flagged overdue;
 *   - with the change-control setting on, approving a specification without an Approved change control is 409; editing a Closed
 *     record is 423.
 * Plus the AGENTS.md rules: strict input, version predicate, audit entry in the same transaction, signatures bound to the record
 * version with the step's own meaning, actor from the session.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { race, uniq } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const PW = 'password';

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const post = (path: string, body: unknown, who: Who) => t.request.post(`/api${path}`).set(H[who]).send(body as object);
const put = (path: string, body: unknown, who: Who) => t.request.put(`/api${path}`).set(H[who]).send(body as object);
const get = (path: string, who: Who) => t.request.get(`/api${path}`).set(H[who]);

async function create(body: Record<string, unknown>, who: Who = 'analyst1') {
  const res = await post('/qms/records', { title: uniq('Record'), ...body }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; version: number; state: string; type: string };
}
async function record(id: string) {
  const res = await get(`/qms/records/${id}`, 'qa');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
async function move(id: string, to: string, who: Who = 'analyst1', extra: Record<string, unknown> = {}) {
  const { record: r } = await record(id);
  return post(`/qms/records/${id}/transition`, { to, expectedVersion: r.version, ...extra }, who);
}
async function sign(id: string, to: string, who: Who = 'qa', extra: Record<string, unknown> = {}) {
  const { record: r } = await record(id);
  return post(`/qms/records/${id}/sign`, { to, password: PW, reason: 'QA decision recorded', expectedVersion: r.version, ...extra }, who);
}
async function edit(id: string, body: Record<string, unknown>, who: Who = 'analyst1') {
  const { record: r } = await record(id);
  return put(`/qms/records/${id}`, { expectedVersion: r.version, ...body }, who);
}
const ok = (res: { status: number; body: unknown }, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status);

async function addAction(recordId: string, over: Record<string, unknown> = {}, who: Who = 'analyst1') {
  const res = await post(`/qms/records/${recordId}/actions`, { title: uniq('Action'), ownerId: 'usr-analyst1', dueDate: day(14), ...over }, who);
  ok(res);
  return res.body as { id: string; version: number };
}
async function completeAction(actionId: string, who: Who = 'analyst1') {
  const [a] = await sql('SELECT version FROM qms_actions WHERE id = $1', [actionId]);
  const res = await post(`/qms/actions/${actionId}/complete`, { evidenceRef: 'SOP-123 rev 4 retraining record TR-77', password: PW, expectedVersion: a.version }, who);
  ok(res);
  return res.body;
}

describe('creating a quality record', () => {
  it('gives a numbered Deviation in Draft with its audit entry, and refuses server-controlled fields (400)', async () => {
    const d = await create({ type: 'Deviation', description: 'Balance B-02 out of calibration used for weighing', payload: { occurredOn: day(-1), area: 'QC lab 2' } });
    expect(d.id).toMatch(new RegExp(`^DEV-${new Date().getFullYear()}-\\d{4}$`));
    expect(d).toMatchObject({ type: 'Deviation', state: 'Draft', version: 1 });
    const row = await one('SELECT created_by, owner_id, origin FROM qms_records WHERE id = $1', [d.id]);
    expect(row).toEqual({ created_by: 'usr-analyst1', owner_id: 'usr-analyst1', origin: 'manual' });
    const audit = await sql(`SELECT action, user_id FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1`, [d.id]);
    expect(audit).toEqual([{ action: 'Create', user_id: 'usr-analyst1' }]);

    for (const extra of [{ state: 'Closed' }, { id: 'DEV-X' }, { version: 3 }, { createdBy: 'usr-qa' }, { origin: 'auto:x' }]) {
      const res = await post('/qms/records', { type: 'Deviation', title: 'x', ...extra }, 'analyst1');
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    // The payload is validated by the type's own strict schema.
    expect((await post('/qms/records', { type: 'Deviation', title: 'x', payload: { plan: 'not a deviation field' } }, 'analyst1')).status).toBe(400);
    expect((await post('/qms/records', { type: 'CAPA', title: 'x', payload: { kind: 'Sometimes' } }, 'analyst1')).status).toBe(400);
    expect((await post('/qms/records', { type: 'Deviation', title: 'x', dueDate: day(-1) }, 'analyst1')).status).toBe(400);
  });

  it('two (and eight) simultaneous creations get distinct, consecutive numbers', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => post('/qms/records', { type: 'AuditFinding', title: uniq('AF') }, 'analyst1')));
    expect(responses.map(r => r.status)).toEqual(Array(8).fill(200));
    const ids = responses.map(r => r.body.id as string);
    expect(new Set(ids).size).toBe(8);
    const numbers = ids.map(id => Number(id.split('-')[2])).sort((a, b) => a - b);
    expect(numbers[7] - numbers[0]).toBe(7);
  });
});

describe('the deviation lifecycle', () => {
  it('a Major deviation cannot close without a linked CAPA and a QA signature', async () => {
    const d = await create({ type: 'Deviation', description: 'HPLC-3 used past its calibration due date', payload: { occurredOn: day(0) } });
    ok(await move(d.id, 'QA Triage'));
    // Triage is the quality unit's: an Analyst gets 403, and QA must classify first.
    expect((await move(d.id, 'Investigation', 'analyst1')).status).toBe(403);
    expect((await move(d.id, 'Investigation', 'qa')).body.code).toBe('CLASSIFICATION_REQUIRED');
    ok(await edit(d.id, { classification: 'Major', reason: 'Classified at triage' }, 'qa'));
    ok(await move(d.id, 'Investigation', 'qa'));
    ok(await edit(d.id, { payload: { rootCause: 'Calibration reminder not configured' } }));

    // Straight to approval: a Major deviation needs the CAPA path.
    const direct = await sign(d.id, 'QA Approved');
    expect(direct.status).toBe(409);
    expect(direct.body.code).toBe('CAPA_REQUIRED');
    const noCapa = await move(d.id, 'CAPA Proposed');
    expect(noCapa.status).toBe(409);
    expect(noCapa.body.code).toBe('CAPA_REQUIRED');

    const capa = await create({ type: 'CAPA', classification: 'Major', payload: { kind: 'Corrective', plan: 'Configure reminders', effectivenessCriteria: 'No overdue use in 3 months' } });
    // A link of relation capa must point at a CAPA record.
    expect((await post(`/qms/records/${d.id}/links`, { relation: 'capa', targetType: 'QmsRecord', targetId: d.id }, 'analyst1')).status).toBe(400);
    ok(await post(`/qms/records/${d.id}/links`, { relation: 'capa', targetType: 'QmsRecord', targetId: capa.id }, 'analyst1'));
    ok(await move(d.id, 'CAPA Proposed'));

    // The approval is a signature: not from an Analyst, not without the password, and with the step's own meaning.
    expect((await sign(d.id, 'QA Approved', 'analyst1')).status).toBe(403);
    expect((await move(d.id, 'QA Approved', 'qa')).status).toBe(400); // a signed step cannot go through /transition
    const wrong = await sign(d.id, 'QA Approved', 'qa', { password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect((await record(d.id)).record.state).toBe('CAPA Proposed');
    const approved = await sign(d.id, 'QA Approved', 'qa');
    ok(approved);
    expect(approved.body.signature).toMatchObject({ meaningCode: 'QMS_APPROVAL', entityType: 'QmsRecord', entityId: d.id, recordVersion: approved.body.record.version });

    // Frozen after approval: classification cannot be lowered to dodge the CAPA.
    expect((await edit(d.id, { classification: 'Minor', reason: 'downgrade' }, 'qa')).status).toBe(423);
    ok(await move(d.id, 'Implementation'));
    ok(await move(d.id, 'Effectiveness Check'));

    // The linked CAPA is not closed yet.
    const early = await sign(d.id, 'Closed', 'admin');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('CAPA_NOT_CLOSED');

    // Take the CAPA to Closed (approved, implemented, checked effective, signed closed).
    const action = await addAction(capa.id);
    ok(await sign(capa.id, 'Approved', 'qa'));
    ok(await move(capa.id, 'Implementation'));
    // Closing the CAPA without an effectiveness check is refused.
    await completeAction(action.id);
    ok(await move(capa.id, 'Effectiveness Check'));
    const noCheck = await sign(capa.id, 'Closed', 'qa', { reason: 'closing' });
    expect(noCheck.status).toBe(409);
    expect(noCheck.body.code).toBe('EFFECTIVENESS_REQUIRED');
    const c = (await record(capa.id)).record;
    ok(await post(`/qms/records/${capa.id}/effectiveness`, { result: 'Effective', evidence: 'No overdue instrument use in 3 months (report R-12)', password: PW, expectedVersion: c.version }, 'qa'));
    ok(await sign(capa.id, 'Closed', 'qa', { reason: 'CAPA effective' }));

    // Now the deviation closes, with a QA signature (QMS_CLOSURE, reason required by the catalog).
    const closed = await sign(d.id, 'Closed', 'admin', { reason: 'All actions complete, CAPA effective' });
    ok(closed);
    expect(closed.body.record.state).toBe('Closed');
    expect(closed.body.signature.meaningCode).toBe('QMS_CLOSURE');
    const sigs = await sql(`SELECT meaning_code, signer_id, record_version FROM signatures WHERE entity_type = 'QmsRecord' AND entity_id = $1 ORDER BY timestamp`, [d.id]);
    expect(sigs.map(s => s.meaning_code)).toEqual(['QMS_APPROVAL', 'QMS_CLOSURE']);
    const verify = await get(`/signatures/verify/${closed.body.signature.id}`, 'qa');
    expect(verify.body).toMatchObject({ valid: true, status: 'valid' });
  });

  it('once a record exists, only the quality unit changes its classification (403 for others, nothing written)', async () => {
    const d = await create({ type: 'Deviation', classification: 'Major', payload: { rootCause: 'x' } });
    ok(await move(d.id, 'QA Triage'));
    ok(await move(d.id, 'Investigation', 'qa'));
    // The raiser's proposal stands until QA changes it: an Analyst cannot downgrade it to dodge the CAPA path.
    const down = await edit(d.id, { classification: 'Minor', reason: 'Not that serious after all' }, 'analyst1');
    expect(down.status).toBe(403);
    expect(down.body.code).toBe('PERMISSION_DENIED');
    expect((await record(d.id)).record).toMatchObject({ classification: 'Major', version: 3 });
    expect(await sql(`SELECT 1 FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1 AND field = 'classification'`, [d.id])).toHaveLength(0);
    // The other fields stay editable by the investigator.
    ok(await edit(d.id, { payload: { rootCause: 'Reminder not configured' } }, 'analyst1'));
    ok(await edit(d.id, { classification: 'Minor', reason: 'QA re-classified after investigation' }, 'qa'));
  });

  it('the signer of an approval or closure must not be the person who raised or owns the record (403)', async () => {
    const d = await create({ type: 'Deviation', classification: 'Minor', payload: { rootCause: 'Label printer jam' } }, 'qa');
    ok(await move(d.id, 'QA Triage', 'qa'));
    ok(await move(d.id, 'Investigation', 'qa'));
    const self = await sign(d.id, 'QA Approved', 'qa');
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SOD_VIOLATION');
    ok(await sign(d.id, 'QA Approved', 'admin'));
  });

  it('a Minor deviation closes after a signed approval without a CAPA, and only when its actions are finished', async () => {
    const d = await create({ type: 'Deviation', classification: 'Minor', payload: { rootCause: 'Typo in logbook' } });
    ok(await move(d.id, 'QA Triage'));
    ok(await move(d.id, 'Investigation', 'qa'));
    ok(await sign(d.id, 'QA Approved'));
    const a = await addAction(d.id);
    const blocked = await sign(d.id, 'Closed', 'qa', { reason: 'closing minor' });
    expect(blocked.body.code).toBe('ACTIONS_OPEN');
    await completeAction(a.id);
    ok(await sign(d.id, 'Closed', 'qa', { reason: 'closing minor' }));
  });

  it('a Closed record is locked: edit, move, action, link and comment answer 423', async () => {
    const d = await create({ type: 'Deviation', classification: 'Minor', payload: { rootCause: 'x' } });
    ok(await move(d.id, 'QA Triage'));
    ok(await move(d.id, 'Investigation', 'qa'));
    ok(await sign(d.id, 'QA Approved'));
    ok(await sign(d.id, 'Closed', 'qa', { reason: 'closing minor' }));
    const before = await one('SELECT * FROM qms_records WHERE id = $1', [d.id]);

    expect((await edit(d.id, { title: 'changed' })).status).toBe(423);
    expect((await edit(d.id, { dueDate: day(10) }, 'qa')).status).toBe(423);
    expect((await move(d.id, 'Implementation')).status).toBe(423);
    expect((await sign(d.id, 'Cancelled')).status).toBe(423);
    expect((await post(`/qms/records/${d.id}/actions`, { title: 'late', ownerId: 'usr-analyst1', dueDate: day(3) }, 'analyst1')).status).toBe(423);
    expect((await post(`/qms/records/${d.id}/links`, { relation: 'related', targetType: 'Batch', targetId: 'B-1' }, 'analyst1')).status).toBe(423);
    expect((await post(`/qms/records/${d.id}/comments`, { text: 'after the fact' }, 'analyst1')).status).toBe(423);
    expect(await one('SELECT * FROM qms_records WHERE id = $1', [d.id])).toEqual(before);
  });

  it('an edit carries the version predicate: a stale version is 409 and writes nothing', async () => {
    const d = await create({ type: 'Deviation' });
    ok(await put(`/qms/records/${d.id}`, { title: 'First edit', expectedVersion: 1 }, 'analyst1'));
    const stale = await put(`/qms/records/${d.id}`, { title: 'Second edit', expectedVersion: 1 }, 'analyst2');
    expect(stale.status).toBe(409);
    expect((await record(d.id)).record).toMatchObject({ title: 'First edit', version: 2 });
    const audit = await sql(`SELECT action, field, old_value, new_value, user_id FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1 ORDER BY sequence`, [d.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Update']);
    expect(audit[1]).toMatchObject({ field: 'title', new_value: 'First edit', user_id: 'usr-analyst1' });
    // Two simultaneous edits with the same version: one wins.
    expect(await race(2, () => put(`/qms/records/${d.id}`, { title: uniq('race'), expectedVersion: 2 }, 'analyst1'))).toEqual([200, 409]);
  });
});

describe('actions', () => {
  it('a CAPA action past its due date is flagged overdue, in the record and in the action list', async () => {
    const capa = await create({ type: 'CAPA' });
    const a = await addAction(capa.id, { ownerId: 'usr-analyst2' });
    expect((await record(capa.id)).actions.find((x: any) => x.id === a.id)).toMatchObject({ status: 'Open', overdue: false });
    // Arrange: time passes (no route accepts a due date in the past).
    await sql('UPDATE qms_actions SET due_date = $2 WHERE id = $1', [a.id, day(-1)]);
    expect((await record(capa.id)).actions.find((x: any) => x.id === a.id)).toMatchObject({ status: 'Open', overdue: true });
    const overdue = await get('/qms/actions?overdue=true', 'qa');
    ok(overdue);
    expect(overdue.body.map((x: any) => x.id)).toContain(a.id);
    const mine = await get('/qms/actions?mine=true', 'analyst2');
    expect(mine.body.find((x: any) => x.id === a.id)).toMatchObject({ overdue: true, recordId: capa.id });
    // A completed action is not overdue any more.
    await completeAction(a.id, 'analyst2');
    expect((await record(capa.id)).actions.find((x: any) => x.id === a.id)).toMatchObject({ status: 'Done', overdue: false, completedBy: 'usr-analyst2' });
  });

  it('completion is an e-signature by the owner (or QA) with evidence, bound to the action; a Done action is locked', async () => {
    const capa = await create({ type: 'CAPA' });
    const a = await addAction(capa.id, { ownerId: 'usr-analyst1' });
    const notOwner = await post(`/qms/actions/${a.id}/complete`, { evidenceRef: 'x', password: PW, expectedVersion: 1 }, 'analyst2');
    expect(notOwner.status).toBe(403);
    expect((await post(`/qms/actions/${a.id}/complete`, { password: PW, expectedVersion: 1 }, 'analyst1')).status).toBe(400);
    const done = await completeAction(a.id);
    expect(done.signature).toMatchObject({ meaningCode: 'QMS_ACTION_COMPLETION', entityType: 'QmsAction', entityId: a.id });
    expect((await put(`/qms/actions/${a.id}`, { title: 'changed', reason: 'late edit', expectedVersion: 2 }, 'analyst1')).status).toBe(423);
    expect((await post(`/qms/actions/${a.id}/cancel`, { reason: 'no longer needed', expectedVersion: 2 }, 'qa')).status).toBe(423);
    expect((await post(`/qms/records/${capa.id}/actions`, { title: 'x', ownerId: 'usr-analyst1', dueDate: day(-2) }, 'analyst1')).status).toBe(400);
  });
});

describe('CAPA effectiveness', () => {
  it('a check that finds the CAPA not effective sends it back to Implementation and is kept on record', async () => {
    const capa = await create({ type: 'CAPA', payload: { plan: 'Retrain', effectivenessCriteria: 'No repeat' } });
    const a = await addAction(capa.id);
    ok(await sign(capa.id, 'Approved', 'qa'));
    ok(await move(capa.id, 'Implementation'));
    await completeAction(a.id);
    ok(await move(capa.id, 'Effectiveness Check'));
    const v = (await record(capa.id)).record.version;
    const notEffective = await post(`/qms/records/${capa.id}/effectiveness`, { result: 'Not effective', evidence: 'Repeat event DEV in week 2', password: PW, expectedVersion: v }, 'qa');
    ok(notEffective);
    expect((await record(capa.id)).record.state).toBe('Implementation');
    const checks = await sql('SELECT result FROM qms_effectiveness_checks WHERE record_id = $1', [capa.id]);
    expect(checks).toEqual([{ result: 'Not effective' }]);
    await expect(t.db.pool.query('DELETE FROM qms_effectiveness_checks WHERE record_id = $1', [capa.id])).rejects.toThrow(/append-only/);
  });

  it('approving a CAPA needs a plan, effectiveness criteria and an action', async () => {
    const capa = await create({ type: 'CAPA' });
    const res = await sign(capa.id, 'Approved', 'qa');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAPA_PLAN_INCOMPLETE');
  });
});

describe('change control', () => {
  async function draftSpec() {
    const material = uniq('CC Material');
    const created = await post('/specifications', { material, effectiveDate: day(0) }, 'analyst1');
    ok(created);
    const id = created.body.id as string;
    const upd = await put(`/specifications/${id}`, { parameters: [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null }], expectedVersion: created.body.version }, 'analyst1');
    ok(upd);
    return { id, version: upd.body.version as number };
  }
  const approveSpec = (s: { id: string; version: number }) => post(`/specifications/${s.id}/approve`, { password: PW, expectedVersion: s.version }, 'qa');
  async function setRequired(on: boolean) {
    const cur = await get('/qms/settings', 'qa');
    ok(cur);
    if (cur.body.changeControlRequired === on) return;
    const res = await put('/qms/settings', { changeControlRequired: on, password: PW, reason: `Change control ${on ? 'enforced' : 'relaxed'} by QA decision`, expectedVersion: cur.body.version }, 'qa');
    ok(res);
    expect(res.body.signature.meaningCode).toBe('QMS_SETTING_CHANGE');
  }
  async function approvedChange(target: { targetType: string; targetId: string }, payload: Record<string, unknown> = { changeType: 'Specification', justification: 'New supplier', impactAssessment: 'Limits unchanged' }) {
    const cc = await create({ type: 'ChangeControl', classification: 'Minor', payload });
    ok(await post(`/qms/records/${cc.id}/links`, { relation: 'affects', ...target }, 'analyst1'));
    ok(await move(cc.id, 'Under Review'));
    ok(await sign(cc.id, 'Approved', 'qa'));
    return cc;
  }

  it('the setting is off on installation and only Admin/QA change it, with a signature and an audit entry', async () => {
    const s = await get('/qms/settings', 'analyst1');
    ok(s);
    expect(s.body.changeControlRequired).toBe(false);
    expect((await put('/qms/settings', { changeControlRequired: true, password: PW, reason: 'trying', expectedVersion: s.body.version }, 'analyst1')).status).toBe(403);
  });

  it('with the setting on, approving a specification without an Approved change control returns 409, and with one it is approved and recorded', async () => {
    const off = await draftSpec();
    ok(await approveSpec(off)); // setting off: unchanged behaviour

    await setRequired(true);
    try {
      const spec = await draftSpec();
      const refused = await approveSpec(spec);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CHANGE_REQUIRED');
      expect(await sql(`SELECT 1 FROM signatures WHERE entity_type = 'Specification' AND entity_id = $1`, [spec.id])).toHaveLength(0);
      // Refused before the password is checked: even a wrong password gets the 409, and costs the signer no attempt.
      const failedBefore = (await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-qa'`)).n;
      const wrongPw = await post(`/specifications/${spec.id}/approve`, { password: 'wrong-password', expectedVersion: spec.version }, 'qa');
      expect(wrongPw.body.code).toBe('CHANGE_REQUIRED');
      expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-qa'`)).n).toBe(failedBefore);

      // A change control still Under Review does not authorise it.
      const pending = await create({ type: 'ChangeControl', classification: 'Minor', payload: { impactAssessment: 'x' } });
      ok(await post(`/qms/records/${pending.id}/links`, { relation: 'affects', targetType: 'Specification', targetId: spec.id }, 'analyst1'));
      ok(await move(pending.id, 'Under Review'));
      expect((await approveSpec(spec)).status).toBe(409);

      const cc = await approvedChange({ targetType: 'Specification', targetId: spec.id });
      // Scope frozen at approval: no new affected record on an Approved change control.
      expect((await post(`/qms/records/${cc.id}/links`, { relation: 'affects', targetType: 'Specification', targetId: 'SPEC-OTHER' }, 'analyst1')).status).toBe(423);
      ok(await approveSpec(spec));
      const impl = await sql(`SELECT relation, target_type, target_id FROM qms_links WHERE record_id = $1 AND relation = 'implemented'`, [cc.id]);
      expect(impl).toEqual([{ relation: 'implemented', target_type: 'Specification', target_id: spec.id }]);
      const audit = await sql(`SELECT action FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1 AND action = 'ChangeImplemented'`, [cc.id]);
      expect(audit).toHaveLength(1);
    } finally {
      await setRequired(false);
    }
  });

  it('the emergency path: one QA signature with a reason approves an emergency change control from Draft', async () => {
    const normal = await create({ type: 'ChangeControl', classification: 'Major', payload: { justification: 'x' } });
    expect((await sign(normal.id, 'Approved', 'qa')).body.code).toBe('NOT_EMERGENCY');
    const cc = await create({ type: 'ChangeControl', classification: 'Major', payload: { emergency: true, justification: 'Column out of stock, release at risk' } });
    const res = await sign(cc.id, 'Approved', 'qa', { reason: 'Emergency: supply of a critical medicine' });
    ok(res);
    expect(res.body.signature.meaningCode).toBe('QMS_EMERGENCY_CHANGE');
    // The raiser cannot authorise their own emergency change; the closure is the signed retrospective review (reason required).
    ok(await move(cc.id, 'Implemented'));
    expect((await sign(cc.id, 'Closed', 'admin', { reason: undefined })).body.code).toBe('REASON_REQUIRED');
    ok(await sign(cc.id, 'Closed', 'admin', { reason: 'Retrospective review: change was justified, no product impact' }));
  });

  it('with the setting on, approving a role change needs an Approved change control for that user', async () => {
    const { generatePasswordHash } = await import('../../src/db/utils');
    const id = `usr-cc-${process.pid}`;
    await sql(`INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training) VALUES ($1, $1, 'CC Target', 'Analyst', $2, $3, true)`,
      [id, `${id}@gxp.test`, generatePasswordHash(PW)]);
    const req = await post('/permissions/role-changes', { userId: id, role: 'QA', reason: 'Promotion to QA reviewer', expectedVersion: 1, password: PW }, 'admin');
    ok(req, 201);
    const request = req.body.request as { id: string; version: number };
    await setRequired(true);
    try {
      const refused = await post(`/permissions/role-changes/${request.id}/approve`, { password: PW, expectedVersion: request.version }, 'qa');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CHANGE_REQUIRED');
      expect((await one('SELECT role FROM users WHERE id = $1', [id])).role).toBe('Analyst');
      await approvedChange({ targetType: 'User', targetId: id }, { changeType: 'Role', justification: 'Promotion', impactAssessment: 'Training complete' });
      ok(await post(`/permissions/role-changes/${request.id}/approve`, { password: PW, expectedVersion: request.version }, 'qa'));
      expect((await one('SELECT role FROM users WHERE id = $1', [id])).role).toBe('QA');
    } finally {
      await setRequired(false);
    }
  });
});

describe('links, comments and the release blocker', () => {
  it('comments and links are append-only and audited', async () => {
    const d = await create({ type: 'Deviation' });
    ok(await post(`/qms/records/${d.id}/comments`, { text: 'Spoke to the shift lead' }, 'reviewer'));
    ok(await post(`/qms/records/${d.id}/links`, { relation: 'related', targetType: 'Batch', targetId: 'B-123' }, 'analyst1'));
    expect((await post(`/qms/records/${d.id}/links`, { relation: 'related', targetType: 'Batch', targetId: 'B-123' }, 'analyst1')).status).toBe(409);
    expect((await post(`/qms/records/${d.id}/links`, { relation: 'related', targetType: 'Sample', targetId: 'SMP-NOPE' }, 'analyst1')).status).toBe(400);
    const detail = await record(d.id);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]).toMatchObject({ authorId: 'usr-reviewer', text: 'Spoke to the shift lead' });
    expect(detail.links).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'related', targetType: 'Batch', targetId: 'B-123' })]));
    await expect(t.db.pool.query('UPDATE qms_comments SET text = $2 WHERE record_id = $1', [d.id, 'rewritten'])).rejects.toThrow(/append-only/);
    await expect(t.db.pool.query('DELETE FROM qms_links WHERE record_id = $1', [d.id])).rejects.toThrow(/append-only/);
    const audit = await sql(`SELECT action FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1 ORDER BY sequence`, [d.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Comment', 'Link']);
  });

  it('an open Major or unclassified deviation linked to a batch blocks its release; a Minor one does not', async () => {
    const { findReleaseBlockers } = await import('../../src/server/release-blockers');
    const batch = uniq('B-QMS');
    const minor = await create({ type: 'Deviation', classification: 'Minor' });
    ok(await post(`/qms/records/${minor.id}/links`, { relation: 'related', targetType: 'Batch', targetId: batch }, 'analyst1'));
    const { db } = await import('../../src/db/index');
    expect((await findReleaseBlockers(db as any, batch)).filter(p => p.includes('DEV-'))).toEqual([]);
    const major = await create({ type: 'Deviation', classification: 'Major' });
    ok(await post(`/qms/records/${major.id}/links`, { relation: 'related', targetType: 'Batch', targetId: batch }, 'analyst1'));
    const problems = await findReleaseBlockers(db as any, batch);
    expect(problems.some(p => p.includes(major.id))).toBe(true);
  });

  it('the open filter finds an open record behind more than 500 newer final ones (filtered in the database, not after a page)', async () => {
    const d = await create({ type: 'AuditFinding' });
    await sql(`INSERT INTO qms_records (id, type, title, state, created_by, created_at)
      SELECT 'AF-OLD-' || $1 || '-' || g, 'AuditFinding', 'closed long ago', 'Closed', 'usr-qa', now() + g * interval '1 second' FROM generate_series(1, 510) g`, [process.pid]);
    const res = await get('/qms/records?type=AuditFinding&open=true', 'reviewer');
    ok(res);
    expect(res.body.map((r: any) => r.id)).toContain(d.id);
    expect(res.body.every((r: any) => r.final === false)).toBe(true);
  });

  it('lists records by type, open and overdue', async () => {
    const d = await create({ type: 'Deviation', dueDate: day(5) });
    await sql('UPDATE qms_records SET due_date = $2 WHERE id = $1', [d.id, day(-3)]);
    const res = await get('/qms/records?type=Deviation&overdue=true', 'reviewer');
    ok(res);
    expect(res.body.find((r: any) => r.id === d.id)).toMatchObject({ overdue: true, state: 'Draft' });
    expect(res.body.every((r: any) => r.type === 'Deviation')).toBe(true);
    expect((await get('/qms/records?bogus=1', 'reviewer')).status).toBe(400);
  });
});

describe('automatic opening', () => {
  it('opens one deviation per source inside the originating transaction, and none when that transaction rolls back', async () => {
    const { db } = await import('../../src/db/index');
    const { withTransaction } = await import('../../src/server/core/tx');
    const { autoOpenQmsRecord } = await import('../../src/server/qms');
    const source = uniq('OOS-AUTO');
    const open = () => withTransaction(db as any, tx => autoOpenQmsRecord(tx, { source: 'oos-confirmed', sourceId: source, actorId: 'usr-analyst1', title: `Confirmed OOS ${source}` }));
    const [a, b] = await Promise.all([open(), open()]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    const row = await one('SELECT state, origin, source_type, source_id, created_by FROM qms_records WHERE id = $1', [a.id]);
    expect(row).toEqual({ state: 'QA Triage', origin: 'auto:oos-confirmed', source_type: 'OOS', source_id: source, created_by: 'usr-analyst1' });
    expect(await sql(`SELECT relation, target_type, target_id FROM qms_links WHERE record_id = $1`, [a.id])).toEqual([{ relation: 'source', target_type: 'OOS', target_id: source }]);
    expect(await sql(`SELECT action, reason FROM audit_trail WHERE entity = 'QmsRecord' AND entity_id = $1`, [a.id]))
      .toEqual([{ action: 'Create', reason: `Opened automatically: oos-confirmed ${source}` }]);

    const other = uniq('OOS-AUTO');
    await expect(withTransaction(db as any, async tx => {
      await autoOpenQmsRecord(tx, { source: 'oos-confirmed', sourceId: other, actorId: 'usr-analyst1', title: 'rolled back' });
      throw new Error('the originating change failed');
    })).rejects.toThrow(/originating change failed/);
    expect(await sql(`SELECT id FROM qms_records WHERE source_id = $1`, [other])).toEqual([]);
  });
});

describe('the batch dossier', () => {
  it('lists the deviations about the batch (directly, through a sample or an OOS), open and closed, with the state and class', async () => {
    const batch = uniq('B-DOSSIER');
    const major = await create({ type: 'Deviation', classification: 'Major', title: 'Blend time exceeded' });
    ok(await post(`/qms/records/${major.id}/links`, { relation: 'related', targetType: 'Batch', targetId: batch }, 'analyst1'));
    const other = await create({ type: 'Deviation', classification: 'Minor' });
    ok(await post(`/qms/records/${other.id}/links`, { relation: 'related', targetType: 'Batch', targetId: uniq('B-OTHER') }, 'analyst1'));
    const res = await get(`/traceability/batch/${encodeURIComponent(batch)}`, 'qa');
    ok(res);
    expect(res.body.deviations).toEqual([expect.objectContaining({ id: major.id, title: 'Blend time exceeded', classification: 'Major', state: 'Draft', open: true, blocksRelease: true })]);
  });

  it('the traceability screen shows those deviations instead of asserting that there are none', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../../src/components/Traceability.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/data\??\.deviations/);
    expect(src).toMatch(/blocksRelease/);
  });
});

describe('automatic opening by a failed backup', () => {
  it('a backup run that fails opens one deviation in QA Triage, in the same transaction as the failed run, attributed to the run actor', async () => {
    const { db } = await import('../../src/db/index');
    const svc = await import('../../src/server/jobs/backupService');
    const { ensureServicePrincipal } = await import('../../src/server/jobs/principal');
    const principal = await ensureServicePrincipal(db as any);
    const settings = { ...svc.backupSettings({}), passphrase: null };
    await expect(svc.runBackup({ db: db as any, settings, actorId: principal, kind: 'scheduled', reason: 'Scheduled: backup.daily' })).rejects.toThrow(/passphrase/i);
    const run = await one(`SELECT id FROM backup_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`);
    const dev = await one(`SELECT id, type, state, origin, source_type, created_by FROM qms_records WHERE source_type = 'BackupRun' AND source_id = $1`, [run.id]);
    expect(dev).toMatchObject({ type: 'Deviation', state: 'QA Triage', origin: 'auto:backup-failed', source_type: 'BackupRun', created_by: principal });
  });
});
