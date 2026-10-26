/**
 * Roadmap M28 (r2-docs-training), training and qualification.
 *
 * Before: training was one boolean (users.has_completed_software_training); certifying ANY module flipped the global signing flag;
 * Overdue existed only in the seed; result entry checked no qualification.
 *
 * After (acceptance of M28 asserted here):
 *   - assignments are created when a version becomes Effective, and a scheduled job marks them Overdue;
 *   - a user with an overdue mandatory assignment gets 403 QUALIFICATION_REQUIRED on result entry for that method; a QA override is
 *     signed, time-limited and flagged on every use;
 *   - certifying a non-LIMS module no longer sets the global signing flag; the flag is derived from the LIMS curriculum only.
 * Plus: read-and-understood signed by the trainee only, on-the-job training signed by a trainer who is not the trainee.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq, receiveSample } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const PW = 'password';
const BLOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'training-blobs-'));
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
/** The scheduled job (training.overdue), run in-process; imported when first used, after the test database is in place. */
async function maintenance(): Promise<{ overdue: number; assigned: number; flagsChanged: number }> {
  const { runTrainingMaintenance } = await import('../../src/server/training/schedule');
  const { db } = await import('../../src/db/index');
  return runTrainingMaintenance(db);
}

beforeAll(async () => {
  process.env.BLOB_DIR = BLOBS;
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});
afterAll(() => { fs.rmSync(BLOBS, { recursive: true, force: true }); });

const post = (p: string, body: unknown, who: Who) => t.request.post(`/api${p}`).set(H[who]).send(body as object);
const put = (p: string, body: unknown, who: Who) => t.request.put(`/api${p}`).set(H[who]).send(body as object);
const get = (p: string, who: Who) => t.request.get(`/api${p}`).set(H[who]);
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body as T; };
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const SIGN = { password: PW, reason: 'Reviewed and approved for GMP use' };

const versionRow = (id: string) => one('SELECT * FROM document_versions WHERE id = $1', [id]);
async function step(versionId: string, what: string, who: Who) {
  const v = await versionRow(versionId);
  return post(`/document-versions/${versionId}/${what}`, { password: PW, expectedVersion: v.version }, who);
}
async function draftDocument(title = 'Assay of paracetamol by HPLC') {
  const res = ok(await post('/documents', { code: uniq('SOP-QC'), title, docType: 'SOP' }, 'reviewer'));
  return res as { document: { id: string }; version: { id: string } };
}
async function makeEffective(versionId: string) {
  const v = await versionRow(versionId);
  ok(await t.request.put(`/api/document-versions/${versionId}/file`).query({ fileName: 'sop.pdf', expectedVersion: v.version })
    .set(H.reviewer).set('Content-Type', 'application/octet-stream').send(Buffer.from(`%PDF-1.7\n% ${versionId}\n`)));
  ok(await step(versionId, 'submit', 'reviewer'));
  ok(await step(versionId, 'review', 'qa'));
  ok(await step(versionId, 'approve', 'admin'));
  return ok(await step(versionId, 'effective', 'qa'));
}
async function curriculum(body: Record<string, unknown>) {
  return ok(await post('/training/curricula', { code: uniq('CUR'), title: 'HPLC analyst curriculum', trainingMethod: 'READ_AND_UNDERSTOOD', dueDays: 14, ...body }, 'qa'));
}
const assignments = (curriculumId: string) =>
  sql(`SELECT id, user_id, status, due_date, document_version_id, origin, version FROM training_assignments WHERE curriculum_id = $1 ORDER BY user_id, created_at`, [curriculumId]);

