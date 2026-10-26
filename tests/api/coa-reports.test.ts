/**
 * Roadmap M25 (r2-coa-reports): the controlled Certificate of Analysis, through the real application, the real queue and PostgreSQL.
 *
 *   POST /coa/:sampleId              issue: Approved sample, every Approved guard and release blocker clear (else 409), signed
 *                                     COA_AUTHORISATION bound to the document version; number COA-<year>-<n> from a gap-free counter
 *   POST /coa/documents/:id/reissue  the next issue version (COA-...-v2); the current one becomes Superseded with the reason, in the
 *                                     same transaction as the signature and the audit entries
 *   POST /coa/documents/:id/void     signed withdrawal (COA_VOID, reason required)
 *   POST /coa/documents/:id/copies   a numbered controlled copy, made by a job; the original is copy 1, made by the issuing job
 *   GET  /reports/runs/:id/pdf       the stored bytes (only for the person the copy was made for), each delivery in the print log
 *   GET  /reports/runs/:id/verify    the stored bytes against their sha256, the snapshot against its hash, the signature
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

let t: TestApp;
let runner: { stop(): Promise<void> };
const H: Record<string, { Authorization: string }> = {};

beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['qa', 'admin', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
  const { db } = await import('../../src/db/index');
  const { startRunner } = await import('../../src/server/jobs/runner');
  const { defaultHandlers } = await import('../../src/server/jobs/handlers');
  const { REPORT_HANDLERS } = await import('../../src/server/reports');
  runner = startRunner({ db, pollMs: 25, sweepMs: 1000, heartbeatMs: 200, leaseSeconds: 30, handlers: { ...defaultHandlers(), ...REPORT_HANDLERS } });
});
afterAll(async () => { await runner?.stop(); });

const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The text of a PDF as written in its (uncompressed) content streams; PDF string syntax escapes parentheses and backslashes. */
const pdfText = (b: Buffer) => b.toString('latin1').replace(/\\([()\\])/g, '$1');
const binary = (req: any) => req.buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

interface Param { name: string; unit: string; limit_kind: string; lower: number | null; upper: number | null; decimals: number | null; text: string | null }
const ASSAY: Param = { name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null };
const WATER: Param = { name: 'Water content', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2, text: null };
const APPEARANCE: Param = { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White crystalline powder' };

/**
 * A sample registered through the API, its results entered through the API (so they have their recorded versions), then moved to
 * `state` in SQL (the sample lifecycle is tested elsewhere). `values` by parameter name.
 */
async function sample(values: Record<string, string>, o: { state?: string; params?: Param[]; batch?: string } = {}) {
  const material = uniq('Paracetamol');
  await insertActiveSpec(t, material, (o.params ?? [ASSAY, WATER, APPEARANCE]) as any);
  const batch = o.batch ?? uniq('B');
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [id]);
  for (const [parameter, value] of Object.entries(values)) await enter(id, parameter, value);
  await sql('UPDATE samples SET state = $2 WHERE id = $1', [id, o.state ?? 'Approved']);
  return { id, batch, material };
}

