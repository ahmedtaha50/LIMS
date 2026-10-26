/**
 * Roadmap M28 (r2-docs-training), the controlled document lifecycle.
 *
 * Before: the schema had no documents table; "SOP Training Matrix" was one boolean per user.
 *
 * After (acceptance of M28 asserted here):
 *   - a version cannot become Effective without three distinct signatures (author, reviewer, approver) and a QA role; making v3
 *     Effective supersedes v2 in the same transaction;
 *   - a 20 MB PDF uploads, and a tampered file fails the download with an audit row.
 * Plus: Draft-only edits with the version predicate, strict input, Effective content frozen by the database, the controlled-copy
 * print log, and the change-control gate (r2-qms) on making a version Effective.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const PW = 'password';
const BLOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-blobs-'));
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

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

const pdf = (text: string, size = 0) => {
  const head = Buffer.from(`%PDF-1.7\n% ${text}\n`);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]) : head;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const versionRow = (id: string) => one('SELECT * FROM document_versions WHERE id = $1', [id]);

async function upload(versionId: string, file: Buffer, who: Who = 'analyst1', name = 'sop.pdf') {
  const v = await versionRow(versionId);
  return t.request.put(`/api/document-versions/${versionId}/file`).query({ fileName: name, expectedVersion: v.version })
    .set(H[who]).set('Content-Type', 'application/octet-stream').send(file);
}
async function step(versionId: string, what: 'submit' | 'review' | 'approve' | 'effective' | 'obsolete', who: Who, extra: Record<string, unknown> = {}) {
  const v = await versionRow(versionId);
  return post(`/document-versions/${versionId}/${what}`, { password: PW, expectedVersion: v.version, ...extra }, who);
}
async function newDocument(who: Who = 'analyst1', over: Record<string, unknown> = {}) {
  const res = ok(await post('/documents', { code: uniq('SOP-QC'), title: 'Operation of the analytical balance', docType: 'SOP', ...over }, who));
  return res as { document: { id: string; code: string }; version: { id: string; revision: number; status: string; version: number } };
}
/** A version taken from Draft to Effective by four people: author analyst1, reviewer, approver Admin, QA making it Effective. */
async function makeEffective(versionId: string, file = pdf(versionId)) {
  ok(await upload(versionId, file));
  ok(await step(versionId, 'submit', 'analyst1'));
  ok(await step(versionId, 'review', 'reviewer'));
  ok(await step(versionId, 'approve', 'admin'));
  return ok(await step(versionId, 'effective', 'qa'));
}

describe('creating and editing a document', () => {
  it('creates revision 1 as a Draft by its author, refuses server-controlled fields, edits a Draft with the version predicate', async () => {
    const strict = await post('/documents', { code: uniq('SOP'), title: 'x title', docType: 'SOP', status: 'Effective' }, 'analyst1');
    expect(strict.status).toBe(400);
    const { document, version } = await newDocument();
    expect(version).toMatchObject({ revision: 1, status: 'Draft', version: 1 });
    expect(await versionRow(version.id)).toMatchObject({ author_id: 'usr-analyst1', document_id: document.id });
    expect((await post('/documents', { code: document.code.toLowerCase(), title: 'Duplicate code', docType: 'SOP' }, 'analyst1')).status).toBe(409);

    const edited = ok(await put(`/document-versions/${version.id}`, { title: 'Operation and daily check of the analytical balance', changeSummary: 'New document', expectedVersion: 1 }, 'analyst1'));
    expect(edited).toMatchObject({ title: 'Operation and daily check of the analytical balance', version: 2 });
    expect((await put(`/document-versions/${version.id}`, { title: 'Stale edit', expectedVersion: 1 }, 'analyst1')).status).toBe(409);
    expect((await put(`/document-versions/${version.id}`, { title: 'Server field', status: 'Approved', expectedVersion: 2 }, 'analyst1')).status).toBe(400);
    const audit = await sql(`SELECT action, field FROM audit_trail WHERE entity = 'DocumentVersion' AND entity_id = $1 ORDER BY sequence`, [version.id]);
    expect(audit.map(a => `${a.action}:${a.field}`)).toEqual(['Create:all', 'Update:title', 'Update:changeSummary']);

    // A Draft without a file cannot be submitted.
    const noFile = await step(version.id, 'submit', 'analyst1');
    expect(noFile.status, JSON.stringify(noFile.body)).toBe(409);
    expect(noFile.body.code).toBe('FILE_REQUIRED');
  });
});

