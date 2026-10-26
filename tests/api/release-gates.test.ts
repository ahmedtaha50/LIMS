/**
 * Roadmap M10 (r1-results-oos): batch release gates (src/server/release-blockers). A batch is released only when it has at least
 * one sample, every sample is Approved, and no OOS result lacks a closed investigation (any non-terminal status blocks, including
 * v0.1.0 words such as 'Phase II QA Review'). The release is signed through signRecord with BATCH_RELEASE on the batch.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const release = (batch: string, body: Record<string, unknown> = {}) =>
  t.request.post(`/api/traceability/batch/${encodeURIComponent(batch)}/release`).set(H.qa).send({ password: 'password', reason: 'Batch conforms', ...body });

/** A sample of `batch` with one parameter, arranged straight into the wanted state (the lifecycle itself is tested elsewhere). */
async function sample(batch: string, state: string, value = '99.0', isOos = false) {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }] as any);
  const res = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await sql('UPDATE samples SET state = $2 WHERE id = $1', [res.body.id, state]);
  await sql('UPDATE results SET value = $2, is_oos = $3 WHERE sample_id = $1', [res.body.id, value, isOos]);
  const [r] = await sql('SELECT id FROM results WHERE sample_id = $1', [res.body.id]);
  return { id: res.body.id as string, resultId: r.id as string };
}

describe('release blockers', () => {
  it('a batch with zero samples is 400', async () => {
    const res = await release(uniq('B-EMPTY'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no samples/i);
  });

  it('a batch with a sample that is not Approved is 400 naming the sample', async () => {
    const batch = uniq('B');
    await sample(batch, 'Approved');
    const pending = await sample(batch, 'Pending Review');
    const res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(pending.id);
  });

  it('an OOS result without an investigation is 400', async () => {
    const batch = uniq('B');
    const s = await sample(batch, 'Approved', '90.0', true);
    const res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(s.resultId);
  });

  it('an OOS with a non-terminal investigation blocks, whatever its status is called (Phase II QA Review)', async () => {
    const batch = uniq('B');
    const s = await sample(batch, 'Approved', '90.0', true);
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Assay', '2026-01-01', 'Phase II QA Review')`, [uniq('OOS'), s.id, s.resultId]);
    const res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/investigation/i);
  });

  it('a non-terminal investigation on an in-spec result blocks too', async () => {
    const batch = uniq('B');
    const s = await sample(batch, 'Approved');
    const oos = uniq('OOS');
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Assay', '2026-01-01', 'Open')`, [oos, s.id, s.resultId]);
    const res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(oos);
  });

  it('releases an Approved batch whose OOS was closed, signed with BATCH_RELEASE on the batch, and the signature verifies', async () => {
    const batch = uniq('B');
    const s = await sample(batch, 'Approved', '90.0', true);
    await sql(`INSERT INTO oos_investigations (id, sample_id, result_id, parameter, date_raised, status) VALUES ($1, $2, $3, 'Assay', '2026-01-01', 'Closed')`, [uniq('OOS'), s.id, s.resultId]);
    await sample(batch, 'Approved');
    const res = await release(batch);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [sig] = await sql("SELECT id, meaning_code, entity_type, entity_id, sample_id FROM signatures WHERE entity_type = 'BatchRelease' AND entity_id = $1", [batch]);
    expect(sig).toMatchObject({ meaning_code: 'BATCH_RELEASE', sample_id: null });
    expect(res.body.release.signatureId).toBe(sig.id);
    expect(await sql('SELECT status, released_by FROM batch_releases WHERE batch = $1', [batch])).toEqual([{ status: 'Released', released_by: 'usr-qa' }]);
    expect(await sql("SELECT action, new_value FROM audit_trail WHERE entity = 'BatchRelease' AND entity_id = $1", [batch])).toEqual([{ action: 'Release', new_value: 'Released' }]);
    const v = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
    expect(v.body).toMatchObject({ valid: true, status: 'valid' });
  });

  it('a wrong password is counted and audited; nothing is released', async () => {
    const batch = uniq('B');
    await sample(batch, 'Approved');
    const res = await release(batch, { password: 'wrong' });
    expect(res.status).toBe(401);
    expect((await sql("SELECT failed_attempts FROM users WHERE id = 'usr-qa'"))[0].failed_attempts).toBe(1);
    expect(await sql('SELECT count(*)::int AS n FROM batch_releases WHERE batch = $1', [batch])).toEqual([{ n: 0 }]);
    await sql("UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-qa'");
  });
});
