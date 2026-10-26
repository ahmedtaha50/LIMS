/**
 * Roadmap M10 (r1-results-oos): registration and the sample lifecycle gates.
 *
 *   - sample ids come from a per-year counter: parallel registrations never collide, and a year starts at 00001;
 *   - registration binds the sample to the specification revision in force (resolveActiveSpec) and copies each parameter's limit
 *     onto its result row;
 *   - review needs every result entered (400 naming the parameter), approval needs no OOS without a closed investigation;
 *   - the signed moves are signed through signRecord (meaning from the catalog, bound to the record version);
 *   - GET /samples is paged by a cursor; bulk import is validated as a whole and written in one transaction.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq, receiveSample } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const YEAR = new Date().getFullYear();

const PARAMS = [
  { name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null },
  { name: 'Water', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 1, text: null },
];

async function register(material?: string) {
  const mat = material ?? uniq('Mat');
  if (!material) await insertActiveSpec(t, mat, PARAMS as any);
  const res = await t.request.post('/api/samples').set(H.analyst1).send({ material: mat, batch: uniq('B') });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await receiveSample(t, res.body.id);
  return res.body as { id: string; batch: string; material: string };
}
const version = async (id: string) => (await sql('SELECT version FROM samples WHERE id = $1', [id]))[0].version as number;
const move = async (who: string, id: string, action: string, extra: Record<string, unknown> = {}) =>
  t.request.post(`/api/samples/${id}/transition`).set(H[who]).send({ action, expectedVersion: await version(id), ...extra });
const results = (id: string) => sql('SELECT id, parameter, version FROM results WHERE sample_id = $1 ORDER BY parameter', [id]);
const enter = async (sampleId: string, parameter: string, value: string, who = 'analyst1') => {
  const r = (await results(sampleId)).find((x: any) => x.parameter === parameter);
  const res = await t.request.put(`/api/samples/${sampleId}/results/${r.id}`).set(H[who]).send({ value, reason: 'routine entry', expectedVersion: r.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

describe('sample ids', () => {
  it('the first sample of a year is SMP-<year>-00001', async () => {
    const s = await register();
    expect(s.id).toBe(`SMP-${YEAR}-00001`);
  });

  it('a new year starts its own counter at 00001', async () => {
    const { nextSampleId } = await import('../../src/server/routes/samples');
    const { db } = await import('../../src/db/index');
    const later = new Date(YEAR + 5, 0, 1, 9, 0, 0);
    expect(await db.transaction(tx => nextSampleId(tx, later))).toBe(`SMP-${YEAR + 5}-00001`);
    expect(await db.transaction(tx => nextSampleId(tx, later))).toBe(`SMP-${YEAR + 5}-00002`);
  });

  it('20 parallel registrations give 20 unique ids and all succeed', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      t.request.post('/api/samples').set(H.analyst1).send({ material, batch: `B-PAR-${i}` })));
    expect(responses.map(r => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(responses.map(r => r.body.id)).size).toBe(20);
  });
});

describe('specification binding', () => {
  it('stores the specification id and revision and copies each limit onto its result', async () => {
    const material = uniq('Mat');
    const specId = await insertActiveSpec(t, material, PARAMS as any);
    const s = await register(material);
    expect(await sql('SELECT spec_id, spec_revision FROM samples WHERE id = $1', [s.id])).toEqual([{ spec_id: specId, spec_revision: 1 }]);
    const rows = await sql('SELECT parameter, limit_kind, lower_text, upper_text, decimals, unit, spec_min, spec_max FROM results WHERE sample_id = $1 ORDER BY parameter', [s.id]);
    expect(rows).toEqual([
      { parameter: 'Assay', limit_kind: 'RANGE', lower_text: '98.0', upper_text: '102.0', decimals: 1, unit: '%', spec_min: 98, spec_max: 102 },
      { parameter: 'Water', limit_kind: 'NMT', lower_text: null, upper_text: '0.5', decimals: 1, unit: '%', spec_min: null, spec_max: 0.5 },
    ]);
  });

  it('chooses the revision in force today, not a future-dated Active one', async () => {
    const material = uniq('Mat');
    const current = await insertActiveSpec(t, material, PARAMS as any);
    const future = uniq('SPEC-F');
    await sql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters, revision_label) VALUES ($1, $2, 1, '2099-01-01', 'Active', $3::jsonb, 2)`, [future, material, JSON.stringify(PARAMS)]);
    const s = await register(material);
    expect((await sql('SELECT spec_id FROM samples WHERE id = $1', [s.id]))[0].spec_id).toBe(current);
  });

  it('refuses a material with no specification in force (400) and writes nothing', async () => {
    const res = await t.request.post('/api/samples').set(H.analyst1).send({ material: uniq('NoSpec'), batch: 'B' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/specification/i);
  });
});

describe('lifecycle gates', () => {
  it('review with a result not entered is 400 and names the parameter', async () => {
    const s = await register();
    expect((await move('analyst1', s.id, 'submit')).status).toBe(200);
    await enter(s.id, 'Assay', '99.0');
    const res = await move('analyst1', s.id, 'review', { password: 'password' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain('Water');
    expect(await sql("SELECT state FROM samples WHERE id = $1", [s.id])).toEqual([{ state: 'Testing' }]);
    // a refused gate costs the signer no attempt
    expect((await sql("SELECT failed_attempts FROM users WHERE id = 'usr-analyst1'"))[0].failed_attempts).toBe(0);
  });

  it('approve with an OOS whose investigation is not closed is 400; once closed by QA it can be approved', async () => {
    const s = await register();
    await move('analyst1', s.id, 'submit');
    const oosBody = await enter(s.id, 'Assay', '90.0');
    await enter(s.id, 'Water', '0.1');
    expect((await move('analyst1', s.id, 'review', { password: 'password' })).status).toBe(200);
    const blocked = await move('reviewer', s.id, 'approve', { password: 'password' });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(400);
    expect(blocked.body.error).toContain(oosBody.oosInvestigationId);

    // r2-oos-workflow: Confirmed OOS is decided after the Phase II investigation, and the decision is required.
    const [oos0] = await sql('SELECT id, version FROM oos_investigations WHERE id = $1', [oosBody.oosInvestigationId]);
    expect((await t.request.put(`/api/oos/${oos0.id}`).set(H.qa).send({ phase: 'Phase II', expectedVersion: oos0.version })).status).toBe(200);
    const [oos] = await sql('SELECT id, version FROM oos_investigations WHERE id = $1', [oosBody.oosInvestigationId]);
    const close = await t.request.post(`/api/oos/${oos.id}/close`).set(H.qa)
      .send({ rootCause: 'Confirmed laboratory result', conclusion: 'Batch to be rejected; CAPA raised', decision: 'Confirmed OOS', password: 'password', expectedVersion: oos.version });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect((await move('reviewer', s.id, 'approve', { password: 'password' })).status).toBe(200);
  });

  it('signs review and approval through signRecord: catalog meaning, Sample entity, record version, signature verifies', async () => {
    const s = await register();
    await move('analyst1', s.id, 'submit');
    await enter(s.id, 'Assay', '99.0');
    await enter(s.id, 'Water', '0.1');
    expect((await move('analyst1', s.id, 'review', { password: 'password' })).status).toBe(200);
    expect((await move('reviewer', s.id, 'approve', { password: 'password' })).status).toBe(200);
    const sigs = await sql("SELECT id, meaning_code, entity_type, entity_id, record_version, hash_version FROM signatures WHERE sample_id = $1 ORDER BY timestamp", [s.id]);
    expect(sigs.map((x: any) => [x.meaning_code, x.entity_type, x.entity_id, x.hash_version])).toEqual([
      ['SUBMIT_FOR_REVIEW', 'Sample', s.id, 2], ['APPROVAL', 'Sample', s.id, 2],
    ]);
    for (const sig of sigs) {
      const v = await t.request.get(`/api/signatures/verify/${sig.id}`).set(H.qa);
      expect(v.body, JSON.stringify(v.body)).toMatchObject({ valid: true, status: 'valid' });
    }
  });

  it('a wrong password on a sample signature is counted and audited even though the transition fails', async () => {
    const s = await register();
    await move('analyst1', s.id, 'submit');
    await enter(s.id, 'Assay', '99.0', 'analyst2');
    await enter(s.id, 'Water', '0.1', 'analyst2');
    const res = await move('analyst2', s.id, 'review', { password: 'wrong' });
    expect(res.status).toBe(401);
    expect((await sql("SELECT failed_attempts FROM users WHERE id = 'usr-analyst2'"))[0].failed_attempts).toBe(1);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND user_id = 'usr-analyst2'")).toEqual([{ n: 1 }]);
    await sql("UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-analyst2'");
  });

  it('rejection needs a reason (catalog rule) and an independent reviewer', async () => {
    const s = await register();
    await move('analyst1', s.id, 'submit');
    await enter(s.id, 'Assay', '99.0', 'admin');
    await enter(s.id, 'Water', '0.1', 'admin');
    expect((await move('analyst1', s.id, 'review', { password: 'password' })).status).toBe(200);
    expect((await move('admin', s.id, 'reject', { password: 'password', reason: 'Not independent' })).status).toBe(400);
    expect((await move('qa', s.id, 'reject', { password: 'password' })).status).toBe(400);
    expect((await move('qa', s.id, 'reject', { password: 'password', reason: 'Sample container damaged' })).status).toBe(200);
  });
});

describe('GET /samples', () => {
  it('pages by cursor, newest first, and filters by state', async () => {
    for (let i = 0; i < 3; i++) await register();
    const first = await t.request.get('/api/samples?limit=2').set(H.analyst1);
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(2);
    const cursor = first.headers['x-next-cursor'];
    expect(cursor).toBeTruthy();
    const second = await t.request.get(`/api/samples?limit=2&cursor=${encodeURIComponent(cursor)}`).set(H.analyst1);
    expect(second.status).toBe(200);
    const ids = [...first.body, ...second.body].map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = await sql('SELECT id FROM samples ORDER BY created_at DESC, id DESC LIMIT 4');
    expect(ids).toEqual(all.map((r: any) => r.id));

    const logged = await t.request.get('/api/samples?state=Logged&limit=500').set(H.analyst1);
    expect(logged.body.length).toBeGreaterThan(0);
    expect(logged.body.every((s: any) => s.state === 'Logged')).toBe(true);
    expect((await t.request.get('/api/samples?state=Nonsense').set(H.analyst1)).status).toBe(400);
    expect((await t.request.get('/api/samples?limit=0').set(H.analyst1)).status).toBe(400);
  });
});

describe('POST /samples/bulk-import', () => {
  it('imports all rows in one transaction, with consecutive ids and seeded results', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const res = await t.request.post('/api/samples/bulk-import').set(H.analyst1).send({ items: [{ material, batch: 'BI-1' }, { material, batch: 'BI-2' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(2);
    const ids = res.body.samples.map((s: any) => s.id);
    const n = ids.map((id: string) => Number(id.split('-')[2]));
    expect(n[1]).toBe(n[0] + 1);
    expect(await sql('SELECT count(*)::int AS n FROM results WHERE sample_id = ANY($1)', [ids])).toEqual([{ n: 4 }]);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Sample' AND action = 'Create' AND entity_id = ANY($1)", [ids])).toEqual([{ n: 2 }]);
  });

  it('refuses the whole import when one row is invalid, naming the row, and refuses unknown keys', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const before = (await sql('SELECT count(*)::int AS n FROM samples'))[0].n;
    const res = await t.request.post('/api/samples/bulk-import').set(H.analyst1).send({ items: [{ material, batch: 'OK' }, { material: uniq('NoSpec'), batch: 'X' }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Row 2');
    expect((await sql('SELECT count(*)::int AS n FROM samples'))[0].n).toBe(before);
    const extra = await t.request.post('/api/samples/bulk-import').set(H.analyst1).send({ items: [{ material, batch: 'OK', state: 'Approved' }] });
    expect(extra.status).toBe(400);
  });
});

describe('the counter never hands out an id that exists', () => {
  it('continues after the highest existing id of the year when rows were written without it (demo seed, old backup)', async () => {
    const material = uniq('Mat');
    await insertActiveSpec(t, material, PARAMS as any);
    const year = YEAR + 7;
    await sql(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ($1, $2, 'SEED', 'Approved', 'usr-analyst1')`, [`SMP-${year}-00041`, material]);
    const { nextSampleId } = await import('../../src/server/routes/samples');
    const { db } = await import('../../src/db/index');
    const at = new Date(year, 5, 1);
    expect(await db.transaction(tx => nextSampleId(tx, at))).toBe(`SMP-${year}-00042`);
    // and when the counter exists but is behind
    await sql(`INSERT INTO samples (id, material, batch, state, created_by) VALUES ($1, $2, 'SEED', 'Approved', 'usr-analyst1')`, [`SMP-${year}-00100`, material]);
    expect(await db.transaction(tx => nextSampleId(tx, at))).toBe(`SMP-${year}-00101`);
  });
});
