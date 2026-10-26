/**
 * Roadmap M07 (r1-esign), verification: GET /api/signatures/verify/:id recomputes what the signature was bound to.
 *
 * Signatures here are written by the signing routes as they are today, which have not moved to signRecord yet (they write
 * hash_version 1 rows with no entity binding), so this also proves that the old rows keep verifying and that tampering with the
 * record they signed is detected. Rows written by signRecord itself are checked in esign-sign.test.ts.
 *
 * Defects behind it: "Verify returns valid when the hash is null"; "Signatures with contentHash 'N/A' verify as valid"; the OOS
 * and ELN signatures were never recomputed at all, so altering the signed row in SQL changed nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { registerSample, uniq } from '../helpers/fixtures';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) await t.token(`${u}@gxp.com`);
});

const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params);
const verify = async (id: string, who = 'qa@gxp.com') => {
  const h = await t.auth(who);
  return t.request.get(`/api/signatures/verify/${id}`).set(h);
};
const sigOf = async (where: string, params: unknown[]) => (await sql(`SELECT id FROM signatures WHERE ${where} ORDER BY timestamp DESC LIMIT 1`, params)).rows[0].id as string;
/** Runs `fn` with the audit trail's own guard off (the superuser can), then puts it back. */
async function withAuditGuardOff<T>(fn: () => Promise<T>): Promise<T> {
  await sql('ALTER TABLE audit_trail DISABLE TRIGGER USER');
  try { return await fn(); } finally { await sql('ALTER TABLE audit_trail ENABLE TRIGGER USER'); }
}

async function signedSample() {
  const s = await registerSample(t);
  const analyst = await t.auth('analyst1@gxp.com');
  const sub = await t.request.post(`/api/samples/${s.id}/transition`).set(analyst).send({ action: 'submit', expectedVersion: s.version });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  // r1-results-oos: review needs every result entered.
  const ent = await t.request.put(`/api/samples/${s.id}/results/${s.result.id}`).set(analyst).send({ value: '100.0', reason: 'routine entry', expectedVersion: s.result.version });
  expect(ent.status, JSON.stringify(ent.body)).toBe(200);
  const rev = await t.request.post(`/api/samples/${s.id}/transition`).set(analyst).send({ action: 'review', expectedVersion: sub.body.version, password: 'password' });
  expect(rev.status, JSON.stringify(rev.body)).toBe(200);
  return { ...s, sigId: await sigOf('sample_id = $1', [s.id]) };
}