describe('the signed lifecycle (M28 acceptance 1)', () => {
  it('cannot become Effective without three distinct signatures and a QA role', async () => {
    const { version } = await newDocument();
    ok(await upload(version.id, pdf('lifecycle')));
    // Only the author submits; the submission is the authorship signature.
    expect((await step(version.id, 'submit', 'analyst2')).status).toBe(403);
    const submitted = ok(await step(version.id, 'submit', 'analyst1'));
    expect(submitted.version).toMatchObject({ status: 'InReview' });
    expect(submitted.signature).toMatchObject({ meaningCode: 'DOCUMENT_AUTHORSHIP', signerId: 'usr-analyst1', recordVersion: submitted.version.version });
    // Content is frozen once submitted.
    expect((await put(`/document-versions/${version.id}`, { title: 'Late change', expectedVersion: submitted.version.version }, 'analyst1')).status).toBe(423);
    expect((await upload(version.id, pdf('late'))).status).toBe(423);

    // Not reviewed: neither approval nor effectivity.
    const early = await step(version.id, 'approve', 'admin');
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect((await step(version.id, 'effective', 'qa')).status).toBe(409);

    // The reviewer must hold doc.review (an Analyst does not) and be independent of the author.
    expect((await step(version.id, 'review', 'analyst2')).status).toBe(403);
    const reviewed = ok(await step(version.id, 'review', 'qa'));
    expect(reviewed.signature).toMatchObject({ meaningCode: 'DOCUMENT_REVIEW', signerId: 'usr-qa' });

    // The approver must be neither the author nor the reviewer.
    const sameAsReviewer = await step(version.id, 'approve', 'qa');
    expect(sameAsReviewer.status, JSON.stringify(sameAsReviewer.body)).toBe(403);
    expect(sameAsReviewer.body.code).toBe('SOD_VIOLATION');
    const approved = ok(await step(version.id, 'approve', 'admin'));
    expect(approved.version).toMatchObject({ status: 'Approved', approverId: 'usr-admin', reviewerId: 'usr-qa' });

    // Only the QA role makes it Effective: Admin (role not allowed by the meaning), Reviewer and Analyst (no permission) are refused.
    for (const who of ['admin', 'reviewer', 'analyst1'] as const) {
      const res = await step(version.id, 'effective', who);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    const effective = ok(await step(version.id, 'effective', 'qa'));
    expect(effective.version).toMatchObject({ status: 'Effective', effectiveBy: 'usr-qa' });
    const sigs = await sql(`SELECT meaning_code, signer_id, record_version FROM signatures WHERE entity_type = 'DocumentVersion' AND entity_id = $1 ORDER BY timestamp`, [version.id]);
    expect(sigs.map(s => `${s.meaning_code}:${s.signer_id}`)).toEqual([
      'DOCUMENT_AUTHORSHIP:usr-analyst1', 'DOCUMENT_REVIEW:usr-qa', 'DOCUMENT_APPROVAL:usr-admin', 'DOCUMENT_EFFECTIVE:usr-qa',
    ]);
    expect(new Set(sigs.slice(0, 3).map(s => s.signer_id)).size).toBe(3);
    for (const s of await sql(`SELECT id FROM signatures WHERE entity_type = 'DocumentVersion' AND entity_id = $1`, [version.id])) {
      expect(ok(await get(`/signatures/verify/${s.id}`, 'qa'))).toMatchObject({ valid: true });
    }
  });

  it('refuses effectivity when the three signatures on the submitted content are not three distinct people', async () => {
    const { version } = await newDocument();
    ok(await upload(version.id, pdf('three')));
    ok(await step(version.id, 'submit', 'analyst1'));
    ok(await step(version.id, 'review', 'reviewer'));
    ok(await step(version.id, 'approve', 'admin'));
    // The review signature is removed from the record of this cycle (as if it had been made before a return to Draft).
    await sql(`UPDATE document_versions SET reviewer_id = NULL, version = version + 1 WHERE id = $1`, [version.id]);
    const res = await step(version.id, 'effective', 'qa');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('SIGNATURES_INCOMPLETE');
    expect((await versionRow(version.id)).status).toBe('Approved');
  });

  it('a return to Draft voids the review and approval of that cycle', async () => {
    const { version } = await newDocument();
    ok(await upload(version.id, pdf('return')));
    ok(await step(version.id, 'submit', 'analyst1'));
    ok(await step(version.id, 'review', 'reviewer'));
    const v = await versionRow(version.id);
    expect((await post(`/document-versions/${version.id}/return`, { reason: 'x', expectedVersion: v.version }, 'reviewer')).status).toBe(400);
    const back = ok(await post(`/document-versions/${version.id}/return`, { reason: 'Section 5.2 contradicts the balance logbook', expectedVersion: v.version }, 'reviewer'));
    expect(back).toMatchObject({ status: 'Draft', reviewerId: null, approverId: null });
    ok(await upload(version.id, pdf('return v2')));
    ok(await step(version.id, 'submit', 'analyst1'));
    // The earlier review does not count: approval needs a review of the resubmitted content.
    expect((await step(version.id, 'approve', 'admin')).status).toBe(409);
  });

  it('making v3 Effective supersedes v2 in the same transaction, and assigns nothing twice', async () => {
    const { document, version: v1 } = await newDocument();
    await makeEffective(v1.id);
    const revise = async () => ok(await post(`/documents/${document.id}/revise`, {}, 'analyst1')) as { id: string; revision: number; status: string };
    const v2 = await revise();
    expect(v2).toMatchObject({ revision: 2, status: 'Draft' });
    expect((await post(`/documents/${document.id}/revise`, {}, 'analyst1')).status).toBe(409); // one open version at a time
    await makeEffective(v2.id);
    expect((await versionRow(v1.id)).status).toBe('Superseded');
    const v3 = await revise();
    await makeEffective(v3.id, pdf('revision 3'));

    const rows = await sql(`SELECT id, revision, status, xmin::text AS tx FROM document_versions WHERE document_id = $1 ORDER BY revision`, [document.id]);
    expect(rows.map(r => `${r.revision}:${r.status}`)).toEqual(['1:Superseded', '2:Superseded', '3:Effective']);
    // The supersession of v2 and the effectivity of v3 were written by one transaction.
    expect(rows[1].tx).toBe(rows[2].tx);
    const sup = await one(`SELECT action, old_value, new_value FROM audit_trail WHERE entity = 'DocumentVersion' AND entity_id = $1 AND action = 'Supersede'`, [v2.id]);
    expect(sup).toMatchObject({ old_value: 'Effective', new_value: 'Superseded' });

    const listed = ok(await get('/documents', 'analyst2')).find((d: any) => d.id === document.id);
    expect(listed).toMatchObject({ effective: { id: v3.id, revision: 3 }, open: null });
    // The database refuses an edit of the Effective content, whoever connects.
    await expect(sql(`UPDATE document_versions SET title = 'Edited behind the application' WHERE id = $1`, [v3.id])).rejects.toThrow(/controlled document/);
  });

  it('obsoletes an Effective version with a reason, signed by QA', async () => {
    const { version } = await newDocument();
    await makeEffective(version.id);
    expect((await step(version.id, 'obsolete', 'qa')).status).toBe(400); // reason required
    const res = ok(await step(version.id, 'obsolete', 'qa', { reason: 'Balance decommissioned; procedure withdrawn' }));
    expect(res.version.status).toBe('Obsolete');
  });
});

describe('the change-control gate (r2-qms)', () => {
  it('with change control required, effectivity needs an Approved change control that affects the document', async () => {
    const { document, version } = await newDocument();
    ok(await upload(version.id, pdf('cc')));
    ok(await step(version.id, 'submit', 'analyst1'));
    ok(await step(version.id, 'review', 'reviewer'));
    ok(await step(version.id, 'approve', 'admin'));
    await sql(`UPDATE qms_settings SET change_control_required = true, version = version + 1`);
    try {
      const failsBefore = (await one(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`)).failed_attempts;
      const refused = await step(version.id, 'effective', 'qa', { password: 'wrong-password' });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe('CHANGE_REQUIRED');
      expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`)).failed_attempts).toBe(failsBefore);

      const cc = `CC-${uniq('T')}`;
      await sql(`INSERT INTO qms_records (id, type, title, state, created_by) VALUES ($1, 'ChangeControl', 'Revise the balance SOP', 'Approved', 'usr-reviewer')`, [cc]);
      await sql(`INSERT INTO qms_links (id, record_id, relation, target_type, target_id, created_by) VALUES ($1, $2, 'affects', 'Document', $3, 'usr-reviewer')`, [`QL-${uniq('x')}`, cc, document.id]);
      ok(await step(version.id, 'effective', 'qa'));
      expect(await one(`SELECT relation FROM qms_links WHERE record_id = $1 AND relation = 'implemented' AND target_id = $2`, [cc, document.id])).toBeTruthy();
    } finally {
      await sql(`UPDATE qms_settings SET change_control_required = false, version = version + 1`);
    }
  });
});

