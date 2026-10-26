/**
 * Arrange helpers for API tests. Rows that no public route can create (an Active specification, which needs a
 * signed approval) are inserted with plain SQL; everything else is created through the API so the test also
 * exercises the real write path.
 */
import type { TestApp } from './app';

let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${process.pid}-${++seq}`;

export async function insertActiveSpec(t: TestApp, material: string, parameters = [{ name: 'Assay (%)', min: 98, max: 102 }]) {
  const id = uniq('SPEC');
  await t.db.pool.query(
    `INSERT INTO specifications (id, material, version, effective_date, status, parameters)
     VALUES ($1, $2, 1, '2026-01-01', 'Active', $3::jsonb)`,
    [id, material, JSON.stringify(parameters)],
  );
  return id;
}

/** Records the receipt of a sample (roadmap M29) in the required condition, so testing may start (the custody-received guard). */
export async function receiveSample(t: TestApp, sampleId: string, who = 'analyst1@gxp.com') {
  const res = await t.request.post(`/api/custody/samples/${sampleId}/receipt`).set(await t.auth(who))
    .send({ condition: 'Intact', sealIntact: true, requiredStorage: 'Ambient', quantity: 100, unit: 'g' });
  if (res.status !== 200) throw new Error(`receiveSample failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Registers a sample as analyst1, records its receipt, and returns its id, version and first result. */
export async function registerSample(t: TestApp, material = uniq('Material')) {
  await insertActiveSpec(t, material);
  const created = await t.request.post('/api/samples').set(await t.auth('analyst1@gxp.com')).send({ material, batch: uniq('B') });
  if (created.status !== 200) throw new Error(`registerSample failed: ${created.status} ${JSON.stringify(created.body)}`);
  await receiveSample(t, created.body.id);
  const detail = await t.request.get(`/api/samples/${created.body.id}`).set(await t.auth('analyst1@gxp.com'));
  return { id: created.body.id as string, version: detail.body.sample.version as number, result: detail.body.results[0] as { id: string; version: number } };
}

/** Fires n identical requests at once and returns their status codes, sorted. */
export async function race(n: number, send: () => PromiseLike<{ status: number }>): Promise<number[]> {
  const responses = await Promise.all(Array.from({ length: n }, () => send()));
  return responses.map(r => r.status).sort((a, b) => a - b);
}