async function enter(sampleId: string, parameter: string, value: string, extra: Record<string, unknown> = {}) {
  const [r] = await sql('SELECT id, version FROM results WHERE sample_id = $1 AND parameter = $2', [sampleId, parameter]);
  const res = await t.request.put(`/api/samples/${sampleId}/results/${r.id}`).set(H.analyst1)
    .send({ value, reason: 'Recorded from the worksheet', expectedVersion: r.version, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const PASS = { Assay: '99.4', 'Water content': '0.21', Appearance: 'Complies' };
const issue = (sampleId: string, body: Record<string, unknown> = {}, who = 'qa') =>
  t.request.post(`/api/coa/${encodeURIComponent(sampleId)}`).set(H[who]).send({ password: 'password', ...body });
const reissue = (documentId: string, body: Record<string, unknown>, who = 'qa') =>
  t.request.post(`/api/coa/documents/${documentId}/reissue`).set(H[who]).send({ password: 'password', ...body });

async function finished(jobId: string, who = 'qa') {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await t.request.get(`/api/reports/status/${jobId}`).set(H[who]);
    if (r.body.status === 'completed' || r.body.status === 'failed' || Date.now() > end) return r.body;
    await new Promise(res => setTimeout(res, 40));
  }
}

/** Issues a CoA for `sampleId` and waits for the original PDF. */
async function issued(sampleId: string) {
  const res = await issue(sampleId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await finished(res.body.jobId)).status).toBe('completed');
  const [doc] = await sql('SELECT * FROM coa_documents WHERE id = $1', [res.body.document.id]);
  const [run] = await sql(`SELECT * FROM report_runs WHERE document_id = $1 AND purpose = 'Original'`, [doc.id]);
  return { res, doc, run, text: pdfText(Buffer.from(run.pdf)) };
}

describe('issuing a CoA', () => {
  it.each(['Logged', 'Testing', 'Pending Review', 'Rejected'])('answers 409 for a sample in %s, signs nothing, numbers nothing, costs no attempt', async (state) => {
    const s = await sample(state === 'Logged' ? {} : PASS, { state });
    const before = await sql(`SELECT value FROM counters WHERE key = $1`, [`coa:${new Date().getUTCFullYear()}`]);
    const res = await issue(s.id, { password: 'wrong-password' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SAMPLE_NOT_APPROVED');
    expect(await sql('SELECT count(*)::int AS n FROM coa_documents WHERE sample_id = $1', [s.id])).toEqual([{ n: 0 }]);
    expect(await sql(`SELECT value FROM counters WHERE key = $1`, [`coa:${new Date().getUTCFullYear()}`])).toEqual(before);
    expect((await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts).toBe(0);
  });

  it('answers 409 while an Approved guard fails (an OOS without a closed investigation) and names it', async () => {
    const s = await sample({ ...PASS, Assay: '95.0' });
    const res = await issue(s.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COA_BLOCKED');
    expect(res.body.error).toMatch(/OOS/);
    expect(res.body.details.map((d: any) => d.check)).toContain('no-open-oos');
  });

  it('answers 409 while a release blocker of the batch holds (an open, unclassified deviation about the batch)', async () => {
    const s = await sample(PASS);
    const dev = await t.request.post('/api/qms/records').set(H.analyst1).send({ type: 'Deviation', title: 'Balance drift during assay', description: 'Found at review' });
    expect(dev.status, JSON.stringify(dev.body)).toBe(200);
    const link = await t.request.post(`/api/qms/records/${dev.body.id}/links`).set(H.analyst1).send({ relation: 'related', targetType: 'Batch', targetId: s.batch });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const res = await issue(s.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COA_BLOCKED');
    expect(res.body.error).toContain(dev.body.id);
  });

  it('issues an Approved sample: a job, a numbered signed document, and the stored PDF hashes to pdf_sha256', async () => {
    const s = await sample(PASS);
    const res = await issue(s.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.jobId).toMatch(/^job-[0-9a-f]{24}$/);
    const year = new Date().getUTCFullYear();
    expect(res.body.document).toMatchObject({ sampleId: s.id, issueVersion: 1, status: 'Issued' });
    expect(res.body.document.number).toMatch(new RegExp(`^COA-${year}-\\d{4,}$`));
    expect(res.body.document.label).toBe(`${res.body.document.number}-v1`);

    const job = await finished(res.body.jobId);
    expect(job.status, JSON.stringify(job)).toBe('completed');
    const [doc] = await sql('SELECT * FROM coa_documents WHERE id = $1', [res.body.document.id]);
    const [run] = await sql('SELECT * FROM report_runs WHERE document_id = $1', [doc.id]);
    expect(run).toMatchObject({ copy_no: 1, purpose: 'Original', document_status: 'Issued', generated_by: 'usr-qa', report_type: 'CoA' });
    const bytes = Buffer.from(run.pdf);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sha(bytes)).toBe(run.pdf_sha256);
    expect(doc.pdf_sha256).toBe(run.pdf_sha256);
    expect(doc.original_run_id).toBe(run.id);
    expect(Number(run.bytes)).toBe(bytes.length);

    // the signature: catalog meaning, bound to the version the issue produced (1; recording the PDF hash afterwards made it 2), verifies
    const [sig] = await sql(`SELECT * FROM signatures WHERE entity_type = 'CoaDocument' AND entity_id = $1`, [doc.id]);
    expect(sig).toMatchObject({ meaning_code: 'COA_AUTHORISATION', signer_id: 'usr-qa', record_version: 1, sample_id: s.id });
    expect(doc.version).toBe(2);
    expect(sig.meaning).toMatch(/^Authorisation of Certificate of Analysis/);
    const v = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(v.body).toMatchObject({ valid: true, status: 'valid' });
    // the audit entry of the issue, and the snapshot hash
    const audit = await sql(`SELECT action, new_value, user_id FROM audit_trail WHERE entity = 'CoaDocument' AND entity_id = $1 ORDER BY sequence`, [doc.id]);
    expect(audit[0]).toMatchObject({ action: 'Issue', new_value: 'Issued', user_id: 'usr-qa' });
    expect(audit.map((a: any) => a.action)).toContain('Render');
    const { canonicalJson } = await import('../../src/server/esign/hash');
    expect(createHash('sha256').update(canonicalJson(doc.snapshot)).digest('hex')).toBe(doc.snapshot_sha256);
  });

  it('prints what the snapshot holds: number, spec revision, method, spec text, result, unit, conclusion, batch dates, signature block', async () => {
    const material = uniq('Ibuprofen');
    await sql(`INSERT INTO methods (id, code, title, revision, status) VALUES ($1, $2, 'HPLC assay', 3, 'Effective')`, [uniq('mth'), `HPLC-${process.pid}`]);
    await insertActiveSpec(t, material, [{ ...ASSAY, method_code: `HPLC-${process.pid}` }, WATER, APPEARANCE] as any);
    const batch = uniq('B');
    const product = uniq('prd');
    await sql(`INSERT INTO products (id, code, name) VALUES ($1, $1, $2)`, [product, material]);
    await sql(`INSERT INTO product_batches (id, product_id, batch_no, manufactured_on, expires_on) VALUES ($1, $2, $3, '2026-03-01', '2028-02-29')`, [uniq('pb'), product, batch]);
    const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [created.body.id]);
    for (const [p, v] of Object.entries(PASS)) await enter(created.body.id, p, v);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [created.body.id]);

    const { doc, text } = await issued(created.body.id);
    expect(text).toContain(doc.label);
    expect(text).toMatch(/Rev(ision)?\.? ?1/);
    expect(text).toContain(`HPLC-${process.pid}`);
    expect(text).toContain('NLT 98.0 %');
    expect(text).toContain('NMT 0.50 %');
    expect(text).toContain('White crystalline powder');
    expect(text).toContain('99.4');
    expect(text).toContain('Complies');
    expect(text).not.toContain('Does not comply');
    expect(text).toContain('2026-03-01');
    expect(text).toContain('2028-02-29');
    expect(text).toContain('Test QA Officer');
    expect(text).toContain('Authorisation of Certificate of Analysis');
    expect(text).toMatch(/UTC/);
    expect(text).not.toMatch(/null - null|undefined|\(null\)|Official/);
    expect(doc.snapshot.results.find((r: any) => r.parameter === 'Assay').method).toMatchObject({ code: `HPLC-${process.pid}`, revision: 3 });
    expect(doc.snapshot.batch).toMatchObject({ manufacturedOn: '2026-03-01', expiresOn: '2028-02-29' });
  });

  it('an OOS result with a closed investigation prints "Does not comply", never ALL TESTS PASSED', async () => {
    const s = await sample(PASS);
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [s.id]);
    const [r] = await sql(`SELECT id, version FROM results WHERE sample_id = $1 AND parameter = 'Assay'`, [s.id]);
    await t.request.put(`/api/samples/${s.id}/results/${r.id}`).set(H.analyst1).send({ value: '96.0', reason: 'Re-read the worksheet', expectedVersion: r.version, reasonCode: 'TRANSCRIPTION_ERROR' }).expect(200);
    await sql(`UPDATE oos_investigations SET status = 'Closed', decision = 'Confirmed OOS' WHERE result_id = $1`, [r.id]);
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [s.id]);

    const { doc, text } = await issued(s.id);
    expect(text).toContain('Does not comply');
    expect(text).not.toContain('ALL TESTS PASSED');
    expect(text).not.toMatch(/complies with (the )?specification/i);
    expect(doc.snapshot.conclusion.complies).toBe(false);
    expect(doc.snapshot.results.find((x: any) => x.parameter === 'Assay')).toMatchObject({ conclusion: 'Does not comply', isOos: true });
  });

  it('marks a corrected value AMENDED(n) with its reason, and an invalidated OOS value as the original row next to its retest', async () => {
    const s = await sample({ ...PASS, Assay: '95.1' });
    await sql(`UPDATE samples SET state = 'Testing' WHERE id = $1`, [s.id]);
    const [oos] = await sql(`SELECT o.id FROM oos_investigations o JOIN results r ON r.id = o.result_id WHERE r.sample_id = $1`, [s.id]);
    await enter(s.id, 'Assay', '99.2', { oosId: oos.id, reasonCode: 'SAMPLE_PREPARATION_ERROR', reason: 'Dilution error; retested on a new preparation' });
    await sql(`UPDATE oos_investigations SET status = 'Closed', decision = 'Invalidated' WHERE id = $1`, [oos.id]);
    await enter(s.id, 'Water content', '0.23', { reasonCode: 'TRANSCRIPTION_ERROR', reason: 'Digits swapped when typing' });
    await sql(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [s.id]);

    const { doc, text } = await issued(s.id);
    expect(text).toContain('AMENDED(1)');
    expect(text).toContain('Digits swapped when typing');
    expect(text).toContain('95.1');
    expect(text).toContain('Retest');
    expect(text).toContain(oos.id);
    const assay = doc.snapshot.results.filter((x: any) => x.parameter === 'Assay');
    expect(assay.map((x: any) => x.kind)).toEqual(['Original', 'Retest']);
    expect(assay[0]).toMatchObject({ value: '95.1', reported: false });
    expect(assay[1]).toMatchObject({ value: '99.2', reported: true, conclusion: 'Complies' });
    expect(doc.snapshot.conclusion.complies).toBe(true);
  });

  it('only the quality unit issues (403 for an Analyst), and not someone who entered results of the sample', async () => {
    const s = await sample(PASS);
    expect((await issue(s.id, {}, 'analyst2')).status).toBe(403);
    await sql(`UPDATE results SET entered_by = 'usr-qa' WHERE sample_id = $1 AND parameter = 'Assay'`, [s.id]);
    const res = await issue(s.id, {}, 'qa');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect((await issue(s.id, {}, 'admin')).status).toBe(200);
  });

  it('a wrong password is 401, counted, and nothing is issued; unknown keys are 400', async () => {
    const s = await sample(PASS);
    expect((await issue(s.id, { password: 'nope' })).status).toBe(401);
    expect((await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts).toBe(1);
    await sql(`UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-qa'`);
    expect(await sql('SELECT count(*)::int AS n FROM coa_documents WHERE sample_id = $1', [s.id])).toEqual([{ n: 0 }]);
    expect((await issue(s.id, { status: 'Issued' })).status).toBe(400);
    expect((await issue(s.id, { meaning: 'Approved by me' })).status).toBe(400);
    expect((await issue(s.id, { number: 'COA-1999-0001' })).status).toBe(400);
  });

  it('a second issue of the same sample is 409 COA_ALREADY_ISSUED (re-issue is its own signed step)', async () => {
    const s = await sample(PASS);
    await issued(s.id);
    const res = await issue(s.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COA_ALREADY_ISSUED');
  });

  it('two simultaneous issues produce consecutive numbers, no gap and no duplicate; the same sample twice gives one CoA', async () => {
    const a = await sample(PASS), b = await sample(PASS), c = await sample(PASS);
    const year = new Date().getUTCFullYear();
    const [r1, r2, ...same] = await Promise.all([issue(a.id), issue(b.id), ...[1, 2, 3, 4, 5].map(() => issue(c.id))]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(same.map(r => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    for (const r of same.filter(x => x.status === 409)) expect(r.body.code).toBe('COA_ALREADY_ISSUED');
    const numbers = (await sql(`SELECT number FROM coa_documents WHERE sample_id = ANY($1)`, [[a.id, b.id, c.id]])).map((r: any) => Number(r.number.split('-')[2])).sort((x: number, y: number) => x - y);
    expect(numbers).toHaveLength(3);
    expect(numbers[1] - numbers[0]).toBe(1);
    expect(numbers[2] - numbers[1]).toBe(1);
    const [{ value }] = await sql(`SELECT value FROM counters WHERE key = $1`, [`coa:${year}`]);
    expect(Number(value)).toBe(numbers[2]);
    expect(await sql(`SELECT count(*)::int AS n FROM coa_documents WHERE sample_id = $1`, [c.id])).toEqual([{ n: 1 }]);
  });
});

describe('re-issue and void', () => {
  it('re-issue gives COA-...-v2 and supersedes v1 with the reason, in one transaction with the signature and the audit entries', async () => {
    const s = await sample(PASS);
    const { doc: v1 } = await issued(s.id);
    expect((await reissue(v1.id, { expectedVersion: v1.version })).status).toBe(400);              // a reason is required
    const res = await reissue(v1.id, { expectedVersion: v1.version, reason: 'Customer name corrected on the order' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.document).toMatchObject({ number: v1.number, issueVersion: 2, label: `${v1.number}-v2`, status: 'Issued', supersedesId: v1.id });
    const [old] = await sql('SELECT * FROM coa_documents WHERE id = $1', [v1.id]);
    expect(old).toMatchObject({ status: 'Superseded', superseded_by_id: res.body.document.id, superseded_reason: 'Customer name corrected on the order' });
    expect(old.version).toBe(v1.version + 1);

    // one transaction: the new document, its signature, the issue and the supersede entries all exist and share the commit
    const [sig] = await sql(`SELECT * FROM signatures WHERE entity_type = 'CoaDocument' AND entity_id = $1`, [res.body.document.id]);
    expect(sig).toMatchObject({ meaning_code: 'COA_AUTHORISATION', reason: 'Customer name corrected on the order' });
    const supersede = await sql(`SELECT action, old_value, new_value, reason FROM audit_trail WHERE entity = 'CoaDocument' AND entity_id = $1 AND action = 'Supersede'`, [v1.id]);
    expect(supersede).toEqual([{ action: 'Supersede', old_value: 'Issued', new_value: 'Superseded', reason: 'Customer name corrected on the order' }]);
    const xmin = await sql(`SELECT (SELECT xmin::text FROM coa_documents WHERE id = $1) AS a, (SELECT xmin::text FROM coa_documents WHERE id = $2) AS b, (SELECT xmin::text FROM signatures WHERE id = $3) AS c`, [v1.id, res.body.document.id, sig.id]);
    expect(new Set(Object.values(xmin[0])).size).toBe(1);

    // the first signature still verifies after its document was superseded
    const [sig1] = await sql(`SELECT id FROM signatures WHERE entity_type = 'CoaDocument' AND entity_id = $1`, [v1.id]);
    expect((await t.request.get(`/api/signatures/verify/${sig1.id}`).set(H.qa)).body).toMatchObject({ valid: true });

    // a stale version is 409 and changes nothing; re-issuing from v1 again is 409
    const stale = await reissue(v1.id, { expectedVersion: v1.version, reason: 'Second attempt from a stale screen' });
    expect(stale.status).toBe(409);
    expect(await sql(`SELECT count(*)::int AS n FROM coa_documents WHERE sample_id = $1`, [s.id])).toEqual([{ n: 2 }]);
  });

  it('two simultaneous re-issues of the same version: one wins, no number or version is used twice', async () => {
    const s = await sample(PASS);
    const { doc } = await issued(s.id);
    const [a, b] = await Promise.all([
      reissue(doc.id, { expectedVersion: doc.version, reason: 'Race one: corrected address' }),
      reissue(doc.id, { expectedVersion: doc.version, reason: 'Race two: corrected address' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await sql(`SELECT issue_version FROM coa_documents WHERE sample_id = $1 ORDER BY issue_version`, [s.id])).map((r: any) => r.issue_version)).toEqual([1, 2]);
  });

  it('void needs a reason and the quality unit; a voided CoA cannot be re-issued and its copies say VOID', async () => {
    const s = await sample(PASS);
    const { doc } = await issued(s.id);
    const voidIt = (who: string, body: Record<string, unknown>) => t.request.post(`/api/coa/documents/${doc.id}/void`).set(H[who]).send({ password: 'password', expectedVersion: doc.version, ...body });
    expect((await voidIt('qa', {})).status).toBe(400);
    expect((await voidIt('analyst1', { reason: 'Issued against the wrong order' })).status).toBe(403);
    const res = await voidIt('qa', { reason: 'Issued against the wrong order' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.document).toMatchObject({ status: 'Voided', voidReason: 'Issued against the wrong order' });
    const [sig] = await sql(`SELECT meaning_code FROM signatures WHERE entity_type = 'CoaDocument' AND entity_id = $1 ORDER BY timestamp DESC LIMIT 1`, [doc.id]);
    expect(sig.meaning_code).toBe('COA_VOID');
    expect((await reissue(doc.id, { expectedVersion: res.body.document.version, reason: 'Trying to revive it' })).status).toBe(409);

    const copy = await t.request.post(`/api/coa/documents/${doc.id}/copies`).set(H.analyst2).send({});
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    const job = await finished(copy.body.jobId, 'analyst2');
    expect(job.status).toBe('completed');
    const [run] = await sql(`SELECT * FROM report_runs WHERE document_id = $1 AND copy_no = 2`, [doc.id]);
    expect(run).toMatchObject({ purpose: 'Copy', document_status: 'Voided', watermark: 'VOID', generated_by: 'usr-analyst2' });
    expect(pdfText(Buffer.from(run.pdf))).toContain('VOID');
  });
});

describe('controlled copies, print log and verification', () => {
  it('copies are numbered without gaps; only the person a copy was made for downloads it, and every download is logged', async () => {
    const s = await sample(PASS);
    const { doc, run: original } = await issued(s.id);
    const jobs = await Promise.all([1, 2, 3].map(() => t.request.post(`/api/coa/documents/${doc.id}/copies`).set(H.analyst1).send({})));
    for (const j of jobs) expect((await finished(j.body.jobId, 'analyst1')).status).toBe('completed');
    const runs = await sql(`SELECT id, copy_no, purpose FROM report_runs WHERE document_id = $1 ORDER BY copy_no`, [doc.id]);
    expect(runs.map((r: any) => r.copy_no)).toEqual([1, 2, 3, 4]);
    expect(runs[0].id).toBe(original.id);

    const mine = runs[3].id;
    const got = await binary(t.request.get(`/api/reports/runs/${mine}/pdf`).set(H.analyst1));
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/application\/pdf/);
    expect(got.headers['x-content-sha256']).toBe(sha(got.body));
    expect(pdfText(Buffer.from(got.body))).toContain('Copy 4');
    expect((await binary(t.request.get(`/api/reports/runs/${mine}/pdf`).set(H.analyst2))).status).toBe(403);
    expect(await sql(`SELECT printed_by, action FROM report_print_log WHERE run_id = $1`, [mine])).toEqual([{ printed_by: 'usr-analyst1', action: 'Download' }]);

    const meta = await t.request.get(`/api/reports/runs/${mine}`).set(H.qa);
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ id: mine, copyNo: 4, documentLabel: doc.label, generatedBy: 'usr-analyst1' });
    expect(meta.body.prints).toHaveLength(1);
    expect(JSON.stringify(meta.body)).not.toMatch(/JVBER/);   // metadata never carries the bytes
  });

  it('verify is valid for an untouched run, and a one-byte change to the stored report fails it', async () => {
    const s = await sample(PASS);
    const { run } = await issued(s.id);
    const ok = await t.request.get(`/api/reports/runs/${run.id}/verify`).set(H.reviewer);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true, checks: { pdfHash: true, snapshotHash: true, signature: 'valid' } });

    // A database owner edits one byte; the guard trigger must be switched off to do it, which is the point of the test.
    const client = await t.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE report_runs DISABLE TRIGGER USER');
      await client.query(`UPDATE report_runs SET pdf = overlay(pdf placing '\\x41'::bytea from 200 for 1) WHERE id = $1`, [run.id]);
      await client.query('ALTER TABLE report_runs ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } finally { client.release(); }
    const bad = await t.request.get(`/api/reports/runs/${run.id}/verify`).set(H.reviewer);
    expect(bad.status).toBe(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.checks.pdfHash).toBe(false);
    // and the tampered bytes are not handed out as the record
    const dl = await binary(t.request.get(`/api/reports/runs/${run.id}/pdf`).set(H.qa));
    expect(dl.status).toBe(500);
    expect(dl.body.toString()).toMatch(/REPORT_CORRUPT/);
  });

  it('a changed snapshot fails verify even when the PDF bytes are untouched', async () => {
    const s = await sample(PASS);
    const { doc, run } = await issued(s.id);
    const client = await t.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE coa_documents DISABLE TRIGGER USER');
      await client.query(`UPDATE coa_documents SET snapshot = jsonb_set(snapshot, '{conclusion,complies}', 'false') WHERE id = $1`, [doc.id]);
      await client.query('ALTER TABLE coa_documents ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } finally { client.release(); }
    const res = await t.request.get(`/api/reports/runs/${run.id}/verify`).set(H.qa);
    expect(res.body).toMatchObject({ valid: false, checks: { pdfHash: true, snapshotHash: false } });
  });

  it('the register: documents of a sample with what blocks a new issue, and the batch register', async () => {
    const s = await sample(PASS);
    const before = await t.request.get(`/api/coa/${s.id}`).set(H.analyst1);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ sampleId: s.id, eligible: true, problems: [], current: null, documents: [] });
    const { doc } = await issued(s.id);
    const after = await t.request.get(`/api/coa/${s.id}`).set(H.analyst1);
    expect(after.body.current).toMatchObject({ id: doc.id, label: doc.label, status: 'Issued' });
    expect(after.body.current.signatures[0]).toMatchObject({ meaningCode: 'COA_AUTHORISATION', signerName: 'Test QA Officer', signerRole: 'QA' });
    const list = await t.request.get(`/api/coa/documents?batch=${encodeURIComponent(s.batch)}`).set(H.analyst1);
    expect(list.status).toBe(200);
    expect(list.body.map((d: any) => d.label)).toEqual([doc.label]);
    expect(JSON.stringify(list.body)).not.toMatch(/JVBER/);
    const one = await t.request.get(`/api/coa/documents/${doc.id}`).set(H.analyst1);
    expect(one.body).toMatchObject({ id: doc.id, runs: [{ copyNo: 1, purpose: 'Original' }] });
    const testing = await sample(PASS, { state: 'Testing' });
    const blocked = await t.request.get(`/api/coa/${testing.id}`).set(H.analyst1);
    expect(blocked.body).toMatchObject({ eligible: false });
    expect(blocked.body.problems[0].check).toBe('state');
  });
});