// ---- a sample whose Appearance parameter is bound to an Effective method -------------------------------------------------------
async function effectiveMethod(over: Record<string, unknown> = {}) {
  const created = ok(await post('/methods', { code: uniq('M'), title: 'Appearance by visual inspection', ...over }, 'qa'));
  return ok(await post(`/methods/${created.id}/approve`, { ...SIGN, expectedVersion: created.version }, 'admin')).method as { id: string; code: string };
}
async function sampleBoundTo(methodCode: string) {
  const material = uniq('Paracetamol 500 mg');
  const draft = ok(await post('/specifications', { material, effectiveDate: day(0) }, 'qa'));
  const parameters = [{ name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White tablets', method_code: methodCode }];
  const edited = ok(await put(`/specifications/${draft.id}`, { parameters, expectedVersion: draft.version }, 'qa'));
  ok(await post(`/specifications/${draft.id}/approve`, { ...SIGN, expectedVersion: edited.version }, 'admin'));
  const s = ok(await post('/samples', { material, batch: uniq('B') }, 'analyst1'));
  await receiveSample(t, s.id);
  ok(await post(`/samples/${s.id}/transition`, { action: 'submit', expectedVersion: 1 }, 'analyst1'));
  const detail = ok(await get(`/samples/${s.id}`, 'analyst1'));
  return { id: s.id as string, result: detail.results[0] as { id: string; version: number } };
}
const enter = async (sample: { id: string; result: { id: string } }, who: Who) => {
  const r = await one('SELECT version FROM results WHERE id = $1', [sample.result.id]);
  return put(`/samples/${sample.id}/results/${sample.result.id}`, { value: 'Complies', reason: 'Visual inspection against standard', expectedVersion: r.version }, who);
};

describe('assignment on effectivity', () => {
  it('assigns the Effective version to every user of the curriculum roles, with the due date, audited; a new version replaces the open ones', async () => {
    const { document, version } = await draftDocument();
    const cur = await curriculum({ roles: ['Analyst'], documentIds: [document.id] });
    expect(await assignments(cur.id)).toEqual([]); // nothing is Effective yet

    await makeEffective(version.id);
    const rows = await assignments(cur.id);
    expect(rows.map(r => r.user_id)).toEqual(['usr-analyst1', 'usr-analyst2']);
    for (const r of rows) expect(r).toMatchObject({ status: 'Assigned', due_date: day(14), document_version_id: version.id, origin: 'auto:effective' });
    const audit = await one(`SELECT user_id, action FROM audit_trail WHERE entity = 'TrainingAssignment' AND entity_id = $1`, [rows[0].id]);
    expect(audit).toMatchObject({ user_id: 'usr-qa', action: 'Assign' });

    // Revision 2 becomes Effective: the open assignments of revision 1 are superseded, revision 2 is assigned.
    const v2 = ok(await post(`/documents/${document.id}/revise`, {}, 'reviewer'));
    await makeEffective(v2.id);
    const after = await assignments(cur.id);
    expect(after.filter(r => r.document_version_id === version.id).map(r => r.status)).toEqual(['Superseded', 'Superseded']);
    expect(after.filter(r => r.document_version_id === v2.id).map(r => r.status)).toEqual(['Assigned', 'Assigned']);
  });

  it('the curriculum input is strict and only the quality unit manages curricula', async () => {
    expect((await post('/training/curricula', { code: uniq('CUR'), title: 'x curriculum', trainingMethod: 'READ_AND_UNDERSTOOD', isSoftware: true }, 'qa')).status).toBe(400);
    expect((await post('/training/curricula', { code: uniq('CUR'), title: 'Analyst made', trainingMethod: 'READ_AND_UNDERSTOOD' }, 'analyst1')).status).toBe(403);
  });
});

describe('training records', () => {
  it('read and understood is signed by the trainee only, with the training meaning, bound to the assignment version', async () => {
    const { document, version } = await draftDocument('Use of the pH meter');
    const cur = await curriculum({ roles: ['Analyst'], documentIds: [document.id] });
    await makeEffective(version.id);
    const [a1, a2] = await assignments(cur.id);
    expect((await post(`/training/assignments/${a1.id}/acknowledge`, { password: PW, expectedVersion: a1.version }, 'analyst2')).status).toBe(403);
    const done = ok(await post(`/training/assignments/${a1.id}/acknowledge`, { password: PW, expectedVersion: a1.version }, 'analyst1'));
    expect(done.assignment).toMatchObject({ status: 'Completed', completedBy: 'usr-analyst1' });
    expect(done.signature).toMatchObject({ meaningCode: 'TRAINING_ACKNOWLEDGEMENT', signerId: 'usr-analyst1', entityType: 'TrainingAssignment', recordVersion: done.assignment.version });
    expect((await post(`/training/assignments/${a1.id}/acknowledge`, { password: PW, expectedVersion: done.assignment.version }, 'analyst1')).status).toBe(409);
    // On-the-job training is not read and understood.
    expect((await post(`/training/assignments/${a2.id}/certify`, { password: PW, expectedVersion: a2.version }, 'qa')).status).toBe(409);
  });

  it('on-the-job training is certified by a trainer who is not the trainee', async () => {
    const { document, version } = await draftDocument('HPLC column change');
    const cur = await curriculum({ roles: ['QA'], documentIds: [document.id], trainingMethod: 'OJT' });
    await makeEffective(version.id);
    const [a] = await assignments(cur.id);
    expect(a.user_id).toBe('usr-qa');
    const self = await post(`/training/assignments/${a.id}/certify`, { password: PW, expectedVersion: a.version }, 'qa');
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect((await post(`/training/assignments/${a.id}/acknowledge`, { password: PW, expectedVersion: a.version }, 'qa')).status).toBe(409);
    const done = ok(await post(`/training/assignments/${a.id}/certify`, { password: PW, expectedVersion: a.version }, 'admin'));
    expect(done.assignment).toMatchObject({ status: 'Completed', trainerId: 'usr-admin', completedBy: 'usr-admin' });
    expect(done.signature).toMatchObject({ meaningCode: 'TRAINING_CERTIFICATION', signerId: 'usr-admin' });
  });
});

describe('qualification at result entry (M28 acceptance 3)', () => {
  it('a user with an overdue mandatory assignment gets 403 QUALIFICATION_REQUIRED for that method; the scheduler marks Overdue', async () => {
    const method = await effectiveMethod();
    const { document, version } = await draftDocument();
    const cur = await curriculum({ roles: ['Analyst'], documentIds: [document.id], methodCode: method.code });
    await makeEffective(version.id);
    const [a1, a2] = await assignments(cur.id);

    // analyst2 has read it; analyst1's assignment falls due yesterday.
    ok(await post(`/training/assignments/${a2.id}/acknowledge`, { password: PW, expectedVersion: a2.version }, 'analyst2'));
    await sql(`UPDATE training_assignments SET due_date = $2 WHERE id = $1`, [a1.id, day(-1)]);

    // The guard reads the due date itself, before the scheduler has run.
    const s1 = await sampleBoundTo(method.code);
    const refused = await enter(s1, 'analyst1');
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('QUALIFICATION_REQUIRED');
    expect(refused.body.error).toMatch(method.code);
    expect((await one('SELECT value, version FROM results WHERE id = $1', [s1.result.id]))).toMatchObject({ value: null, version: 1 });

    // The scheduled job marks it Overdue, with an audit entry by the service principal.
    const run = await maintenance();
    expect(run.overdue).toBeGreaterThanOrEqual(1);
    expect((await one('SELECT status FROM training_assignments WHERE id = $1', [a1.id])).status).toBe('Overdue');
    expect(await one(`SELECT user_id, action FROM audit_trail WHERE entity = 'TrainingAssignment' AND entity_id = $1 AND action = 'Overdue'`, [a1.id]))
      .toMatchObject({ user_id: 'svc-scheduler' });
    expect((await enter(s1, 'analyst1')).status).toBe(403);

    // analyst2 is qualified; another method is not affected.
    const s2 = await sampleBoundTo(method.code);
    ok(await enter(s2, 'analyst2'));
    const other = await sampleBoundTo((await effectiveMethod()).code);
    ok(await enter(other, 'analyst1'));

    // Completing the training (late) lifts the block.
    const fresh = await one('SELECT version FROM training_assignments WHERE id = $1', [a1.id]);
    ok(await post(`/training/assignments/${a1.id}/acknowledge`, { password: PW, expectedVersion: fresh.version }, 'analyst1'));
    ok(await enter(s1, 'analyst1'));
  });

  it('a QA override is signed, time-limited, flagged on each use, and revocable', async () => {
    const method = await effectiveMethod();
    const cur = await curriculum({ roles: ['Analyst'], methodCode: method.code, trainingMethod: 'OJT' });
    // A manual assignment that is already overdue.
    ok(await post('/training/assignments', { userId: 'usr-analyst1', curriculumId: cur.id, dueDate: day(-2) }, 'qa'));
    const s = await sampleBoundTo(method.code);
    expect((await enter(s, 'analyst1')).status).toBe(403);

    const body = { userId: 'usr-analyst1', methodCode: method.code, validUntil: day(7), reason: 'Batch release deadline; OJT scheduled for Monday', password: PW };
    expect((await post('/training/qualifications/override', body, 'admin')).status).toBe(403); // only QA signs an override
    expect((await post('/training/qualifications/override', { ...body, validUntil: day(60) }, 'qa')).status).toBe(400); // at most 30 days
    const granted = ok(await post('/training/qualifications/override', body, 'qa'));
    expect(granted.signature).toMatchObject({ meaningCode: 'QUALIFICATION_OVERRIDE', signerId: 'usr-qa', entityType: 'AnalystQualification' });

    ok(await enter(s, 'analyst1'));
    const flag = await one(`SELECT user_id, action, new_value FROM audit_trail WHERE entity = 'Result' AND entity_id = $1 AND action = 'QualificationOverrideUsed'`, [s.result.id]);
    expect(flag).toMatchObject({ user_id: 'usr-analyst1', new_value: granted.qualification.id });
    const quals = ok(await get('/training/qualifications?userId=usr-analyst1', 'qa'));
    expect(quals.find((q: any) => q.methodCode === method.code)).toMatchObject({ status: 'Override', overrideId: granted.qualification.id });

    ok(await post(`/training/qualifications/${granted.qualification.id}/revoke`, { reason: 'OJT completed early; override no longer needed', expectedVersion: granted.qualification.version }, 'qa'));
    const s2 = await sampleBoundTo(method.code);
    expect((await enter(s2, 'analyst1')).status).toBe(403);
  });

  it('a method that names a curriculum as its required training module is gated by that curriculum', async () => {
    const cur = await curriculum({ roles: ['Analyst'], trainingMethod: 'OJT' });
    const method = await effectiveMethod({ requiredTrainingModule: cur.code });
    ok(await post('/training/assignments', { userId: 'usr-analyst2', curriculumId: cur.id, dueDate: day(-1) }, 'qa'));
    const s = await sampleBoundTo(method.code);
    expect((await enter(s, 'analyst2')).body.code).toBe('QUALIFICATION_REQUIRED');
    ok(await enter(s, 'analyst1'));
  });
});

describe('the software-trained flag (M28 acceptance 4)', () => {
  const flag = async (id: string) => (await one('SELECT has_completed_software_training AS f FROM users WHERE id = $1', [id])).f as boolean;

  it('certifying a non-LIMS module no longer sets the global signing flag; the LIMS curriculum does', async () => {
    await sql(`UPDATE users SET has_completed_software_training = false WHERE id = 'usr-analyst2'`);
    try {
      ok(await post('/training/usr-analyst2/certify', { password: PW, moduleName: 'GMP Basics' }, 'qa'));
      expect(await flag('usr-analyst2')).toBe(false);
      const sig = await one(`SELECT s.meaning_code, s.signer_id FROM signatures s JOIN training_records r ON r.id = s.entity_id
        WHERE s.entity_type = 'TrainingRecord' AND r.user_id = 'usr-analyst2' AND r.module_name = 'GMP Basics'`);
      expect(sig).toMatchObject({ meaning_code: 'TRAINING_CERTIFICATION', signer_id: 'usr-qa' });

      const lims = ok(await post('/training/usr-analyst2/certify', { password: PW, moduleName: 'LIMS Core Software' }, 'qa'));
      expect(lims.hasCompletedSoftwareTraining).toBe(true);
      expect(await flag('usr-analyst2')).toBe(true);
    } finally {
      await sql(`UPDATE users SET has_completed_software_training = true WHERE id = 'usr-analyst2'`);
    }
  });

  it('an overdue LIMS curriculum assignment clears the flag (signing blocked, training acknowledgement still allowed); completing it restores it', async () => {
    const lims = await one(`SELECT id, version FROM training_curricula WHERE is_software`);
    const { document, version } = await draftDocument('LIMS user guide');
    ok(await put(`/training/curricula/${lims.id}`, { documentIds: [document.id], trainingMethod: 'READ_AND_UNDERSTOOD', roles: ['Analyst'], expectedVersion: lims.version }, 'qa'));
    await makeEffective(version.id);
    const mine = await one(`SELECT id, version FROM training_assignments WHERE curriculum_id = $1 AND user_id = 'usr-analyst1' AND document_version_id = $2`, [lims.id, version.id]);
    expect(await flag('usr-analyst1')).toBe(true); // a new assignment does not revoke anything by itself

    await sql(`UPDATE training_assignments SET due_date = $2 WHERE id = $1`, [mine.id, day(-1)]);
    const run = await maintenance();
    expect(run.flagsChanged).toBeGreaterThanOrEqual(1);
    expect(await flag('usr-analyst1')).toBe(false);
    expect(await one(`SELECT user_id, action, field, new_value FROM audit_trail WHERE entity = 'User' AND entity_id = 'usr-analyst1' AND field = 'hasCompletedSoftwareTraining' ORDER BY sequence DESC LIMIT 1`))
      .toMatchObject({ user_id: 'svc-scheduler', new_value: 'false' });

    // Signing anything else is blocked; the training acknowledgement is the exempt one (the SignatureModal rule).
    const fresh = ok(await post('/documents', { code: uniq('SOP'), title: 'Analyst draft', docType: 'SOP' }, 'analyst1'));
    const fv = await versionRow(fresh.version.id);
    ok(await t.request.put(`/api/document-versions/${fresh.version.id}/file`).query({ fileName: 'sop.pdf', expectedVersion: fv.version })
      .set(H.analyst1).set('Content-Type', 'application/octet-stream').send(Buffer.from('%PDF-1.7\n% analyst\n')));
    const blocked = await step(fresh.version.id, 'submit', 'analyst1');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TRAINING_REQUIRED');

    const cur = await one('SELECT version FROM training_assignments WHERE id = $1', [mine.id]);
    ok(await post(`/training/assignments/${mine.id}/acknowledge`, { password: PW, expectedVersion: cur.version }, 'analyst1'));
    expect(await flag('usr-analyst1')).toBe(true);
    ok(await step(fresh.version.id, 'submit', 'analyst1'));
  });

  it('GET /training lists users without secrets, the curricula and the assignments', async () => {
    const body = ok(await get('/training', 'analyst1'));
    expect(body.users.length).toBeGreaterThan(0);
    for (const u of body.users) { expect(u).not.toHaveProperty('totpSecret'); expect(u).not.toHaveProperty('passwordHash'); }
    expect(body.curricula.some((c: any) => c.isSoftware)).toBe(true);
    expect(Array.isArray(body.assignments)).toBe(true);
    expect(body.assignments.every((a: any) => typeof a.overdue === 'boolean')).toBe(true);
  });
});
