/**
 * Roadmap M19 (r2-result-ui): the bench-side result workbench saves every changed row of a sample in ONE request,
 * PUT /samples/:id/results-batch, all or nothing:
 *
 *   - every value goes through saveResult (role, Testing state, version predicate, evaluation, instrument calibration guard,
 *     OOS auto-open, result version), inside one transaction;
 *   - a stale row (expectedVersion behind the database) refuses the WHOLE save with 409 and names every stale row, so the grid can
 *     highlight them; nothing is written, no audit entry exists;
 *   - an instrument past its calibration due date refuses the whole save with the existing "GxP Violation" text, naming the row;
 *   - each changed value writes exactly one audit row (entity Result) with the reason, the old and the new value;
 *   - overwriting a value needs the row's own reason (and the coded reason); a first entry does not.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq, receiveSample } from '../helpers/fixtures';

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);

const PARAMS = [
  { name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null },
  { name: 'Impurity A', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2, text: null },
  { name: 'Water', unit: '% w/w', limit_kind: 'NMT', lower: null, upper: 1.0, decimals: 1, text: null },
];

type Row = { id: string; version: number; parameter: string };
async function sampleInTesting() {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, PARAMS as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  await receiveSample(t, id);
  const sub = await t.request.post(`/api/samples/${id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const rows = await sql('SELECT id, parameter, version FROM results WHERE sample_id = $1', [id]);
  const by = Object.fromEntries(rows.map((r: any) => [r.parameter, r])) as Record<string, Row>;
  return { id, by };
}

const batch = (who: string, sampleId: string, items: Array<Record<string, unknown>>) =>
  t.request.put(`/api/samples/${sampleId}/results-batch`).set(H[who]).send({ items });

const resultAudits = (ids: string[]) =>
  sql("SELECT entity_id, field, old_value, new_value, reason, user_id FROM audit_trail WHERE entity = 'Result' AND entity_id = ANY($1) ORDER BY sequence", [ids]);

async function instrument(dueInDays: number, status = 'Active') {
  const id = uniq('INST');
  const due = new Date(Date.now() + dueInDays * 86_400_000).toISOString().slice(0, 10);
  await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC bench', 'HPLC', $2, $3, '2026-01-01')`, [id, status, due]);
  return { id, due };
}

describe('atomic multi-row save', () => {
  it('saves every row in one request: one audit row per value with reason, old and new value', async () => {
    const s = await sampleInTesting();
    const res = await batch('analyst1', s.id, [
      { resultId: s.by.Assay.id, value: '99.8', expectedVersion: s.by.Assay.version },
      { resultId: s.by['Impurity A'].id, value: '0.12', expectedVersion: s.by['Impurity A'].version },
      { resultId: s.by.Water.id, value: '0.4', expectedVersion: s.by.Water.version, reason: 'Karl Fischer, worksheet WS-12' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.saved).toHaveLength(3);
    expect(res.body.saved.map((r: any) => [r.id, r.version, r.isOos])).toEqual([
      [s.by.Assay.id, 2, false], [s.by['Impurity A'].id, 2, false], [s.by.Water.id, 2, false],
    ]);
    const rows = await sql('SELECT parameter, value, version, entered_by FROM results WHERE sample_id = $1 ORDER BY parameter', [s.id]);
    expect(rows).toEqual([
      { parameter: 'Assay', value: '99.8', version: 2, entered_by: 'usr-analyst1' },
      { parameter: 'Impurity A', value: '0.12', version: 2, entered_by: 'usr-analyst1' },
      { parameter: 'Water', value: '0.4', version: 2, entered_by: 'usr-analyst1' },
    ]);
    const audits = await resultAudits([s.by.Assay.id, s.by['Impurity A'].id, s.by.Water.id]);
    expect(audits).toHaveLength(3);
    for (const a of audits) expect(a).toMatchObject({ field: 'value', old_value: '', user_id: 'usr-analyst1' });
    expect(audits.map((a: any) => a.new_value)).toEqual(['99.8', '0.12', '0.4']);
    // A first entry needs no typed reason: the server records it as the initial entry; a reason given is kept as written.
    expect(audits[0].reason).toBe('Initial entry');
    expect(audits[2].reason).toBe('Karl Fischer, worksheet WS-12');
  });

  it('a stale row refuses the WHOLE save with 409 naming every stale row; nothing is written or audited', async () => {
    const s = await sampleInTesting();
    // Someone else entered Impurity A meanwhile (version 1 -> 2).
    const other = await t.request.put(`/api/samples/${s.id}/results/${s.by['Impurity A'].id}`).set(H.admin)
      .send({ value: '0.10', reason: 'entered by a colleague', expectedVersion: 1 });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const before = await sql("SELECT count(*)::int AS n FROM audit_trail");

    const res = await batch('analyst1', s.id, [
      { resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 },
      { resultId: s.by['Impurity A'].id, value: '0.20', expectedVersion: 1, reason: 'my reading of the worksheet', reasonCode: 'TRANSCRIPTION_ERROR' },
      { resultId: s.by.Water.id, value: '0.4', expectedVersion: 1 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('RESULTS_STALE');
    expect(res.body.details).toEqual([expect.objectContaining({ path: 'items.1', resultId: s.by['Impurity A'].id, parameter: 'Impurity A' })]);
    const rows = await sql('SELECT parameter, value, version FROM results WHERE sample_id = $1 ORDER BY parameter', [s.id]);
    expect(rows).toEqual([
      { parameter: 'Assay', value: null, version: 1 },
      { parameter: 'Impurity A', value: '0.10', version: 2 },
      { parameter: 'Water', value: null, version: 1 },
    ]);
    expect(await sql("SELECT count(*)::int AS n FROM audit_trail")).toEqual(before);
  });

  it('a value the server refuses, on any row, rolls back the rows before it and names the row', async () => {
    const s = await sampleInTesting();
    const res = await batch('analyst1', s.id, [
      { resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 },
      { resultId: s.by.Water.id, value: '1,2', expectedVersion: 1 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.details).toEqual([expect.objectContaining({ path: 'items.1', resultId: s.by.Water.id, parameter: 'Water' })]);
    expect(await sql('SELECT count(*)::int AS n FROM results WHERE sample_id = $1 AND value IS NOT NULL', [s.id])).toEqual([{ n: 0 }]);
    expect(await resultAudits([s.by.Assay.id, s.by.Water.id])).toEqual([]);
  });

  it('an OOS row opens its investigation in the same save and the answer names it', async () => {
    const s = await sampleInTesting();
    const res = await batch('analyst1', s.id, [
      { resultId: s.by.Assay.id, value: '96.0', expectedVersion: 1 },
      { resultId: s.by.Water.id, value: '0.4', expectedVersion: 1 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [oos] = await sql('SELECT id, status FROM oos_investigations WHERE result_id = $1', [s.by.Assay.id]);
    expect(oos.status).toBe('Open');
    expect(res.body.saved[0]).toMatchObject({ id: s.by.Assay.id, isOos: true, oosInvestigationId: oos.id });
    expect(res.body.saved[1]).toMatchObject({ id: s.by.Water.id, isOos: false, oosInvestigationId: null });
  });

  it('keeps the unrounded entered value: the stored value and the audit entry are what the analyst typed', async () => {
    const s = await sampleInTesting();
    const res = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '97.96', expectedVersion: 1 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.saved[0]).toMatchObject({ value: '97.96', isOos: false }); // 97.96 rounds to 98.0 (1 decimal): within 98.0 - 102.0
    expect((await resultAudits([s.by.Assay.id]))[0].new_value).toBe('97.96');
  });
});

describe('overwriting', () => {
  it('needs the row reason (400 naming the parameter); with the reason and code it writes one audit row with old and new value', async () => {
    const s = await sampleInTesting();
    expect((await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 }])).status).toBe(200);

    const noReason = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.6', expectedVersion: 2, reasonCode: 'TRANSCRIPTION_ERROR' }]);
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(400);
    expect(noReason.body.error).toMatch(/Assay/);
    expect(noReason.body.error).toMatch(/reason/i);
    expect(noReason.body.details).toEqual([expect.objectContaining({ path: 'items.0', resultId: s.by.Assay.id })]);

    const noCode = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.6', expectedVersion: 2, reason: 'digit transposed from worksheet' }]);
    expect(noCode.status, JSON.stringify(noCode.body)).toBe(400);
    expect(noCode.body.error).toMatch(/reasonCode/);

    const ok = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.6', expectedVersion: 2, reason: 'digit transposed from worksheet', reasonCode: 'TRANSCRIPTION_ERROR' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audits = await resultAudits([s.by.Assay.id]);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ old_value: '99.8', new_value: '99.6' });
    expect(audits[1].reason).toContain('digit transposed from worksheet');
    expect(audits[1].reason).toContain('TRANSCRIPTION_ERROR');
  });

  it('a row that changes nothing is refused (400): no audit row without a change', async () => {
    const s = await sampleInTesting();
    expect((await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 }])).status).toBe(200);
    const same = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.8', expectedVersion: 2, reason: 'no change at all', reasonCode: 'TRANSCRIPTION_ERROR' }]);
    expect(same.status, JSON.stringify(same.body)).toBe(400);
    expect(same.body.error).toMatch(/no change/i);
    expect(await resultAudits([s.by.Assay.id])).toHaveLength(1);
  });
});

describe('instrument calibration', () => {
  it('an instrument 3 days past its calibration due date refuses the whole save with the existing GxP Violation', async () => {
    const s = await sampleInTesting();
    const overdue = await instrument(-3);
    const res = await batch('analyst1', s.id, [
      { resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 },
      { resultId: s.by.Water.id, value: '0.4', expectedVersion: 1, instrumentId: overdue.id },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/^GxP Violation: Instrument .* is past its calibration due date/);
    expect(res.body.error).toContain(overdue.due);
    expect(res.body.details).toEqual([expect.objectContaining({ path: 'items.1', resultId: s.by.Water.id, parameter: 'Water' })]);
    expect(await sql('SELECT count(*)::int AS n FROM results WHERE sample_id = $1 AND value IS NOT NULL', [s.id])).toEqual([{ n: 0 }]);
  });

  it('a calibrated instrument is recorded on the row', async () => {
    const s = await sampleInTesting();
    const ok = await instrument(30);
    const res = await batch('analyst1', s.id, [{ resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1, instrumentId: ok.id }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await sql('SELECT instrument_id FROM results WHERE id = $1', [s.by.Assay.id]))[0].instrument_id).toBe(ok.id);
  });
});

describe('who, what and input', () => {
  it('a Reviewer or QA is refused (403) and nothing is written', async () => {
    const s = await sampleInTesting();
    for (const who of ['reviewer', 'qa']) {
      const res = await batch(who, s.id, [{ resultId: s.by.Assay.id, value: '99.8', expectedVersion: 1 }]);
      expect(res.status, who).toBe(403);
    }
    expect((await sql('SELECT value FROM results WHERE id = $1', [s.by.Assay.id]))[0].value).toBeNull();
  });

  it('a result of another sample is 404; the same row twice, an empty list or an unknown key is 400', async () => {
    const a = await sampleInTesting();
    const b = await sampleInTesting();
    const foreign = await batch('analyst1', a.id, [{ resultId: b.by.Assay.id, value: '99.8', expectedVersion: 1 }]);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);

    const twice = await batch('analyst1', a.id, [
      { resultId: a.by.Assay.id, value: '99.8', expectedVersion: 1 },
      { resultId: a.by.Assay.id, value: '99.7', expectedVersion: 1 },
    ]);
    expect(twice.status).toBe(400);
    expect((await batch('analyst1', a.id, [])).status).toBe(400);
    const extra = await t.request.put(`/api/samples/${a.id}/results-batch`).set(H.analyst1)
      .send({ items: [{ resultId: a.by.Assay.id, value: '99.8', expectedVersion: 1, isOos: false }] });
    expect(extra.status).toBe(400);
    const serverField = await t.request.put(`/api/samples/${a.id}/results-batch`).set(H.analyst1)
      .send({ items: [{ resultId: a.by.Assay.id, value: '99.8', expectedVersion: 1 }], enteredBy: 'usr-admin' });
    expect(serverField.status).toBe(400);
    expect(await sql('SELECT count(*)::int AS n FROM results WHERE sample_id = $1 AND value IS NOT NULL', [a.id])).toEqual([{ n: 0 }]);
  });
});