async function closedOos() {
  const s = await registerSample(t);
  const created = await t.request.post('/api/oos').set(await t.auth('analyst1@gxp.com'))
    .send({ sampleId: s.id, resultId: s.result.id, parameter: 'Assay (%)', dateRaised: '2026-01-02' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  // r2-oos-workflow: the decision is required, and Confirmed OOS follows the Phase II investigation.
  const qa = await t.auth('qa@gxp.com');
  const phase2 = await t.request.put(`/api/oos/${created.body.id}`).set(qa).send({ phase: 'Phase II', expectedVersion: 1 });
  expect(phase2.status, JSON.stringify(phase2.body)).toBe(200);
  const closed = await t.request.post(`/api/oos/${created.body.id}/close`).set(qa)
    .send({ rootCause: 'Analyst dilution error', conclusion: 'Retrain and repeat the test', decision: 'Confirmed OOS', password: 'password', expectedVersion: phase2.body.version });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return { oosId: created.body.id as string, sampleId: s.id, sigId: await sigOf("meaning LIKE 'OOS%' AND sample_id = $1", [s.id]) };
}

async function signedEln() {
  const h = await t.auth('analyst1@gxp.com');
  const created = await t.request.post('/api/eln').set(h).send({ title: uniq('Worksheet'), content: 'Weighed 10.00 g, titrated.' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  // The ELN signature is bound to the sample of the worksheet (the old route falls back to the worksheet id, which no sample has).
  const s = await registerSample(t);
  await t.request.put(`/api/eln/${created.body.id}`).set(h).send({ sampleId: s.id, expectedVersion: 1 });
  // r1-quality-fixes: the meaning is the server's (AUTHORSHIP); a meaning in the body is a 400.
  const signed = await t.request.post(`/api/eln/${created.body.id}/sign`).set(h).send({ password: 'password', reason: 'done' });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
  return { elnId: created.body.id as string, sigId: await sigOf("entity_type = 'LabNotebook' AND entity_id = $1", [created.body.id]) };
}

describe('GET /signatures/verify/:id', () => {
  it('requires authentication and answers 404 for a signature that does not exist', async () => {
    expect((await t.request.get('/api/signatures/verify/sig-nope')).status).toBe(401);
    const res = await verify('sig-nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  describe('a sample transition', () => {
    it('verifies, with the hash recomputed, and says so in a status', async () => {
      const s = await signedSample();
      const res = await verify(s.sigId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: true, contentHashMatches: true, chainIntact: true, status: 'valid', entityType: 'Sample', entityId: s.id });
    });

    it('is no longer valid once the sample row is changed in SQL', async () => {
      const s = await signedSample();
      await sql(`UPDATE samples SET material = 'Altered material' WHERE id = $1`, [s.id]);
      const res = await verify(s.sigId);
      expect(res.body).toMatchObject({ valid: false, contentHashMatches: false, status: 'record-modified' });
    });
  });

  describe('an OOS closure', () => {
    it('is recomputed from the investigation row: valid, hash matches (it used to be null, and null counted as valid)', async () => {
      const o = await closedOos();
      const res = await verify(o.sigId);
      expect(res.body).toMatchObject({ valid: true, contentHashMatches: true, status: 'valid', entityType: 'OOS', entityId: o.oosId });
    });

    it('returns valid=false, contentHashMatches=false when root cause or conclusion is altered in SQL (M07 acceptance)', async () => {
      const o = await closedOos();
      await sql(`UPDATE oos_investigations SET root_cause = 'Altered after signature' WHERE id = $1`, [o.oosId]);
      const res = await verify(o.sigId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: false, contentHashMatches: false, status: 'record-modified' });
    });
  });

  describe('an ELN signature', () => {
    it('is recomputed from the worksheet: valid, hash matches', async () => {
      const e = await signedEln();
      const res = await verify(e.sigId);
      expect(res.body).toMatchObject({ valid: true, contentHashMatches: true, status: 'valid', entityType: 'LabNotebook', entityId: e.elnId });
    });

    it('returns valid=false, contentHashMatches=false when the worksheet text is altered in SQL (M07 acceptance)', async () => {
      const e = await signedEln();
      await sql(`UPDATE lab_notebook SET content = 'Weighed 12.00 g, titrated.' WHERE id = $1`, [e.elnId]);
      const res = await verify(e.sigId);
      expect(res.body).toMatchObject({ valid: false, contentHashMatches: false, status: 'record-modified' });
    });
  });

  describe('legacy rows whose hash cannot be recomputed', () => {
    it("shows a signature with content hash 'N/A' as legacy-unverifiable, not valid", async () => {
      const s = await registerSample(t);
      // The notebook observation signature exactly as v0.1.0 wrote it (r1-quality-fixes: the route now signs through signRecord).
      await sql(`INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id) VALUES ($1, $2, 'usr-analyst2', 'I am the author of this observation', 'Observation', 1, 'N/A', 'N/A')`, [uniq('SIG-LEGACY'), s.id]);
      const id = await sigOf("sample_id = $1 AND content_hash = 'N/A'", [s.id]);
      const res = await verify(id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: false, contentHashMatches: null, status: 'legacy-unverifiable' });
    });

    it('shows a legacy batch release the same way: it records no sample list that could be recomputed', async () => {
      const s = await registerSample(t);
      const batch = (await sql('SELECT batch FROM samples WHERE id = $1', [s.id])).rows[0].batch as string;
      // r1-results-oos: the release route now signs through signRecord (hash version 2). The row below is exactly what v0.1.0
      // wrote: a signature on the first sample, bound to a Release audit entry of the batch, hashing a sample list nobody kept.
      const { db } = await import('../../src/db/index');
      const { writeAudit } = await import('../../src/db/utils');
      const audit = await db.transaction(tx => writeAudit(tx, 'usr-qa', 'Release', 'BatchRelease', batch, 'status', 'Quarantine', 'Released', 'legacy release'));
      const sigId = uniq('SIG-REL');
      await sql(`INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id) VALUES ($1, $2, 'usr-qa', 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)', 'ok', 1, $3, $4)`, [sigId, s.id, 'a'.repeat(64), audit.id]);
      const res = await verify(sigId);
      expect(res.body).toMatchObject({ valid: false, contentHashMatches: null, status: 'legacy-unverifiable', entityType: 'BatchRelease', entityId: batch });
    });

    it('never reports valid for a signature whose hash is null or empty', async () => {
      const s = await registerSample(t);
      const id = uniq('sig-nullhash');
      await sql(`INSERT INTO signatures (id, sample_id, signer_id, meaning, reason, record_version, content_hash, audit_entry_id) VALUES ($1, $2, 'usr-qa', 'x', 'y', 1, '', 'N/A')`, [id, s.id]);
      const res = await verify(id);
      expect(res.body.valid).toBe(false);
      expect(res.body.status).toBe('legacy-unverifiable');
    });
  });

  describe('the audit chain', () => {
    it('is part of the verdict: an audit entry altered with the guard off breaks the signature (status chain-broken)', async () => {
      const o = await closedOos();
      const entryId = (await sql('SELECT audit_entry_id FROM signatures WHERE id = $1', [o.sigId])).rows[0].audit_entry_id as string;
      const original = (await sql('SELECT reason FROM audit_trail WHERE id = $1', [entryId])).rows[0].reason as string;
      try {
        await withAuditGuardOff(() => sql(`UPDATE audit_trail SET reason = 'edited later' WHERE id = $1`, [entryId]));
        const res = await verify(o.sigId);
        expect(res.body).toMatchObject({ valid: false, chainIntact: false, status: 'chain-broken' });
      } finally {
        await withAuditGuardOff(() => sql('UPDATE audit_trail SET reason = $2 WHERE id = $1', [entryId, original]));
      }
      expect((await verify(o.sigId)).body.valid).toBe(true);
    });
  });

  describe('what the answer shows about the signer', () => {
    it('gives the manifestation: printed name, role, meaning, reason, time and record version', async () => {
      const o = await closedOos();
      const res = await verify(o.sigId);
      expect(res.body.signature).toMatchObject({
        id: o.sigId, signerName: 'Test QA Officer', signerRole: 'QA', recordVersion: 3, reason: 'Retrain and repeat the test',
      });
      expect(res.body.signature.meaning).toMatch(/OOS/);
      expect(new Date(res.body.signature.timestamp).getTime()).toBeGreaterThan(0);
    });
  });
});
