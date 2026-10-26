/**
 * Roadmap M42 (r3-periodic-archive): periodic review, retention and legal hold, verifiable batch archive.
 *
 * Before: nothing. There was no periodic review, no user-access report, no retention or legal hold and no archive: Annex 11 s.11 and s.17
 * were unmet, and nothing marked a finished batch read-only.
 *
 * After: QA-signed periodic reviews with evidence and due dates (scheduled scan, events outbox); retention classes that keep everything
 * indefinitely until QA sets a number, and legal holds that block flagging for purge (also in the database); a batch archive bundle that
 * verifies against its SHA-256 manifest (one altered, missing or extra file fails it), a QA decision that marks the records archived in a
 * sidecar (423 on update, trigger as backstop), the audit chain still verifying, and a restore round trip into an empty database.
 * Nothing deletes or alters a GxP record.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { connectionConfig, createFromTemplate, dropDatabase, templateName, withAdmin } from '../helpers/db';
import { uniq } from '../helpers/fixtures';
import { scratchDb, tempDir } from '../upgrade/helpers';

let t: TestApp;
let H: Record<'admin' | 'qa' | 'reviewer' | 'analyst1', { Authorization: string }>;
let tmp: string;
let svc: any; // dynamic imports of the product modules, after the test database is chosen
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-archive-'));
  process.env.BLOB_DIR = path.join(tmp, 'blobs');
  process.env.ARCHIVE_DIR = path.join(tmp, 'archives');
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst1: await t.auth('analyst1@gxp.com') };
  const { db } = await import('../../src/db/index');
  svc = {
    db,
    archive: await import('../../src/server/archive'),
    periodic: await import('../../src/server/schedules/periodic'),
    retention: await import('../../src/server/retention'),
    utils: await import('../../src/db/utils'),
    chain: await import('../../src/server/audit/chain'),
  };
});

/** A read-only tree cannot be removed by a non-root user: open it first. */
const rmTree = (dir: string) => {
  const open = (d: string) => { if (!fs.existsSync(d)) return; fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) open(p); else fs.chmodSync(p, 0o644); } };
  open(dir);
  fs.rmSync(dir, { recursive: true, force: true });
};
afterAll(() => { rmTree(tmp); });

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------------------
describe('0330_periodic_archive', () => {
  it('creates the tables, the four QA-only meanings and the six permissions', async () => {
    for (const table of ['periodic_review_plans', 'periodic_reviews', 'retention_policies', 'legal_holds', 'retention_flags', 'archive_bundles', 'archived_records']) {
      expect((await one(`SELECT to_regclass('public.${table}') AS r`)).r).toBe(table);
    }
    const meanings = await sql("SELECT code, allowed_roles FROM signature_meanings WHERE code IN ('PERIODIC_REVIEW','ARCHIVE_DECISION','RETENTION_POLICY','LEGAL_HOLD') ORDER BY code COLLATE \"C\"");
    expect(meanings.map(m => [m.code, m.allowed_roles])).toEqual([['ARCHIVE_DECISION', ['QA']], ['LEGAL_HOLD', ['QA']], ['PERIODIC_REVIEW', ['QA']], ['RETENTION_POLICY', ['QA']]]);
    const perms = await sql("SELECT permission_code, count(*)::int AS n FROM role_permissions WHERE permission_code ~ '^(periodic|archive|retention)\\.' GROUP BY permission_code ORDER BY permission_code COLLATE \"C\"");
    expect(perms.map(p => p.permission_code)).toEqual(['archive.manage', 'archive.view', 'periodic.manage', 'periodic.sign', 'periodic.view', 'retention.manage']);
  });

});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('periodic review', () => {
  let planId: string;
  let reviewId: string;

  it('a plan needs the manage permission and a subject that exists', async () => {
    const body = { kind: 'user_access', subjectId: '*', title: 'Annual user access review', intervalMonths: 12, firstDueDate: addDays(5) };
    expect((await t.request.post('/api/periodic-reviews/plans').set(H.analyst1).send(body)).status).toBe(403);
    expect((await t.request.post('/api/periodic-reviews/plans').set(H.qa).send({ ...body, id: 'x' })).status).toBe(400); // strict
    expect((await t.request.post('/api/periodic-reviews/plans').set(H.qa).send({ ...body, kind: 'instrument', subjectId: 'NOPE' })).status).toBe(404);
    const ok = await t.request.post('/api/periodic-reviews/plans').set(H.qa).send(body);
    expect(ok.status).toBe(201);
    planId = ok.body.id;
    expect(ok.body.checklist.length).toBeGreaterThan(0);
    expect((await t.request.post('/api/periodic-reviews/plans').set(H.qa).send(body)).status).toBe(409); // one active plan per subject
    const audit = await one("SELECT action, user_id FROM audit_trail WHERE entity = 'PeriodicReviewPlan' AND entity_id = $1", [planId]);
    expect(audit).toEqual({ action: 'Create', user_id: 'usr-qa' });
  });

  it('the scan opens the review with a user x role x last sign-in x training report, and announces it once', async () => {
    const first = await svc.periodic.runPeriodicScan(svc.db);
    expect(first.opened).toBe(1);
    expect(first.alerts).toBe(1); // due in 5 days: the 7-day announcement
    const second = await svc.periodic.runPeriodicScan(svc.db);
    expect(second).toEqual({ opened: 0, alerts: 0 }); // never announced twice
    const events = await sql("SELECT payload FROM outbox_events WHERE type = 'periodic.review_due' AND payload->>'kind' = 'user_access'");
    expect(events).toHaveLength(1);
    expect(events[0].payload.threshold).toBe(7);

    const list = await t.request.get('/api/periodic-reviews?status=Open').set(H.reviewer);
    expect(list.status).toBe(200);
    reviewId = list.body[0].id;
    const detail = await t.request.get(`/api/periodic-reviews/${reviewId}`).set(H.reviewer);
    const ev = detail.body.review.evidence;
    expect(ev.users.length).toBeGreaterThanOrEqual(5);
    expect(ev.users[0]).toHaveProperty('role');
    expect(ev.users[0]).toHaveProperty('lastLoginAt');
    expect(ev.users[0]).toHaveProperty('softwareTrainingCompleted');
    expect(JSON.stringify(ev)).not.toMatch(/scrypt|password_hash|passwordHash|totpSecret/);
    expect(sha(JSON.stringify(ev)) === detail.body.review.evidenceSha256).toBe(false); // the hash is of the canonical JSON, not of this text
    expect(detail.body.review.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows on the due list (the QA dashboard feed) and is overdue-announced weekly once late', async () => {
    const due = await t.request.get('/api/periodic-reviews/due').set(H.qa);
    expect(due.body.items.some((i: any) => i.id === reviewId && i.opened && !i.overdue)).toBe(true);
    const dash = await t.request.get('/api/dashboard').set(H.qa);
    expect(dash.status).toBe(200);
    expect(dash.body.periodicReviewsDue.items.some((i: any) => i.id === reviewId && i.kind === 'user_access')).toBe(true);
    const later = new Date(Date.now() + 10 * 86_400_000);
    const r = await svc.periodic.runPeriodicScan(svc.db, { now: later });
    expect(r.alerts).toBe(1); // 5 days after the due date: threshold -7
    const types = await sql("SELECT (payload->>'threshold')::int AS th FROM outbox_events WHERE type = 'periodic.review_due' ORDER BY 1");
    expect(types.map(x => x.th)).toEqual([-7, 7]);
    expect(svc.periodic.alertThreshold(8)).toBeNull();
    expect(svc.periodic.alertThreshold(0)).toBe(0);
    expect(svc.periodic.alertThreshold(-15)).toBe(-21);
  });

  it('cannot be completed without the checklist, without a signature, or by anyone but QA', async () => {
    const detail = await t.request.get(`/api/periodic-reviews/${reviewId}`).set(H.qa);
    const items: string[] = detail.body.plan.checklist;
    const version = detail.body.review.version;
    const answers = items.map(item => ({ item, answer: 'Yes' }));
    const body = { conclusion: 'Satisfactory', summary: 'All accounts are still needed.', checklist: answers, findings: [], expectedVersion: version, reason: 'Annual review concluded', password: 'password' };
    const post = (b: any, who: keyof typeof H = 'qa') => t.request.post(`/api/periodic-reviews/${reviewId}/complete`).set(H[who]).send(b);

    expect((await post({ ...body, checklist: answers.slice(1) })).body.code).toBe('CHECKLIST_INCOMPLETE');
    expect((await post({ ...body, checklist: answers.map((a, i) => (i === 0 ? { ...a, answer: 'No' } : a)) })).body.code).toBe('CHECKLIST_COMMENT_REQUIRED');
    expect((await post({ ...body, checklist: answers.map((a, i) => (i === 0 ? { ...a, answer: 'No', comment: 'Two leavers still active' } : a)) })).body.code).toBe('CONCLUSION_CONTRADICTS_FINDINGS');
    expect((await post({ ...body, password: undefined })).status).toBe(400);
    expect((await post({ ...body, password: 'wrong-password' })).status).toBeGreaterThanOrEqual(400);
    expect((await post(body, 'reviewer')).status).toBe(403);
    expect((await post(body, 'admin')).status).toBeGreaterThanOrEqual(400); // the Administrator holds the permission; the meaning is QA only
    expect((await one('SELECT status FROM periodic_reviews WHERE id = $1', [reviewId])).status).toBe('Open');

    const done = await post(body);
    expect(done.status).toBe(200);
    expect(done.body.result.status).toBe('Completed');
    const sig = done.body.signature;
    expect(sig).toMatchObject({ entityType: 'PeriodicReview', entityId: reviewId, meaningCode: 'PERIODIC_REVIEW', recordVersion: done.body.result.version, signerId: 'usr-qa' });
    expect((await one("SELECT count(*)::int AS n FROM signatures WHERE entity_id = $1 AND meaning_code = 'PERIODIC_REVIEW'", [reviewId])).n).toBe(1);
    const audit = await one("SELECT action FROM audit_trail WHERE entity = 'PeriodicReview' AND entity_id = $1 AND action = 'Complete'", [reviewId]);
    expect(audit.action).toBe('Complete');
  });

  it('moves the plan one interval on, and a completed review can no longer be changed', async () => {
    const plan = await one('SELECT next_due_date, interval_months FROM periodic_review_plans WHERE id = $1', [planId]);
    expect(plan.next_due_date > addDays(300)).toBe(true);
    await expect(sql("UPDATE periodic_reviews SET summary = 'edited' WHERE id = $1", [reviewId])).rejects.toThrow(/cannot be changed/);
    const stale = await t.request.put(`/api/periodic-reviews/${reviewId}`).set(H.qa).send({ summary: 'late edit', reason: 'late edit', expectedVersion: 1 });
    expect([409, 423]).toContain(stale.status);
    const signed = await t.request.get(`/api/signatures/entity/PeriodicReview/${reviewId}`).set(H.qa);
    expect(signed.status).toBe(200);
  });

  it('reviews an instrument, a specification and a qualified module, and builds the system pack', async () => {
    const inst = await one('SELECT id FROM instruments LIMIT 1').catch(() => undefined);
    const instId = inst?.id ?? uniq('INST');
    if (!inst) await sql("INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC 1', 'HPLC', 'Active', $2, $3)", [instId, addDays(60), addDays(-300)]);
    const spec = uniq('SPEC');
    await sql("INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', 'Active', '[]'::jsonb)", [spec, uniq('Mat')]);
    const make = async (kind: string, subjectId: string) => {
      const plan = await t.request.post('/api/periodic-reviews/plans').set(H.qa).send({ kind, subjectId, title: `${kind} review`, intervalMonths: 12, firstDueDate: addDays(3) });
      expect(plan.status).toBe(201);
      const open = await t.request.post(`/api/periodic-reviews/plans/${plan.body.id}/open`).set(H.qa);
      expect(open.status).toBe(201);
      return open.body.evidence;
    };
    expect((await make('instrument', instId)).calibration).toHaveProperty('calibrationDueDate');
    expect((await make('specification', spec)).specification.id).toBe(spec);
    expect((await make('module', 'oos')).module).toBe('oos');
    const pack = await make('system', '*');
    expect(pack).toHaveProperty('backups');
    expect(pack).toHaveProperty('restoreTests');
    expect(pack).toHaveProperty('auditReviewCoverage');
    expect(pack.auditChain.valid).toBe(true);
    expect(Array.isArray(pack.qualityRecords)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
/** A finished, Released batch with one approved sample, one result, a raw-data file, a release, a CoA and its PDF. */
async function arrangeBatch() {
  const tag = uniq('A').replace(/[^A-Za-z0-9]/g, '');
  const product = await t.request.post('/api/products').set(H.qa).send({ code: `PRD${tag}`, name: `Ibuprofen ${tag}` });
  expect(product.status).toBe(200);
  const batch = await t.request.post('/api/batches').set(H.qa).send({ productId: product.body.id, batchNo: `BN${tag}` });
  expect(batch.status).toBe(200);
  const batchId = batch.body.id as string;
  const sampleId = `S-${tag}`;
  const resultId = `R-${tag}`;
  const content = Buffer.from(`raw chromatogram ${tag}`);
  const blobHash = sha(content);
  fs.mkdirSync(process.env.BLOB_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.BLOB_DIR!, blobHash), content);
  const pdf = Buffer.from(`%PDF-1.4 fake CoA ${tag}`);
  await sql('BEGIN');
  try {
    await sql("UPDATE product_batches SET status = 'Released' WHERE id = $1", [batchId]);
    await sql("INSERT INTO samples (id, material, batch, state, created_by) VALUES ($1, $2, $3, 'Approved', 'usr-analyst1')", [sampleId, `Ibuprofen ${tag}`, `BN${tag}`]);
    await sql("INSERT INTO sample_context (sample_id, product_id, batch_id, created_by) VALUES ($1, $2, $3, 'usr-analyst1')", [sampleId, batch.body.productId, batchId]);
    await sql("INSERT INTO results (id, sample_id, parameter, value, entered_by, entered_at) VALUES ($1, $2, 'Assay (%)', '99.8', 'usr-analyst1', now())", [resultId, sampleId]);
    await sql("INSERT INTO attachments (id, sample_id, result_id, file_name, media_type, kind, bytes, sha256, uploaded_by) VALUES ($1, $2, $3, 'run.csv', 'text/csv', 'csv', $4, $5, 'usr-analyst1')", [`ATT-${tag}`, sampleId, resultId, content.length, blobHash]);
    await sql("INSERT INTO batch_releases (id, batch, status, released_by, released_at) VALUES ($1, $2, 'Released', 'usr-qa', now())", [`REL-${tag}`, `BN${tag}`]);
    const coaNumber = `COA-2026-${String(1000 + (Math.abs(hashCode(tag)) % 8999))}`;
    await sql(`INSERT INTO coa_documents (id, sample_id, number, issue_version, label, snapshot, snapshot_sha256, issued_by, issued_at)
               VALUES ($1, $2, $3, 1, $4, '{"ok":true}'::jsonb, $5, 'usr-qa', now())`, [`COA-${tag}`, sampleId, coaNumber, `${coaNumber}-v1`, sha('x')]);
    await sql('COMMIT');
  } catch (e) { await sql('ROLLBACK'); throw e; }
  return { tag, batchId, sampleId, resultId, blobHash, content, pdf, batchNo: `BN${tag}` };
}
function hashCode(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

describe('retention and legal hold', () => {
  it('keeps everything indefinitely until QA signs a number; nothing is eligible, nothing can be flagged', async () => {
    const policies = (await t.request.get('/api/retention/policies').set(H.reviewer)).body;
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const p of policies) expect(p).toMatchObject({ retentionYears: null, indefinite: true });
    expect((await t.request.get('/api/retention/candidates').set(H.qa)).body).toEqual([]);
    const flag = await t.request.post('/api/retention/flags').set(H.qa).send({ entityType: 'Sample', entityId: 'S-NONE', reason: 'Retention expired' });
    expect(flag.status).toBe(409);
    expect(flag.body.code).toBe('NOT_ARCHIVED');
    await expect(sql("INSERT INTO retention_flags (id, record_class, entity_type, entity_id, reason, flagged_by) VALUES ('rf-x', 'sample-records', 'Sample', 'S-NONE', 'direct insert', 'usr-qa')"))
      .rejects.toThrow(/is not archived/);
  });

  it('a retention number is signed by QA with the version it replaces', async () => {
    const put = (who: keyof typeof H, body: any) => t.request.put('/api/retention/policies/batch-records').set(H[who]).send(body);
    const body = { retentionYears: 1, basis: 'Site retention SOP decision, to be confirmed', expectedVersion: 0, reason: 'Set per SOP', password: 'password' };
    expect((await put('analyst1', body)).status).toBe(403);
    expect((await put('qa', { ...body, retentionYears: 0 })).status).toBe(400);
    const ok = await put('qa', body);
    expect(ok.status).toBe(200);
    expect(ok.body.signature).toMatchObject({ entityType: 'RetentionPolicy', entityId: 'batch-records', meaningCode: 'RETENTION_POLICY', recordVersion: 1 });
    expect((await put('qa', body)).status).toBe(409); // stale version
    const again = await put('qa', { ...body, retentionYears: null, expectedVersion: 1, basis: 'Back to indefinite until decided' });
    expect(again.status).toBe(200);
    expect(again.body.result.retentionYears).toBeNull();
  });
});

describe('batch archive', () => {
  let a: Awaited<ReturnType<typeof arrangeBatch>>;
  let bundle: { id: string; dirName: string; manifestSha256: string; version: number; status: string };
  let dir: string;

  it('refuses a batch that is not finished', async () => {
    const tag = uniq('Q').replace(/[^A-Za-z0-9]/g, '');
    const product = await t.request.post('/api/products').set(H.qa).send({ code: `PRD${tag}`, name: `Paracetamol ${tag}` });
    const batch = await t.request.post('/api/batches').set(H.qa).send({ productId: product.body.id, batchNo: `BN${tag}` });
    const r = await t.request.post('/api/archive/bundles').set(H.qa).send({ batchId: batch.body.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ARCHIVE_PRECONDITION');
    expect((await t.request.post('/api/archive/bundles').set(H.analyst1).send({ batchId: batch.body.id })).status).toBe(403);
  });

  it('builds a bundle that verifies, and the audit slice, PDFs and raw-data files are in it', async () => {
    a = await arrangeBatch();
    await svc.db.transaction((tx: any) => svc.utils.writeAudit(tx, 'usr-qa', 'Approve', 'Sample', a.sampleId, 'state', 'Pending Review', 'Approved', 'Approved after review'));
    const pdfRun = a.pdf;
    await sql(`INSERT INTO report_runs (id, report_type, document_id, copy_no, purpose, document_status, file_name, bytes, pdf_sha256, pdf, generated_by)
               VALUES ($1, 'CoA', $2, 1, 'Original', 'Issued', 'coa.pdf', $3, $4, $5, 'usr-qa')`, [`RUN-${a.tag}`, `COA-${a.tag}`, pdfRun.length, sha(pdfRun), pdfRun]);

    const queued = await t.request.post('/api/archive/bundles').set(H.qa).send({ batchId: a.batchId });
    expect(queued.status).toBe(202);
    expect(queued.body.jobId).toMatch(/^job-/);
    // The queue worker is not running in the tests: the handler is what it runs.
    const out = await svc.periodic.archiveBuildHandler({ batchId: a.batchId }, { db: svc.db, job: { createdBy: 'usr-qa' } });
    bundle = (await t.request.get(`/api/archive/bundles/${out.bundleId}`).set(H.reviewer)).body.bundle;
    expect(bundle.status).toBe('Built');
    dir = path.join(process.env.ARCHIVE_DIR!, bundle.dirName);

    const check = await svc.archive.verifyArchive(dir, { expectedManifestSha256: bundle.manifestSha256 });
    expect(check).toMatchObject({ ok: true, problems: [] });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
    const paths = manifest.files.map((f: any) => f.path);
    expect(paths).toContain(`blobs/${a.blobHash}`);
    expect(paths).toContain(`reports/RUN-${a.tag}.pdf`);
    expect(paths).toContain('audit/audit_trail.json');
    expect(paths).toContain('data/signatures.json');
    const audit = JSON.parse(fs.readFileSync(path.join(dir, 'audit', 'audit_trail.json'), 'utf8'));
    expect(audit.some((e: any) => e.entityId === a.sampleId && e.hash && e.prevHash)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8').trim()).toBe(`${bundle.manifestSha256}  MANIFEST.json`);
    // read-only on disk (a root test runner can write anyway, so only the mode is asserted)
    expect(fs.statSync(path.join(dir, 'MANIFEST.json')).mode & 0o222).toBe(0);
    const verified = await t.request.post(`/api/archive/bundles/${bundle.id}/verify`).set(H.qa);
    expect(verified.body.ok).toBe(true);
  });

  it('one altered, one removed and one extra file each fail verification; the manifest cannot be swapped quietly', async () => {
    const copy = path.join(tmp, 'tamper');
    fs.cpSync(dir, copy, { recursive: true });
    const w = (p: string) => { fs.chmodSync(path.dirname(p), 0o755); if (fs.existsSync(p)) fs.chmodSync(p, 0o644); };

    const results = path.join(copy, 'data', 'results.json');
    w(results);
    fs.writeFileSync(results, fs.readFileSync(results, 'utf8').replace('99.8', '98.8'));
    let r = await svc.archive.verifyArchive(copy);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/data\/results\.json: hash differs/);

    // The bundle's folders are read-only (0555): a non-root user cannot write into the copy again until they are unlocked (root ignores the mode).
    for (const f of [''].concat(fs.readdirSync(copy, { recursive: true }) as string[])) { const p = path.join(copy, f); if (fs.statSync(p).isDirectory()) fs.chmodSync(p, 0o755); }
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(dir, copy, { recursive: true });
    for (const f of [''].concat(fs.readdirSync(copy, { recursive: true }) as string[])) { const p = path.join(copy, f); if (fs.statSync(p).isDirectory()) fs.chmodSync(p, 0o755); }
    for (const f of fs.readdirSync(copy, { recursive: true }) as string[]) { const p = path.join(copy, f); if (fs.statSync(p).isFile()) w(p); }
    fs.writeFileSync(results, fs.readFileSync(path.join(dir, 'data', 'results.json')));
    expect((await svc.archive.verifyArchive(copy)).ok).toBe(true); // restored: the check is not a false alarm

    const blob = path.join(copy, 'blobs', a.blobHash);
    w(blob); fs.rmSync(blob);
    r = await svc.archive.verifyArchive(copy);
    expect(r.problems.join(' ')).toMatch(/blobs\/.*: file is missing/);

    fs.writeFileSync(blob, a.content);
    fs.writeFileSync(path.join(copy, 'extra.txt'), 'planted');
    r = await svc.archive.verifyArchive(copy);
    expect(r.problems.join(' ')).toMatch(/extra\.txt: file is not in the manifest/);
    fs.rmSync(path.join(copy, 'extra.txt'));

    // replace a file AND the manifest consistently: only the hash in the register catches it
    w(results);
    fs.writeFileSync(results, fs.readFileSync(results, 'utf8').replace('99.8', '97.1'));
    const manifestPath = path.join(copy, 'MANIFEST.json');
    w(manifestPath); w(path.join(copy, 'MANIFEST.sha256'));
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = m.files.find((f: any) => f.path === 'data/results.json');
    entry.sha256 = sha(fs.readFileSync(results)); entry.bytes = fs.readFileSync(results).length;
    const text = JSON.stringify(m, null, 1) + '\n';
    fs.writeFileSync(manifestPath, text);
    fs.writeFileSync(path.join(copy, 'MANIFEST.sha256'), `${sha(text)}  MANIFEST.json\n`);
    expect((await svc.archive.verifyArchive(copy)).ok).toBe(true); // self-consistent...
    r = await svc.archive.verifyArchive(copy, { expectedManifestSha256: bundle.manifestSha256 });
    expect(r.ok).toBe(false); // ...but not the manifest the register recorded
    expect(r.problems.join(' ')).toMatch(/archive register/);
  });

  it('the QA decision archives the records: signed, bound to the manifest, and the records are read-only (423)', async () => {
    // verification bumps the register row's version (it records when and with what result), so the signer reads it again
    const current = async () => (await one('SELECT version FROM archive_bundles WHERE id = $1', [bundle.id])).version as number;
    const body = { reason: 'Bundle verified, batch closed', expectedVersion: await current(), password: 'password' };
    const decide = (who: keyof typeof H, b: any = body) => t.request.post(`/api/archive/bundles/${bundle.id}/decision`).set(H[who]).send(b);
    expect((await decide('analyst1')).status).toBe(403);
    expect((await decide('qa', { ...body, password: 'wrong-password' })).status).toBeGreaterThanOrEqual(400);
    expect((await one('SELECT count(*)::int AS n FROM archived_records')).n).toBe(0);

    // the live records changed after the bundle was built: the decision refuses (not archived blind)
    await sql("UPDATE results SET value = '99.9' WHERE id = $1", [a.resultId]);
    const stale = await decide('qa');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('ARCHIVE_STALE');
    await sql("UPDATE results SET value = '99.8' WHERE id = $1", [a.resultId]);

    const ok = await decide('qa');
    expect(ok.status).toBe(200);
    expect(ok.body.result.bundle.status).toBe('Archived');
    expect(ok.body.signature).toMatchObject({ entityType: 'ArchiveBundle', entityId: bundle.id, meaningCode: 'ARCHIVE_DECISION', recordVersion: ok.body.result.bundle.version });
    const archived = await sql('SELECT entity_type, entity_id FROM archived_records ORDER BY entity_type COLLATE "C", entity_id COLLATE "C"');
    expect(archived.map(r => r.entity_type)).toEqual(['BatchRelease', 'CoaDocument', 'ProductBatch', 'Result', 'Sample']);
    expect((await t.request.get(`/api/archive/records/Sample/${a.sampleId}`).set(H.reviewer)).body.archived).toBe(true);

    // 423 for HTTP writes, a trigger for every other path; reads still work
    const put = await t.request.put(`/api/samples/${a.sampleId}/results/${a.resultId}`).set(H.analyst1).send({ value: '100.0', expectedVersion: 1, reason: 'change after archive' });
    expect(put.status).toBe(423);
    expect(put.body.code).toBe('ARCHIVED_RECORD');
    expect((await t.request.post(`/api/samples/${a.sampleId}/transition`).set(H.qa).send({ action: 'reject', expectedVersion: 1, reason: 'change after archive', password: 'password' })).body.code).toBe('ARCHIVED_RECORD');
    expect((await t.request.put(`/api/batches/${a.batchId}`).set(H.qa).send({ expectedVersion: 1, batchSize: '10 kg' })).body.code).toBe('ARCHIVED_RECORD');
    expect((await t.request.get(`/api/samples/${a.sampleId}`).set(H.reviewer)).status).toBe(200);
    await expect(sql("UPDATE samples SET state = 'Logged' WHERE id = $1", [a.sampleId])).rejects.toThrow(/archived and read-only/);
    await expect(sql("UPDATE results SET value = '1' WHERE id = $1", [a.resultId])).rejects.toThrow(/archived and read-only/);
    await expect(sql('DELETE FROM samples WHERE id = $1', [a.sampleId])).rejects.toThrow(/archived and read-only/);
    await expect(sql("UPDATE product_batches SET status = 'Recalled' WHERE id = $1", [a.batchId])).rejects.toThrow(/archived and read-only/);

    // nothing was deleted or changed by archiving
    expect((await one('SELECT value FROM results WHERE id = $1', [a.resultId])).value).toBe('99.8');
    // the register shows one archive per batch
    const again = await t.request.post('/api/archive/bundles').set(H.qa).send({ batchId: a.batchId });
    expect(again.status).toBe(409);
  });

  it('the audit chain still verifies after archiving, and the weekly check passes then fails on a damaged bundle', async () => {
    expect((await svc.chain.verifyAuditChain(svc.db, { writeCheckpoints: false })).isValid).toBe(true);
    expect(await svc.periodic.runArchiveVerify(svc.db, { dir: process.env.ARCHIVE_DIR })).toEqual({ checked: 1, failed: 0 });
    // damage the stored bundle (as root or owner)
    const file = path.join(dir, 'data', 'results.json');
    fs.chmodSync(dir, 0o755); fs.chmodSync(path.join(dir, 'data'), 0o755); fs.chmodSync(file, 0o644);
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, ' ');
      expect(await svc.periodic.runArchiveVerify(svc.db, { dir: process.env.ARCHIVE_DIR })).toEqual({ checked: 1, failed: 1 });
      const ev = await sql("SELECT payload FROM outbox_events WHERE type = 'archive.verification_failed'");
      expect(ev).toHaveLength(1);
      expect(ev[0].payload.bundleId).toBe(bundle.id);
      expect((await one('SELECT last_verified_ok FROM archive_bundles WHERE id = $1', [bundle.id])).last_verified_ok).toBe(false);
    } finally {
      fs.writeFileSync(file, original);
    }
    expect((await t.request.post(`/api/archive/bundles/${bundle.id}/verify`).set(H.qa)).body.ok).toBe(true);
  });

  it('restore round trip: the bundle restores into an empty database and every row equals the original', async () => {
    const scratch = `${process.env.SQL_DB_NAME}_restore`;
    await withAdmin(c => createFromTemplate(c, scratch, templateName()));
    const pool = new pg.Pool({ ...connectionConfig(scratch), max: 2 });
    try {
      const target = drizzle(pool) as any;
      const blobTarget = path.join(tmp, 'restored-blobs');
      expect((await pool.query('SELECT count(*)::int AS n FROM samples')).rows[0].n).toBe(0);
      const restored = await svc.archive.restoreArchive(target, dir, { blobTarget });
      expect(restored.problems).toEqual([]);
      expect(restored.ok).toBe(true);
      for (const tbl of restored.tables) expect(tbl.different).toBe(0);
      const byName = Object.fromEntries(restored.tables.map((x: any) => [x.name, x]));
      expect(byName.samples).toMatchObject({ rows: 1, inserted: 1 });
      expect(byName.results.inserted).toBe(1);
      expect(byName.report_runs.inserted).toBe(1);
      expect(fs.readFileSync(path.join(blobTarget, a.blobHash))).toEqual(a.content);

      // the restored rows are identical to the originals, field by field (the PDF too)
      for (const [table, id] of [['samples', a.sampleId], ['results', a.resultId], ['coa_documents', `COA-${a.tag}`], ['batch_releases', `REL-${a.tag}`], ['product_batches', a.batchId], ['attachments', `ATT-${a.tag}`]] as const) {
        const orig = (await sql(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE id = $1`, [id]))[0].j;
        const back = (await pool.query(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE id = $1`, [id])).rows[0].j;
        expect(back).toEqual(orig);
      }
      const pdf = (await pool.query('SELECT pdf FROM report_runs WHERE id = $1', [`RUN-${a.tag}`])).rows[0].pdf as Buffer;
      expect(pdf.equals(a.pdf)).toBe(true);

      // running it again changes nothing: rows that exist are compared, never overwritten
      const second = await svc.archive.restoreArchive(target, dir, { blobTarget });
      expect(second.ok).toBe(true);
      expect(second.tables.every((x: any) => x.inserted === 0 && x.alreadyPresent === x.rows)).toBe(true);

      // a restore into a database whose row differs reports it and writes nothing
      await pool.query("UPDATE results SET value = '12.3' WHERE id = $1", [a.resultId]);
      const third = await svc.archive.restoreArchive(target, dir, { blobTarget });
      expect(third.ok).toBe(false);
      expect(third.problems.join(' ')).toMatch(/results: 1 rows in the target differ/);
    } finally {
      await pool.end();
      await withAdmin(c => dropDatabase(c, scratch));
    }
  });

  it('a damaged bundle is not restored', async () => {
    const copy = path.join(tmp, 'damaged');
    fs.cpSync(dir, copy, { recursive: true });
    fs.chmodSync(path.join(copy, 'data'), 0o755);
    fs.chmodSync(path.join(copy, 'data', 'samples.json'), 0o644);
    fs.appendFileSync(path.join(copy, 'data', 'samples.json'), '\n');
    const r = await svc.archive.restoreArchive(svc.db, copy, { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.tables).toEqual([]);
  });

  it('a database backup that carries an archived batch restores, and the restored records are still archived and read-only', async () => {
    const { createBackup, restoreBackup } = await import('../../src/server/backup');
    const made = await createBackup(t.db.pool, 'a long enough passphrase', tempDir('periodic-archive-bk'));
    const target = await scratchDb('archive-restore');
    const restored = await restoreBackup(made.file, 'a long enough passphrase', target.pool);
    expect(restored.countsMatch).toBe(true);
    expect(restored.chainIntact).toBe(true);
    const n = async (table: string) => (await target.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    expect(await n('archived_records')).toBe(5);
    expect(await n('archive_bundles')).toBe(1);
    await expect(target.pool.query("UPDATE samples SET state = 'Logged' WHERE id = $1", [a.sampleId])).rejects.toThrow(/archived and read-only/);
  });

  it('the dry-run restore check against the live database reports the bundle equals the records, and changes nothing', async () => {
    const r = await t.request.post(`/api/archive/bundles/${bundle.id}/restore-check`).set(H.qa);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.tables.every((x: any) => x.inserted === 0 && x.different === 0)).toBe(true);
  });


  it('legal hold: a class under hold cannot be flagged for purge (service and database), a release lifts it', async () => {
    const sign = { password: 'password', reason: 'Litigation hold from Legal' };
    const place = await t.request.post('/api/retention/holds').set(H.qa).send({ recordClass: 'sample-records', ...sign });
    expect(place.status).toBe(201);
    expect(place.body.signature.meaningCode).toBe('LEGAL_HOLD');
    const hold = place.body.result;

    // make the sample "eligible": a 1 year policy and an archive date 2 years back would need a rewrite of the sidecar (append-only),
    // so eligibility is exercised by moving the clock instead
    const policy = await t.request.put('/api/retention/policies/sample-records').set(H.qa).send({ retentionYears: 1, basis: 'Test decision, not a regulatory number', expectedVersion: 0, reason: 'Test decision', password: 'password' });
    expect(policy.status).toBe(200);
    const future = new Date(Date.now() + 2 * 365 * 86_400_000);

    const blocked = await svc.retention.flagForPurge(svc.db, 'usr-qa', { entityType: 'Sample', entityId: a.sampleId, reason: 'Retention expired' }, future).catch((e: any) => e);
    expect(blocked.status).toBe(423);
    expect(blocked.code).toBe('LEGAL_HOLD');
    expect(await svc.retention.purgeCandidates(svc.db, future)).toEqual([]); // under hold: not even a candidate
    await expect(sql("INSERT INTO retention_flags (id, record_class, entity_type, entity_id, reason, flagged_by) VALUES ('rf-direct', 'sample-records', 'Sample', $1, 'direct insert', 'usr-qa')", [a.sampleId]))
      .rejects.toThrow(/under legal hold/);
    const early = await t.request.post('/api/retention/flags').set(H.qa).send({ entityType: 'Sample', entityId: a.sampleId, reason: 'Retention expired' });
    expect(early.status).toBe(423); // the live clock: the hold answers before the retention does

    const release = await t.request.post(`/api/retention/holds/${hold.id}/release`).set(H.qa).send({ ...sign, reason: 'Litigation closed', expectedVersion: hold.version });
    expect(release.status).toBe(200);
    expect(release.body.result.status).toBe('Released');
    expect((await t.request.post(`/api/retention/holds/${hold.id}/release`).set(H.qa).send({ ...sign, reason: 'again', expectedVersion: 2 })).status).toBe(409);

    const early2 = await t.request.post('/api/retention/flags').set(H.qa).send({ entityType: 'Sample', entityId: a.sampleId, reason: 'Retention expired' });
    expect(early2.status).toBe(409);
    expect(early2.body.code).toBe('RETENTION_NOT_EXPIRED'); // one year from today has not passed
    const flagged = await svc.retention.flagForPurge(svc.db, 'usr-qa', { entityType: 'Sample', entityId: a.sampleId, reason: 'Retention expired' }, future);
    expect(flagged.status).toBe('Flagged');
    // a flag is a flag: the record is still there and still read-only
    expect((await one('SELECT count(*)::int AS n FROM samples WHERE id = $1', [a.sampleId])).n).toBe(1);
    const second = await t.request.post(`/api/retention/holds`).set(H.qa).send({ recordClass: 'sample-records', ...sign });
    expect(second.status).toBe(201);
  });

  it('nothing deletes or rewrites the archive register, the holds or the reviews', async () => {
    await expect(sql('DELETE FROM archived_records')).rejects.toThrow(/append-only/);
    await expect(sql("UPDATE archived_records SET archived_by = 'usr-qa'")).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM archive_bundles')).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM legal_holds')).rejects.toThrow(/append-only/);
    await expect(sql('DELETE FROM periodic_reviews')).rejects.toThrow(/append-only/);
  });
});
