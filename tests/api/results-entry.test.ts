/**
 * Roadmap M10 (r1-results-oos): entering a result. PUT /samples/:id/results/:resultId
 *
 *   - the server evaluates the value against the limit the sample was registered with, rounded to its decimals (USP 7.20);
 *   - a value that is not a number (or a declared token) is a 400, never NaN;
 *   - only an Analyst or an Administrator enters results (403), and only while the sample is in Testing (409; 423 once closed);
 *   - an OOS result opens exactly one investigation in the SAME transaction as the result and its audit entry: if the audit
 *     write fails, neither the result nor the investigation exists;
 *   - overwriting an OOS result needs the open investigation and a coded reason.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, race, uniq, receiveSample } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

const PARAMS = [
  { name: 'Assay', unit: '%', limit_kind: 'NLT', lower: 98.0, upper: null, decimals: 1, text: null },
  { name: 'Impurity A', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 1, text: null },
  { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White powder' },
];

/** A sample in Testing with the three parameters above; returns its results by parameter name. */
async function sampleInTesting(state: 'Logged' | 'Testing' = 'Testing') {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, PARAMS as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  if (state === 'Testing') {
    await receiveSample(t, id);
    const sub = await t.request.post(`/api/samples/${id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  }
  const rows = await sql('SELECT id, parameter, version FROM results WHERE sample_id = $1', [id]);
  const by = Object.fromEntries(rows.map((r: any) => [r.parameter, r])) as Record<string, { id: string; version: number }>;
  return { id, by };
}

const put = (who: string, sampleId: string, r: { id: string; version: number }, body: Record<string, unknown>) =>
  t.request.put(`/api/samples/${sampleId}/results/${r.id}`).set(H[who]).send({ reason: 'routine entry', expectedVersion: r.version, ...body });

describe('evaluation on the server', () => {
  it('97.96 against NLT 98.0 is not OOS; 97.94 is', async () => {
    const s = await sampleInTesting();
    const pass = await put('analyst1', s.id, s.by.Assay, { value: '97.96' });
    expect(pass.status, JSON.stringify(pass.body)).toBe(200);
    expect(pass.body.isOos).toBe(false);

    const s2 = await sampleInTesting();
    const fail = await put('analyst1', s2.id, s2.by.Assay, { value: '97.94' });
    expect(fail.status, JSON.stringify(fail.body)).toBe(200);
    expect(fail.body.isOos).toBe(true);
    expect((await sql('SELECT is_oos FROM results WHERE id = $1', [s2.by.Assay.id]))[0].is_oos).toBe(true);
  });

  it("'<0.05' is accepted where the limit is an upper limit; 'garbage' and '1,234.5' are 400 and change nothing", async () => {
    const s = await sampleInTesting();
    const censored = await put('analyst1', s.id, s.by['Impurity A'], { value: '<0.05' });
    expect(censored.status, JSON.stringify(censored.body)).toBe(200);
    expect(censored.body).toMatchObject({ value: '<0.05', isOos: false });

    for (const value of ['garbage', '1,234.5']) {
      const res = await put('analyst1', s.id, s.by.Assay, { value });
      expect(res.status, value).toBe(400);
      expect(res.body.error).toMatch(/number/i);
    }
    const [row] = await sql('SELECT value, version FROM results WHERE id = $1', [s.by.Assay.id]);
    expect(row).toEqual({ value: null, version: 1 });
  });

  it('stores the limit the result was judged against on the result row (kind, limits as written, decimals, unit)', async () => {
    const s = await sampleInTesting();
    const [row] = await sql('SELECT limit_kind, lower_text, upper_text, decimals, unit FROM results WHERE id = $1', [s.by.Assay.id]);
    expect(row).toEqual({ limit_kind: 'NLT', lower_text: '98.0', upper_text: null, decimals: 1, unit: '%' });
  });
});

describe('who and when', () => {
  it('a Reviewer or QA PUT is 403 and changes nothing', async () => {
    const s = await sampleInTesting();
    for (const who of ['reviewer', 'qa']) {
      const res = await put(who, s.id, s.by.Assay, { value: '99.0' });
      expect(res.status, who).toBe(403);
    }
    expect((await sql('SELECT value FROM results WHERE id = $1', [s.by.Assay.id]))[0].value).toBeNull();
  });

  it('an Administrator may enter a result', async () => {
    const s = await sampleInTesting();
    expect((await put('admin', s.id, s.by.Assay, { value: '99.0' })).status).toBe(200);
  });

  it('a PUT while the sample is Logged or Pending Review is 409', async () => {
    const logged = await sampleInTesting('Logged');
    const res = await put('analyst1', logged.id, logged.by.Assay, { value: '99.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const s = await sampleInTesting();
    for (const [name, value] of [['Assay', '99.0'], ['Impurity A', '0.1'], ['Appearance', 'Complies']] as const) {
      expect((await put('analyst1', s.id, s.by[name], { value })).status).toBe(200);
    }
    const [{ version }] = await sql('SELECT version FROM samples WHERE id = $1', [s.id]);
    const review = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'review', expectedVersion: version, password: 'password' });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const [cur] = await sql('SELECT id, version FROM results WHERE id = $1', [s.by.Assay.id]);
    const late = await put('analyst1', s.id, cur, { value: '98.5' });
    expect(late.status, JSON.stringify(late.body)).toBe(409);
  });
});

describe('OOS opened with the result', () => {
  it('an OOS result opens exactly one Open investigation, audited, and the notification goes out after commit', async () => {
    const s = await sampleInTesting();
    t.io.emitted.length = 0;
    const res = await put('analyst1', s.id, s.by.Assay, { value: '90.0' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const oos = await sql('SELECT id, status, phase, parameter, sample_id FROM oos_investigations WHERE result_id = $1', [s.by.Assay.id]);
    expect(oos).toHaveLength(1);
    expect(oos[0]).toMatchObject({ status: 'Open', phase: 'Phase I', parameter: 'Assay', sample_id: s.id });
    expect(res.body.oosInvestigationId).toBe(oos[0].id);
    const audits = await sql("SELECT action, user_id FROM audit_trail WHERE entity = 'OOS' AND entity_id = $1", [oos[0].id]);
    expect(audits).toEqual([{ action: 'Create', user_id: 'usr-analyst1' }]);
    // Announced once, through the event outbox in the same transaction (r2-events), without the value; nothing is broadcast to every socket.
    expect(await sql("SELECT payload, actor_id FROM outbox_events WHERE type = 'result.oos_detected' AND entity_id = $1", [s.by.Assay.id]))
      .toEqual([{ payload: { sampleId: s.id, resultId: s.by.Assay.id, parameter: 'Assay', investigationId: oos[0].id }, actor_id: 'usr-analyst1' }]);
    expect(t.io.emitted.filter(e => e.event === 'notification')).toHaveLength(0);
  });

  it('a second OOS value on the same result does not open a second investigation', async () => {
    const s = await sampleInTesting();
    const first = await put('analyst1', s.id, s.by.Assay, { value: '90.0' });
    const oosId = first.body.oosInvestigationId;
    const again = await put('analyst1', s.id, { id: s.by.Assay.id, version: first.body.version }, { value: '91.0', oosId, reasonCode: 'TRANSCRIPTION_ERROR' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await sql('SELECT count(*)::int AS n FROM oos_investigations WHERE result_id = $1', [s.by.Assay.id])).toEqual([{ n: 1 }]);
  });

  it('parallel OOS entries of the same result open one investigation', async () => {
    const s = await sampleInTesting();
    const statuses = await race(6, () => put('analyst1', s.id, s.by.Assay, { value: '90.0' }));
    expect(statuses.filter(c => c === 200)).toHaveLength(1);
    expect(await sql('SELECT count(*)::int AS n FROM oos_investigations WHERE result_id = $1', [s.by.Assay.id])).toEqual([{ n: 1 }]);
  });

  it('a forced audit failure rolls back both the result and the investigation', async () => {
    const s = await sampleInTesting();
    const fn = `fail_oos_audit_${process.pid}`;
    await sql(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity = 'OOS' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`);
    await sql(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const res = await put('analyst1', s.id, s.by.Assay, { value: '90.0' });
      expect(res.status).toBe(500);
    } finally {
      await sql(`DROP TRIGGER ${fn} ON audit_trail`);
      await sql(`DROP FUNCTION ${fn}()`);
    }
    expect(await sql('SELECT value, is_oos, version FROM results WHERE id = $1', [s.by.Assay.id])).toEqual([{ value: null, is_oos: false, version: 1 }]);
    expect(await sql('SELECT count(*)::int AS n FROM oos_investigations WHERE result_id = $1', [s.by.Assay.id])).toEqual([{ n: 0 }]);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'Result' AND entity_id = $1", [s.by.Assay.id])).toEqual([{ n: 0 }]);
  });

  it('overwriting an OOS result needs the open investigation and a coded reason', async () => {
    const s = await sampleInTesting();
    const first = await put('analyst1', s.id, s.by.Assay, { value: '90.0' });
    const cur = { id: s.by.Assay.id, version: first.body.version };
    const plain = await put('analyst1', s.id, cur, { value: '99.0' });
    expect(plain.status).toBe(400);
    expect(plain.body.error).toMatch(/investigation/i);
    const wrongOos = await put('analyst1', s.id, cur, { value: '99.0', oosId: 'OOS-nope', reasonCode: 'TRANSCRIPTION_ERROR' });
    expect(wrongOos.status).toBe(400);
    const badCode = await put('analyst1', s.id, cur, { value: '99.0', oosId: first.body.oosInvestigationId, reasonCode: 'BECAUSE' });
    expect(badCode.status).toBe(400);
    const ok = await put('analyst1', s.id, cur, { value: '99.0', oosId: first.body.oosInvestigationId, reasonCode: 'TRANSCRIPTION_ERROR' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.isOos).toBe(false);
    const [audit] = await sql("SELECT old_value, new_value, reason FROM audit_trail WHERE entity = 'Result' AND entity_id = $1 ORDER BY sequence DESC LIMIT 1", [cur.id]);
    expect(audit).toMatchObject({ old_value: '90.0', new_value: '99.0' });
    expect(audit.reason).toContain('TRANSCRIPTION_ERROR');
    expect(audit.reason).toContain(first.body.oosInvestigationId);
    // the investigation stays open: it is closed by QA with a signature, not by re-entering a value
    expect((await sql('SELECT status FROM oos_investigations WHERE id = $1', [first.body.oosInvestigationId]))[0].status).toBe('Open');
  });
});

describe('calibration guard', () => {
  it('refuses an instrument whose calibration is due before today, and one that is not Active', async () => {
    const s = await sampleInTesting();
    const past = uniq('INST-P');
    const off = uniq('INST-O');
    await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC', 'HPLC', 'Active', '2020-01-01', '2019-01-01'), ($2, 'HPLC', 'HPLC', 'Out of Service', '2099-01-01', '2026-01-01')`, [past, off]);
    const a = await put('analyst1', s.id, s.by.Assay, { value: '99.0', instrumentId: past });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/calibration/i);
    const b = await put('analyst1', s.id, s.by.Assay, { value: '99.0', instrumentId: off });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/Out of Service/);
  });
});
