/**
 * Roadmap M20 (r2-raw-data): every result value is kept, with a coded reason (21 CFR 211.194(a)(8), 11.10(e)).
 *
 *   - each write of a result appends one result_versions row in the SAME transaction as the result and its audit entry:
 *     the first entry is INITIAL_ENTRY, every later correction needs a coded reason (400 without one);
 *   - the table refuses UPDATE, DELETE and TRUNCATE (trigger);
 *   - a REINTEGRATION correction needs a QA signature (REINTEGRATION_APPROVAL), bound to the version, by someone other than the
 *     person who reintegrated; the signature verifies; a second one is refused;
 *   - replacing an OOS value still needs one of the OOS codes; reintegrating an OOS value is refused.
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
const PW = 'password';
const PARAMS = [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }];

async function sampleInTesting() {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, PARAMS as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await receiveSample(t, created.body.id);
  const sub = await t.request.post(`/api/samples/${created.body.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const [r] = await sql('SELECT id FROM results WHERE sample_id = $1', [created.body.id]);
  return { id: created.body.id as string, resultId: r.id as string };
}
const current = async (resultId: string) => (await sql('SELECT value, version, is_oos FROM results WHERE id = $1', [resultId]))[0];
const put = async (who: string, s: { id: string; resultId: string }, body: Record<string, unknown>) =>
  t.request.put(`/api/samples/${s.id}/results/${s.resultId}`).set(H[who])
    .send({ reason: 'routine entry', expectedVersion: (await current(s.resultId)).version, ...body });
const versions = (resultId: string) => sql(
  'SELECT result_version, value, previous_value, change_code, reason, entered_by FROM result_versions WHERE result_id = $1 ORDER BY result_version', [resultId]);

describe('every write of a result is kept', () => {
  it('three edits give three result_versions rows with their codes; UPDATE and DELETE on the table are refused', async () => {
    const s = await sampleInTesting();
    expect((await put('analyst1', s, { value: '99.1' })).status).toBe(200);

    const uncoded = await put('analyst1', s, { value: '99.4', reason: 'typo on the worksheet' });
    expect(uncoded.status, JSON.stringify(uncoded.body)).toBe(400);
    expect(uncoded.body.error).toMatch(/reasonCode/);
    expect((await current(s.resultId)).value).toBe('99.1');

    const fixed = await put('analyst1', s, { value: '99.4', reason: 'typo on the worksheet', reasonCode: 'TRANSCRIPTION_ERROR' });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const reint = await put('analyst1', s, { value: '99.6', reason: 'baseline set at the valley per SOP-CHR-004', reasonCode: 'REINTEGRATION' });
    expect(reint.status, JSON.stringify(reint.body)).toBe(200);

    expect(await versions(s.resultId)).toEqual([
      { result_version: 2, value: '99.1', previous_value: null, change_code: 'INITIAL_ENTRY', reason: 'routine entry', entered_by: 'usr-analyst1' },
      { result_version: 3, value: '99.4', previous_value: '99.1', change_code: 'TRANSCRIPTION_ERROR', reason: 'typo on the worksheet', entered_by: 'usr-analyst1' },
      { result_version: 4, value: '99.6', previous_value: '99.4', change_code: 'REINTEGRATION', reason: 'baseline set at the valley per SOP-CHR-004', entered_by: 'usr-analyst1' },
    ]);
    // The audit entry of a correction names its code.
    const audit = await sql(`SELECT reason FROM audit_trail WHERE entity = 'Result' AND entity_id = $1 ORDER BY sequence`, [s.resultId]);
    expect(audit.map(a => a.reason)).toEqual(['routine entry', '[TRANSCRIPTION_ERROR] typo on the worksheet', '[REINTEGRATION] baseline set at the valley per SOP-CHR-004']);

    await expect(sql(`UPDATE result_versions SET value = '100.0' WHERE result_id = $1`, [s.resultId])).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM result_versions WHERE result_id = $1`, [s.resultId])).rejects.toThrow(/append-only/);
    expect(await versions(s.resultId)).toHaveLength(3);

    const listed = await t.request.get(`/api/samples/${s.id}/result-versions`).set(H.reviewer);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.versions.map((v: any) => [v.changeCode, v.reintegrationSignature])).toEqual([
      ['INITIAL_ENTRY', null], ['TRANSCRIPTION_ERROR', null], ['REINTEGRATION', null],
    ]);
  });

  it('a first entry takes no code, and an unknown code is refused', async () => {
    const s = await sampleInTesting();
    const coded = await put('analyst1', s, { value: '99.1', reasonCode: 'TRANSCRIPTION_ERROR' });
    expect(coded.status, JSON.stringify(coded.body)).toBe(400);
    const unknown = await put('analyst1', s, { value: '99.1', reasonCode: 'BECAUSE' });
    expect(unknown.status).toBe(400);
    expect(await versions(s.resultId)).toEqual([]);
  });

  it('the version is written in the same transaction: when it cannot be written, the result and its audit entry are not either', async () => {
    const s = await sampleInTesting();
    await sql(`CREATE OR REPLACE FUNCTION rawdata_test_refuse() RETURNS trigger AS $$ BEGIN
      IF NEW.result_id = '${s.resultId}' THEN RAISE EXCEPTION 'refused by test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql(`CREATE TRIGGER rawdata_test_refuse BEFORE INSERT ON result_versions FOR EACH ROW EXECUTE FUNCTION rawdata_test_refuse()`);
    try {
      const res = await put('analyst1', s, { value: '99.1' });
      expect(res.status).toBe(500);
    } finally {
      await sql('DROP TRIGGER rawdata_test_refuse ON result_versions');
    }
    expect(await current(s.resultId)).toMatchObject({ value: null, version: 1 });
    expect(await sql(`SELECT 1 FROM audit_trail WHERE entity = 'Result' AND entity_id = $1`, [s.resultId])).toHaveLength(0);
  });

  it('replacing an OOS value still needs an OOS code; reintegrating an OOS value is refused', async () => {
    const s = await sampleInTesting();
    const oos = await put('analyst1', s, { value: '97.0' });
    expect(oos.body.isOos).toBe(true);
    const oosId = oos.body.oosInvestigationId;
    const reint = await put('analyst1', s, { value: '98.5', oosId, reasonCode: 'REINTEGRATION', reason: 'reprocessed the chromatogram' });
    expect(reint.status, JSON.stringify(reint.body)).toBe(400);
    const ok = await put('analyst1', s, { value: '98.5', oosId, reasonCode: 'CALCULATION_ERROR', reason: 'dilution factor 10 not 100' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await versions(s.resultId)).map(v => v.change_code)).toEqual(['INITIAL_ENTRY', 'CALCULATION_ERROR']);
  });
});

describe('a reintegration needs a QA signature', () => {
  async function reintegrated() {
    const s = await sampleInTesting();
    expect((await put('admin', s, { value: '99.1' })).status).toBe(200);
    expect((await put('admin', s, { value: '99.5', reasonCode: 'REINTEGRATION', reason: 'peak split; baseline corrected' })).status).toBe(200);
    const [v] = await sql(`SELECT id FROM result_versions WHERE result_id = $1 AND change_code = 'REINTEGRATION'`, [s.resultId]);
    return { ...s, versionId: v.id as string };
  }
  const sign = (who: string, versionId: string, body: Record<string, unknown> = {}) =>
    t.request.post(`/api/result-versions/${versionId}/sign`).set(H[who]).send({ password: PW, reason: 'Reintegration checked against SOP-CHR-004', ...body });

  it('an Analyst or Reviewer cannot sign it; the person who reintegrated cannot either; QA signs it once', async () => {
    const s = await reintegrated();
    expect((await sign('analyst2', s.versionId)).status).toBe(403);
    expect((await sign('reviewer', s.versionId)).status).toBe(403);
    const own = await sign('admin', s.versionId);
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    expect((await sign('qa', s.versionId, { reason: '' })).status).toBe(400);

    const signed = await sign('qa', s.versionId);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.signature).toMatchObject({ meaningCode: 'REINTEGRATION_APPROVAL', entityType: 'ResultVersion', entityId: s.versionId, sampleId: s.id, recordVersion: 3 });
    const verify = await t.request.get(`/api/signatures/verify/${signed.body.signature.id}`).set(H.qa);
    expect(verify.body).toMatchObject({ valid: true, status: 'valid' });

    expect((await sign('qa', s.versionId)).status).toBe(409);
    const listed = await t.request.get(`/api/samples/${s.id}/result-versions`).set(H.qa);
    expect(listed.body.versions.find((v: any) => v.id === s.versionId).reintegrationSignature).toMatchObject({ id: signed.body.signature.id, signerId: 'usr-qa' });
  });

  it('only a REINTEGRATION version is signed this way', async () => {
    const s = await sampleInTesting();
    expect((await put('analyst1', s, { value: '99.1' })).status).toBe(200);
    const [v] = await sql(`SELECT id FROM result_versions WHERE result_id = $1`, [s.resultId]);
    const res = await sign('qa', v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await sign('qa', 'rv-missing')).status).toBe(404);
  });

  it('a wrong password is refused and counted, and nothing is signed', async () => {
    const s = await reintegrated();
    const res = await sign('qa', s.versionId, { password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(await sql(`SELECT 1 FROM signatures WHERE entity_type = 'ResultVersion' AND entity_id = $1`, [s.versionId])).toHaveLength(0);
  });
});