describe('files (M28 acceptance 2)', () => {
  it('a 20 MB PDF uploads with its sha256 and downloads byte-identical', async () => {
    const { version } = await newDocument();
    const big = pdf('twenty megabytes', 20 * 1024 * 1024);
    const res = ok(await upload(version.id, big));
    expect(res).toMatchObject({ fileSha256: sha(big), bytes: big.length, mediaType: 'application/pdf', fileName: 'sop.pdf' });
    const down = await get(`/document-versions/${version.id}/content`, 'analyst2').buffer(true).parse((r, cb) => {
      const parts: Buffer[] = []; r.on('data', (c: Buffer) => parts.push(c)); r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(down.status).toBe(200);
    expect(down.headers['x-content-sha256']).toBe(sha(big));
    expect(sha(down.body as Buffer)).toBe(sha(big));
  });

  it('refuses a file that is not a document format', async () => {
    const { version } = await newDocument();
    const res = await upload(version.id, Buffer.from('MZ\x90\x00 executable'), 'analyst1', 'sop.pdf');
    expect(res.status).toBe(415);
  });

  it('a tampered file fails the download (409) and writes an audit row', async () => {
    const { version } = await newDocument();
    const file = pdf('tamper me');
    ok(await upload(version.id, file));
    const stored = path.join(BLOBS, sha(file));
    fs.chmodSync(stored, 0o644);
    const bytes = fs.readFileSync(stored); bytes[bytes.length - 1] ^= 0xff; fs.writeFileSync(stored, bytes);
    const res = await get(`/document-versions/${version.id}/content`, 'analyst2');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_INTEGRITY_FAILED');
    const audit = await one(`SELECT user_id, action, old_value FROM audit_trail WHERE entity = 'DocumentVersion' AND entity_id = $1 AND action = 'IntegrityCheckFailed'`, [version.id]);
    expect(audit).toMatchObject({ user_id: 'usr-analyst2', old_value: sha(file) });
  });
});

describe('controlled copies', () => {
  it('prints only an Effective version, numbers each copy and keeps the print log', async () => {
    const { version } = await newDocument();
    ok(await upload(version.id, pdf('print')));
    expect((await post(`/document-versions/${version.id}/print`, { purpose: 'Bench copy for QC lab 2' }, 'analyst2')).status).toBe(409);
    ok(await step(version.id, 'submit', 'analyst1'));
    ok(await step(version.id, 'review', 'reviewer'));
    ok(await step(version.id, 'approve', 'admin'));
    ok(await step(version.id, 'effective', 'qa'));
    const first = ok(await post(`/document-versions/${version.id}/print`, { purpose: 'Bench copy for QC lab 2', recipient: 'QC lab 2' }, 'analyst2'), 201);
    const second = ok(await post(`/document-versions/${version.id}/print`, { purpose: 'Training copy' }, 'analyst1'), 201);
    expect(first.print.copyNumber).toBe(1);
    expect(second.print.copyNumber).toBe(2);
    expect(first.footer).toMatch(/Controlled copy 1/);
    expect(first.footer).toMatch(/rev(ision)? 1/i);
    const log = ok(await get(`/document-versions/${version.id}/prints`, 'qa'));
    expect(log.map((p: any) => `${p.copyNumber}:${p.printedBy}`)).toEqual(['1:usr-analyst2', '2:usr-analyst1']);
    expect(await one(`SELECT action FROM audit_trail WHERE entity = 'DocumentVersion' AND entity_id = $1 AND action = 'Print'`, [version.id])).toBeTruthy();
  });
});
