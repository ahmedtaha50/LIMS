/**
 * Optimistic concurrency (AGENTS.md section 2, roadmap M01 acceptance):
 * parallel writers that all present the same expectedVersion must produce exactly one 200 and the rest 409.
 * A check-then-write handler lets several of them through (lost update); the version predicate in the UPDATE does not.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { startTestApp, type TestApp } from '../../helpers/app';
import { race, registerSample, uniq } from '../../helpers/fixtures';

const N = 6;
let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });

const exactlyOneWins = [200, ...Array(N - 1).fill(409)];

/** r1-results-oos: results are entered only while the sample is in Testing. */
async function sampleInTesting() {
  const sample = await registerSample(t);
  const sub = await t.request.post(`/api/samples/${sample.id}/transition`).set(await t.auth('analyst1@gxp.com')).send({ action: 'submit', expectedVersion: sample.version });
  expect(sub.status).toBe(200);
  return sample;
}

describe('parallel writers with the same expectedVersion', () => {
  it('PUT /stability/:id', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const { startableStudy } = await import('../../api/stability-fixture');
    const f = await startableStudy(t);
    const created = await t.request.post('/api/stability').set(analyst).send({ protocolId: f.protocolId, batchId: f.batchId, startDate: f.startDate });
    expect(created.status).toBe(200);
    const statuses = await race(N, () => t.request.put(`/api/stability/${created.body.id}`).set(analyst).send({ status: 'Aborted', reason: 'Stored at the wrong condition', expectedVersion: 1 }));
    expect(statuses).toEqual(exactlyOneWins);
    const row = await t.db.pool.query('SELECT version FROM stability_studies WHERE id = $1', [created.body.id]);
    expect(row.rows[0].version).toBe(2);
    // The audit entry is written in the same transaction as the change, so a losing writer leaves none.
    const audits = await t.db.pool.query("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'StabilityStudy' AND entity_id = $1 AND action = 'StatusChange'", [created.body.id]);
    expect(audits.rows[0].n).toBe(1);
  });

  it('PUT /env-records/:id', async () => {
    // r1-quality-fixes: a result has a sample type, and a count is corrected by QA with a reason.
    const analyst = await t.auth('analyst1@gxp.com');
    const qa = await t.auth('qa@gxp.com');
    const created = await t.request.post('/api/env-records').set(analyst).send({ location: 'Room 1', grade: 'D', sampleType: 'Air', date: '2026-01-01', viableCount: 1, nonViableCount: 1 });
    expect(created.status).toBe(200);
    const statuses = await race(N, () => t.request.put(`/api/env-records/${created.body.id}`).set(qa).send({ viableCount: 2, reason: 'Recount of the plate', expectedVersion: 1 }));
    expect(statuses).toEqual(exactlyOneWins);
  });

  it('PUT /specifications/:id', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const created = await t.request.post('/api/specifications').set(analyst).send({ material: uniq('M'), effectiveDate: '2026-01-01' });
    expect(created.status).toBe(200);
    const statuses = await race(N, () => t.request.put(`/api/specifications/${created.body.id}`).set(analyst).send({ parameters: [{ name: 'Assay', limit_kind: 'RANGE', lower: 1, upper: 2, decimals: 0 }], expectedVersion: 1 }));
    expect(statuses).toEqual(exactlyOneWins);
  });

  it('PUT /eln/:id', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const created = await t.request.post('/api/eln').set(analyst).send({ title: 'T', content: 'C' });
    expect(created.status).toBe(200);
    const statuses = await race(N, () => t.request.put(`/api/eln/${created.body.id}`).set(analyst).send({ content: 'changed', expectedVersion: 1 }));
    expect(statuses).toEqual(exactlyOneWins);
  });

  it('PUT /oos/:id', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const sample = await registerSample(t);
    const created = await t.request.post('/api/oos').set(analyst).send({ sampleId: sample.id, resultId: sample.result.id, parameter: 'Assay (%)', dateRaised: '2026-01-01' });
    expect(created.status).toBe(200);
    const qa = await t.auth('qa@gxp.com');
    const statuses = await race(N, () => t.request.put(`/api/oos/${created.body.id}`).set(qa).send({ rootCause: 'x', expectedVersion: 1 }));
    expect(statuses).toEqual(exactlyOneWins);
  });

  it('PUT /samples/:id/results/:resultId', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const sample = await sampleInTesting();
    const statuses = await race(N, () => t.request.put(`/api/samples/${sample.id}/results/${sample.result.id}`).set(analyst)
      .send({ value: '100.0', reason: 'routine entry', expectedVersion: sample.result.version }));
    expect(statuses).toEqual(exactlyOneWins);
  });

  it('POST /samples/:id/transition', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const sample = await registerSample(t);
    const statuses = await race(N, () => t.request.post(`/api/samples/${sample.id}/transition`).set(analyst).send({ action: 'submit', expectedVersion: sample.version }));
    expect(statuses).toEqual(exactlyOneWins);
    const audits = await t.db.pool.query("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Sample' AND entity_id = $1 AND action = 'Transition'", [sample.id]);
    expect(audits.rows[0].n).toBe(1);
  });

  it('announces an OOS result once, for the write that committed (not once per racer)', async () => {
    const analyst = await t.auth('analyst1@gxp.com');
    const sample = await sampleInTesting(); // limits 98 - 102
    t.io.emitted.length = 0;
    const statuses = await race(N, () => t.request.put(`/api/samples/${sample.id}/results/${sample.result.id}`).set(analyst)
      .send({ value: '50', reason: 'routine entry', expectedVersion: sample.result.version }));
    expect(statuses).toEqual(exactlyOneWins);
    const events = await t.db.pool.query("SELECT id FROM outbox_events WHERE type = 'result.oos_detected' AND entity_id = $1", [sample.result.id]);
    expect(events.rows).toHaveLength(1); // the outbox row commits with the winning write only (r2-events)
    const stored = await t.db.pool.query('SELECT is_oos FROM results WHERE id = $1', [sample.result.id]);
    expect(stored.rows[0].is_oos).toBe(true);
  });
});
