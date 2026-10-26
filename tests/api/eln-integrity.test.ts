/**
 * Roadmap M12 (r1-quality-fixes): ELN integrity.
 *
 * Before: any signed-in user could sign someone else's worksheet and the meaning came from the browser; PUT /eln/:id had no author
 * check; the audit entry kept 100 characters of the old and new content; any user could create a notebook template, without an audit
 * entry; a sample observation could be added to an Approved sample and its signature carried the hash 'N/A' and the audit link 'N/A'.
 *
 * After (each test below names the criterion): the author signs through signRecord with the catalog meaning AUTHORSHIP; only the
 * author edits, and only while the worksheet is a Draft; the audit entries carry the full old and new content; a template is created
 * by QA or Admin, with an audit entry; an observation is refused on a closed sample and is signed with a real hash and audit link.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2', { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const LONG_OLD = 'Initial observation line. '.repeat(40); // 1,040 characters: far beyond the 100 the audit used to keep
const LONG_NEW = 'Corrected observation line. '.repeat(45);

async function newWorksheet(who: keyof typeof H = 'analyst1', content = 'Weighed 10.00 g, titrated to the endpoint.') {
  const res = await t.request.post('/api/eln').set(H[who]).send({ title: uniq('Worksheet'), content });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id as string;
}

describe('signing a worksheet: only the author, with the meaning the server chooses', () => {
  it('another analyst signing someone else\'s worksheet gets 403; nothing is signed or locked; a wrong password is not counted', async () => {
    const id = await newWorksheet('analyst1');
    const res = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst2).send({ password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await one('SELECT status, locked, signed_by FROM lab_notebook WHERE id = $1', [id])).toEqual({ status: 'Draft', locked: false, signed_by: null });
    expect((await one(`SELECT count(*)::int AS n FROM signatures WHERE entity_id = $1`, [id])).n).toBe(0);

    // The refusal comes before the password is looked at: a stranger guessing passwords is refused, not counted against the account.
    const wrong = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst2).send({ password: 'not-the-password' });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(403);
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst2'`)).failed_attempts).toBe(0);
  });

  it('QA and Admin are not the author either: 403', async () => {
    const id = await newWorksheet('analyst1');
    for (const who of ['qa', 'admin', 'reviewer'] as const) {
      const res = await t.request.post(`/api/eln/${id}/sign`).set(H[who]).send({ password: TEST_PASSWORD });
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect((await one('SELECT status FROM lab_notebook WHERE id = $1', [id])).status).toBe('Draft');
  });

  it('the author signs: 200, a catalog meaning, a real hash, an audit link, and the record is locked', async () => {
    const id = await newWorksheet('analyst1');
    const res = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD, reason: 'Worksheet complete' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'LabNotebook' AND entity_id = $1`, [id]);
    expect(sig).toBeTruthy();
    expect(sig.meaning_code).toBe('AUTHORSHIP');
    expect(sig.meaning).toBe((await one(`SELECT text FROM signature_meanings WHERE code = 'AUTHORSHIP'`)).text);
    expect(sig.signer_id).toBe('usr-analyst1');
    expect(sig.signer_name).toBe('Test Analyst One');
    expect(sig.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.hash_version).toBe(2);
    expect(sig.record_version).toBeGreaterThan(1);

    const audit = await one('SELECT * FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(audit).toMatchObject({ action: 'SIGN_ELN_ENTRY', entity: 'LabNotebook', entity_id: id, user_id: 'usr-analyst1', field: 'status', old_value: 'Draft', new_value: 'Signed' });

    const row = await one('SELECT * FROM lab_notebook WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'Signed', locked: true, signed_by: 'usr-analyst1', signature_meaning: sig.meaning, content_hash: sig.content_hash });
    expect(row.version).toBe(sig.record_version);

    const verified = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(verified.body).toMatchObject({ valid: true, status: 'valid', contentHashMatches: true, chainIntact: true, entityType: 'LabNotebook', entityId: id });
  });

  it('a meaning (or any server-controlled field) in the request is refused with 400, not ignored', async () => {
    const id = await newWorksheet('analyst1');
    for (const extra of [{ meaning: 'Approval (Release Disposition)' }, { signedBy: 'usr-qa' }, { status: 'Signed' }, { meaningCode: 'APPROVAL' }]) {
      const res = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await one('SELECT status FROM lab_notebook WHERE id = $1', [id])).status).toBe('Draft');
  });

  it('a wrong password is 401, is counted and audited as SignatureFailed, and signs nothing', async () => {
    const id = await newWorksheet('analyst2');
    const res = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst2).send({ password: 'wrong-password' });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND entity = 'LabNotebook' AND entity_id = $1`, [id])).n).toBe(1);
    expect((await one(`SELECT status FROM lab_notebook WHERE id = $1`, [id])).status).toBe('Draft');
    expect((await one(`SELECT count(*)::int AS n FROM signatures WHERE entity_id = $1`, [id])).n).toBe(0);
    const ok = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst2).send({ password: TEST_PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('signing twice: the second attempt is refused (423) and writes no second signature', async () => {
    const id = await newWorksheet('analyst1');
    expect((await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD })).status).toBe(200);
    const again = await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD });
    expect(again.status).toBe(423);
    expect((await one(`SELECT count(*)::int AS n FROM signatures WHERE entity_id = $1`, [id])).n).toBe(1);
  });

  it('altering a signed worksheet in SQL makes the signature fail verification', async () => {
    const id = await newWorksheet('analyst1');
    await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD });
    const sig = await one(`SELECT id FROM signatures WHERE entity_id = $1`, [id]);
    await sql(`UPDATE lab_notebook SET content = 'Weighed 12.00 g.' WHERE id = $1`, [id]);
    const res = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(res.body).toMatchObject({ valid: false, status: 'record-modified', contentHashMatches: false });
  });
});

describe('editing a worksheet: the author, while it is a Draft, with the full change in the audit trail', () => {
  it('another user editing gets 403 and nothing changes (including Admin and QA)', async () => {
    const id = await newWorksheet('analyst1');
    for (const who of ['analyst2', 'qa', 'admin'] as const) {
      const res = await t.request.put(`/api/eln/${id}`).set(H[who]).send({ content: 'Someone else wrote this', expectedVersion: 1 });
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(await one('SELECT version, content FROM lab_notebook WHERE id = $1', [id])).toEqual({ version: 1, content: 'Weighed 10.00 g, titrated to the endpoint.' });
  });

  it('an ELN edit audit contains the full old and new content, not 100 characters', async () => {
    const id = await newWorksheet('analyst1', LONG_OLD);
    const res = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: LONG_NEW, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.version).toBe(2);
    const entries = await sql(`SELECT field, old_value, new_value, user_id, reason FROM audit_trail WHERE entity = 'LabNotebook' AND entity_id = $1 AND action = 'Update'`, [id]);
    expect(entries).toHaveLength(1);
    expect(entries[0].field).toBe('content');
    expect(entries[0].old_value).toBe(LONG_OLD.trim());
    expect(entries[0].new_value).toBe(LONG_NEW.trim());
    expect(entries[0].user_id).toBe('usr-analyst1');
    expect(entries[0].reason.length).toBeGreaterThan(4);
  });

  it('every changed field is audited with its own old and new value; unchanged fields write nothing', async () => {
    const id = await newWorksheet('analyst1');
    const res = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ title: 'Renamed worksheet', experimentType: 'Dissolution Testing', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = await sql(`SELECT field, old_value, new_value FROM audit_trail WHERE entity = 'LabNotebook' AND entity_id = $1 AND action = 'Update' ORDER BY field`, [id]);
    expect(entries.map(e => e.field)).toEqual(['experimentType', 'title']);
    expect(entries.find(e => e.field === 'title')!.new_value).toBe('Renamed worksheet');
  });

  it('an edit needs expectedVersion (400) and a stale one is a 409 that writes nothing', async () => {
    const id = await newWorksheet('analyst1');
    expect((await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'x' })).status).toBe(400);
    expect((await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'first', expectedVersion: 1 })).status).toBe(200);
    const stale = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'second', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await one('SELECT content, version FROM lab_notebook WHERE id = $1', [id]))).toEqual({ content: 'first', version: 2 });
  });

  it('a signed worksheet cannot be edited by anyone, the author included (423)', async () => {
    const id = await newWorksheet('analyst1');
    expect((await t.request.post(`/api/eln/${id}/sign`).set(H.analyst1).send({ password: TEST_PASSWORD })).status).toBe(200);
    const version = (await one('SELECT version FROM lab_notebook WHERE id = $1', [id])).version;
    const res = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ content: 'After the fact', expectedVersion: version });
    expect(res.status).toBe(423);
  });

  it('a worksheet cannot be linked to a sample that does not exist (400, not a database error)', async () => {
    const res = await t.request.post('/api/eln').set(H.analyst1).send({ title: 'T', content: 'C', sampleId: 'SMP-9999-99999' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/violates|foreign key|Failed query/i);
    const id = await newWorksheet('analyst1');
    const edit = await t.request.put(`/api/eln/${id}`).set(H.analyst1).send({ sampleId: 'SMP-9999-99999', expectedVersion: 1 });
    expect(edit.status, JSON.stringify(edit.body)).toBe(400);
  });

  it('the creation is audited with the whole record, and non-string fields are 400', async () => {
    const id = await newWorksheet('analyst1', 'A worksheet body that is longer than one hundred characters so that a truncated audit value would be visibly different from the stored content.');
    const entry = await one(`SELECT new_value FROM audit_trail WHERE entity = 'LabNotebook' AND entity_id = $1 AND action = 'Create'`, [id]);
    expect(JSON.parse(entry.new_value).content).toContain('truncated audit value would be visibly different');
    expect((await t.request.post('/api/eln').set(H.analyst1).send({ title: { a: 1 }, content: 'C' })).status).toBe(400);
    expect((await t.request.post('/api/eln').set(H.analyst1).send({ title: 'T', content: ['C'] })).status).toBe(400);
  });
});

describe('notebook templates: a role, a strict schema, an audit entry', () => {
  it('an Analyst or a Reviewer cannot create a template (403) and no row is written', async () => {
    const title = uniq('Template');
    for (const who of ['analyst1', 'reviewer'] as const) {
      const res = await t.request.post('/api/notebook-templates').set(H[who]).send({ title, content: 'Step 1' });
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect((await one('SELECT count(*)::int AS n FROM notebook_templates WHERE title = $1', [title])).n).toBe(0);
  });

  it('QA creates a template: the author is the token\'s user, the id is random, and the creation is in the audit trail', async () => {
    const title = uniq('Template');
    const res = await t.request.post('/api/notebook-templates').set(H.qa).send({ title, content: 'Step 1\nStep 2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ title, content: 'Step 1\nStep 2', createdBy: 'usr-qa' });
    expect(res.body.id).toMatch(/^TPL-[0-9A-F]{8,}$/);
    const audit = await one(`SELECT * FROM audit_trail WHERE entity = 'NotebookTemplate' AND entity_id = $1`, [res.body.id]);
    expect(audit).toMatchObject({ action: 'Create', user_id: 'usr-qa' });
    expect(JSON.parse(audit.new_value)).toMatchObject({ title, content: 'Step 1\nStep 2' });
    expect((await t.request.get('/api/notebook-templates').set(H.analyst1)).body.some((x: any) => x.id === res.body.id)).toBe(true);
  });

  it('Admin may create one; the schema is strict (types, lengths, unknown keys)', async () => {
    expect((await t.request.post('/api/notebook-templates').set(H.admin).send({ title: uniq('T'), content: 'c' })).status).toBe(200);
    expect((await t.request.post('/api/notebook-templates').set(H.qa).send({ title: 42, content: 'c' })).status).toBe(400);
    expect((await t.request.post('/api/notebook-templates').set(H.qa).send({ title: 't', content: { a: 1 } })).status).toBe(400);
    expect((await t.request.post('/api/notebook-templates').set(H.qa).send({ title: '   ', content: 'c' })).status).toBe(400);
    expect((await t.request.post('/api/notebook-templates').set(H.qa).send({ title: 't', content: 'c', createdBy: 'usr-admin' })).status).toBe(400);
    expect((await t.request.post('/api/notebook-templates').set(H.qa).send({ title: 'x'.repeat(301), content: 'c' })).status).toBe(400);
  });
});

describe('observations on a sample (POST /samples/:id/notebook)', () => {
  const observe = (id: string, over: Record<string, unknown> = {}, who: keyof typeof H = 'analyst1') =>
    t.request.post(`/api/samples/${id}/notebook`).set(H[who]).send({ content: 'Clear, colourless solution; no particles.', password: TEST_PASSWORD, ...over });

  it('a notebook POST on an Approved sample returns 409, writes no entry and no signature', async () => {
    const s = await registerSample(t);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [s.id]);
    const res = await observe(s.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await one('SELECT count(*)::int AS n FROM lab_notebook WHERE sample_id = $1', [s.id])).n).toBe(0);
    expect((await one('SELECT count(*)::int AS n FROM signatures WHERE sample_id = $1', [s.id])).n).toBe(0);
  });

  it('a Rejected sample is closed as well (409)', async () => {
    const s = await registerSample(t);
    await sql(`UPDATE samples SET state = 'Rejected' WHERE id = $1`, [s.id]);
    expect((await observe(s.id)).status).toBe(409);
  });

  it('the refusal comes before the password: a closed sample does not count a wrong password', async () => {
    const s = await registerSample(t);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [s.id]);
    expect((await observe(s.id, { password: 'wrong-password' }, 'analyst2')).status).toBe(409);
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst2'`)).failed_attempts).toBe(0);
  });

  it('on an open sample: 200, the signature row has a real hash and a real audit link, and it verifies', async () => {
    const s = await registerSample(t);
    const res = await observe(s.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sampleId: s.id, enteredBy: 'usr-analyst1', status: 'Signed', locked: true });

    const sig = await one(`SELECT * FROM signatures WHERE entity_type = 'LabNotebook' AND entity_id = $1`, [res.body.id]);
    expect(sig.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.content_hash).not.toBe('N/A');
    expect(sig.audit_entry_id).not.toBe('N/A');
    expect(sig.sample_id).toBe(s.id);
    expect(sig.meaning_code).toBe('AUTHORSHIP');
    expect(sig.hash_version).toBe(2);
    const audit = await one('SELECT * FROM audit_trail WHERE id = $1', [sig.audit_entry_id]);
    expect(audit).toMatchObject({ entity: 'LabNotebook', entity_id: res.body.id, action: 'Create', user_id: 'usr-analyst1' });
    expect(audit.new_value).toBe('Clear, colourless solution; no particles.');
    expect((await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa)).body).toMatchObject({ valid: true, status: 'valid' });
    expect((await one('SELECT content_hash, locked FROM lab_notebook WHERE id = $1', [res.body.id]))).toEqual({ content_hash: sig.content_hash, locked: true });
  });

  it('a sample that does not exist is 404; a wrong password is 401 and audited; non-string content is 400', async () => {
    expect((await observe('SMP-9999-99999')).status).toBe(404);
    const s = await registerSample(t);
    const wrong = await observe(s.id, { password: 'wrong-password' }, 'analyst2');
    expect(wrong.status).toBe(401);
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND entity = 'LabNotebook' AND user_id = 'usr-analyst2'`)).n).toBeGreaterThanOrEqual(1);
    expect((await one('SELECT count(*)::int AS n FROM lab_notebook WHERE sample_id = $1', [s.id])).n).toBe(0);
    expect((await observe(s.id, { content: { a: 1 } })).status).toBe(400);
    expect((await observe(s.id, { author: 'usr-qa' })).status).toBe(400);
  });
});

describe('reading a worksheet', () => {
  it('GET /eln/:id lists the signatures of that worksheet only, not those of the sample it is linked to', async () => {
    const s = await registerSample(t);
    const analyst = H.analyst1;
    const id = (await t.request.post('/api/eln').set(analyst).send({ title: uniq('W'), content: 'c', sampleId: s.id })).body.id as string;
    // A signature on the sample itself (a submission for review) must not appear as a signature of the worksheet.
    const sub = await t.request.post(`/api/samples/${s.id}/transition`).set(analyst).send({ action: 'submit', expectedVersion: s.version });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // r1-results-oos: review needs every result entered.
    expect((await t.request.put(`/api/samples/${s.id}/results/${s.result.id}`).set(analyst).send({ value: '100.0', reason: 'routine entry', expectedVersion: s.result.version })).status).toBe(200);
    await t.request.post(`/api/samples/${s.id}/transition`).set(analyst).send({ action: 'review', expectedVersion: sub.body.version, password: TEST_PASSWORD });
    expect((await one(`SELECT count(*)::int AS n FROM signatures WHERE sample_id = $1`, [s.id])).n).toBeGreaterThan(0);

    const before = await t.request.get(`/api/eln/${id}`).set(analyst);
    expect(before.status).toBe(200);
    expect(before.body.signatures).toEqual([]);
    expect((await t.request.post(`/api/eln/${id}/sign`).set(analyst).send({ password: TEST_PASSWORD })).status).toBe(200);
    const after = await t.request.get(`/api/eln/${id}`).set(analyst);
    expect(after.body.signatures).toHaveLength(1);
    expect(after.body.signatures[0]).toMatchObject({ entityType: 'LabNotebook', entityId: id, meaningCode: 'AUTHORSHIP' });
  });
});
