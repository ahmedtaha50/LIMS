/**
 * CoA PDF jobs (roadmap M15 hotfixes and acceptance), through the real Express application and the real queue.
 *
 *  - a PDF request for a sample that is not Approved is refused (409), so no 'Official' CoA is minted for a sample under test;
 *  - a job belongs to the user who asked for it: another user gets 403 on its status and on its artifact (it used to be
 *    a base64 PDF readable by anyone who guessed a Math.random id);
 *  - the PDF is stored as a file (checksum recorded), kept 30 days, then removed;
 *  - generating it is audited.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';
import { tempDir } from '../upgrade/helpers';

let t: TestApp;
let db: any;
let runnerMod: typeof import('../../src/server/jobs/runner');
let artifacts: typeof import('../../src/server/jobs/artifacts');
let queue: typeof import('../../src/server/jobs/queue');
let runner: import('../../src/server/jobs/runner').Runner;
let artifactDir: string;

beforeAll(async () => {
  artifactDir = tempDir('bplims-artifacts');
  process.env.ARTIFACT_DIR = artifactDir;
  t = await startTestApp();
  ({ db } = await import('../../src/db/index'));
  runnerMod = await import('../../src/server/jobs/runner');
  artifacts = await import('../../src/server/jobs/artifacts');
  queue = await import('../../src/server/jobs/queue');
  runner = runnerMod.startRunner({ db, pollMs: 25, sweepMs: 500, heartbeatMs: 200, leaseSeconds: 30 });
});
afterAll(async () => { await runner?.stop(); });

async function sample(state: string, results: Array<{ parameter: string; value: string | null; min: number | null; max: number | null; oos?: boolean }> = [{ parameter: 'Assay (%)', value: '99.5', min: 98, max: 102 }]) {
  const id = uniq('SMP-PDF');
  await t.db.pool.query(`insert into samples (id, material, batch, state, created_by) values ($1, 'Paracetamol', 'B-77', $2, 'usr-analyst1')`, [id, state]);
  for (const [i, r] of results.entries()) {
    await t.db.pool.query(`insert into results (id, sample_id, parameter, value, spec_min, spec_max, is_oos, entered_by, entered_at) values ($1, $2, $3, $4, $5, $6, $7, 'usr-analyst1', now())`,
      [`${id}-R${i}`, id, r.parameter, r.value, r.min, r.max, r.oos ?? false]);
  }
  return id;
}
// The auth header is built before the supertest request object exists (see tests/helpers/app.ts).
const generate = async (who: string, body: unknown) => { const h = await t.auth(who); return t.request.post('/api/reports/generate').set(h).send(body as object); };
const status = async (who: string, jobId: string) => { const h = await t.auth(who); return t.request.get(`/api/reports/status/${jobId}`).set(h); };
const artifact = async (who: string, jobId: string) => {
  const h = await t.auth(who);
  return t.request.get(`/api/reports/artifact/${jobId}`).set(h).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
};
async function completed(who: string, jobId: string) {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await status(who, jobId);
    if (r.body.status === 'completed' || r.body.status === 'failed' || Date.now() > end) return r;
    await new Promise(res => setTimeout(res, 50));
  }
}

describe('POST /reports/generate', () => {
  it.each(['Logged', 'Testing', 'Pending Review', 'Rejected'])('answers 409 for a sample in state %s and queues nothing', async (state) => {
    const id = await sample(state);
    const before = (await t.db.pool.query(`select count(*)::int as n from jobs where type = 'generate_gxp_pdf'`)).rows[0].n;
    const res = await generate('analyst1@gxp.com', { sampleId: id });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SAMPLE_NOT_APPROVED' });
    expect(res.body.error).toMatch(/Approved/);
    expect((await t.db.pool.query(`select count(*)::int as n from jobs where type = 'generate_gxp_pdf'`)).rows[0].n).toBe(before);
  });

  it('answers 404 for an unknown sample and 400 for a malformed body (strict schema)', async () => {
    expect((await generate('analyst1@gxp.com', { sampleId: 'SMP-NOPE' })).status).toBe(404);
    expect((await generate('analyst1@gxp.com', {})).status).toBe(400);
    expect((await generate('analyst1@gxp.com', { sampleId: 42 })).status).toBe(400);
    expect((await generate('analyst1@gxp.com', { sampleId: 'x', status: 'Official' })).status).toBe(400);
    expect((await t.request.post('/api/reports/generate').send({ sampleId: 'x' })).status).toBe(401);
  });

  it('queues a job for an Approved sample, owned by the requester, and the PDF is stored as a file with its checksum', async () => {
    const id = await sample('Approved');
    const res = await generate('analyst1@gxp.com', { sampleId: id });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toMatch(/^job-[0-9a-f]{24}$/);
    const row = (await t.db.pool.query('select * from jobs where id = $1', [res.body.jobId])).rows[0];
    expect(row).toMatchObject({ type: 'generate_gxp_pdf', created_by: 'usr-analyst1' });

    const done = await completed('analyst1@gxp.com', res.body.jobId);
    expect(done.body.status).toBe('completed');
    expect(done.body.result).toMatch(/^data:application\/pdf/);       // the shape SampleDetail.tsx already consumes

    const job = (await t.db.pool.query('select * from jobs where id = $1', [res.body.jobId])).rows[0];
    expect(job.artifact_name).toMatch(/^[0-9a-f-]+\.pdf$/);
    expect(job.result).not.toMatch(/JVBER|data:application/);        // no base64 PDF in the database any more
    const file = path.join(artifactDir, job.artifact_name);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(job.artifact_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Number(job.artifact_bytes)).toBe(bytes.length);
    const days = (new Date(job.artifact_expires_at).getTime() - new Date(job.finished_at).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 1);

    const audit = (await t.db.pool.query(`select user_id, reason, new_value from audit_trail where entity = 'CertificateOfAnalysis' and entity_id = $1`, [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe('usr-analyst1');
    expect(audit[0].new_value).toContain(job.artifact_sha256);
  });
});

describe('who may read a job', () => {
  let jobId: string;
  beforeAll(async () => {
    const id = await sample('Approved');
    jobId = (await generate('analyst1@gxp.com', { sampleId: id })).body.jobId;
    await completed('analyst1@gxp.com', jobId);
  });

  it('the owner gets the status and the PDF', async () => {
    const res = await artifact('analyst1@gxp.com', jobId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('user B gets 403 on user A\'s status and artifact, and learns nothing from the answer', async () => {
    for (const who of ['analyst2@gxp.com', 'qa@gxp.com', 'admin@gxp.com']) {
      const s = await status(who, jobId);
      expect(s.status, `${who} status`).toBe(403);
      expect(JSON.stringify(s.body)).not.toMatch(/JVBER|data:application|artifact/i);
      const a = await artifact(who, jobId);
      expect(a.status, `${who} artifact`).toBe(403);
    }
  });

  it('answers 404 for a job that does not exist and 401 without a token', async () => {
    expect((await status('analyst1@gxp.com', 'job-000000000000000000000000')).status).toBe(404);
    expect((await t.request.get(`/api/reports/status/${jobId}`)).status).toBe(401);
    expect((await t.request.get(`/api/reports/artifact/${jobId}`)).status).toBe(401);
  });
});

describe('the PDF itself', () => {
  const textOf = async (jobId: string) => ((await artifact('analyst1@gxp.com', jobId)).body as Buffer).toString('latin1');

  it('says Approved, not "Official (System Generated)", prints OOS results as OOS and text specifications without "null - null"', async () => {
    const id = await sample('Approved', [
      { parameter: 'Assay (%)', value: '99.5', min: 98, max: 102 },
      { parameter: 'Dissolution', value: '61', min: 80, max: null, oos: true },
      { parameter: 'Appearance', value: 'White powder', min: null, max: null },
    ]);
    const jobId = (await generate('analyst1@gxp.com', { sampleId: id })).body.jobId;
    expect((await completed('analyst1@gxp.com', jobId)).body.status).toBe('completed');
    const pdf = await textOf(jobId);
    expect(pdf).toContain('Status: Approved');
    expect(pdf).not.toContain('Official (System Generated)');
    expect(pdf).not.toContain('null - null');
    expect(pdf).not.toMatch(/\(null\)|undefined/);
    expect(pdf).toContain('Appearance');
    expect(pdf).toMatch(/OOS/);
    expect(pdf).not.toContain('ALL TESTS PASSED');
  });

  it('a job that reaches the worker for a sample that is not Approved fails and produces no document (the state may change between the request and the worker)', async () => {
    const id = await sample('Testing');
    const { id: jobId } = await queue.enqueue(db, { type: 'generate_gxp_pdf', payload: { sampleId: id }, createdBy: 'usr-analyst1' });
    const done = await completed('analyst1@gxp.com', jobId);
    expect(done.body.status).toBe('failed');
    expect(done.body.error).toMatch(/not Approved/);
    const row = (await t.db.pool.query('select * from jobs where id = $1', [jobId])).rows[0];
    expect(row).toMatchObject({ attempts: 1, artifact_name: null });
  });
});

describe('artifact retention', () => {
  it('removes the file after its expiry, keeps the job row, and answers 410 afterwards', async () => {
    const id = await sample('Approved');
    const jobId = (await generate('analyst1@gxp.com', { sampleId: id })).body.jobId;
    await completed('analyst1@gxp.com', jobId);
    const job = (await t.db.pool.query('select * from jobs where id = $1', [jobId])).rows[0];
    const file = path.join(artifactDir, job.artifact_name);
    expect(fs.existsSync(file)).toBe(true);

    expect(await artifacts.purgeExpiredArtifacts(db, new Date(Date.now() + 29 * 86_400_000))).toBe(0);      // day 29: still kept
    expect(fs.existsSync(file)).toBe(true);
    const purged = await artifacts.purgeExpiredArtifacts(db, new Date(Date.now() + 31 * 86_400_000));        // day 31
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(file)).toBe(false);
    const after = (await t.db.pool.query('select * from jobs where id = $1', [jobId])).rows[0];
    expect(after.status).toBe('completed');
    expect(after.artifact_purged_at).not.toBeNull();
    expect(after.artifact_sha256).toBe(job.artifact_sha256);                                                  // the record of what was issued stays
    expect((await artifact('analyst1@gxp.com', jobId)).status).toBe(410);
    expect((await status('analyst1@gxp.com', jobId)).body).toMatchObject({ status: 'completed', purged: true });
  });
});

describe('the browser-side report watermark (src/lib/pdfUtils.ts)', () => {
  const stamped = async (status?: string) => {
    const { jsPDF } = await import('jspdf');
    const { applyGxPTheme } = await import('../../src/lib/pdfUtils');
    const doc = new jsPDF();
    doc.text('body', 20, 60);
    if (status === undefined) applyGxPTheme(doc, 'Test report'); else applyGxPTheme(doc, 'Test report', status);
    return Buffer.from(doc.output('arraybuffer')).toString('latin1');
  };

  it('marks a document DRAFT when the caller does not say what state the record is in (it used to say Approved)', async () => {
    const pdf = await stamped();
    expect(pdf).toContain('Status: DRAFT');
    expect(pdf).not.toMatch(/APPROVED/);
  });

  it('prints the status it is given, and Rejected is not drawn like Approved', async () => {
    expect(await stamped('Approved')).toContain('Status: APPROVED');
    const rejected = await stamped('Rejected');
    expect(rejected).toContain('Status: REJECTED');
    expect(rejected).not.toMatch(/APPROVED/);
  });
});
