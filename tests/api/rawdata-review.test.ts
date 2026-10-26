/**
 * Roadmap M20 (r2-raw-data): the review checklist (21 CFR 211.194(a)(8), audit-trail review by exception).
 *
 *   - GET /samples/:id/review-checklist evaluates the server items now: results entered, the history of each result consistent
 *     with its value, every reintegration signed by QA, instruments within calibration when the result was measured, raw data
 *     attached for every instrument result, every attached file intact, system suitability;
 *   - approval is refused (400 TRANSITION_BLOCKED, listing the items) while a server item is not met, before any signature is
 *     asked for;
 *   - a reviewer records the manual attestations with POST; the row keeps the server items as evaluated then and is append-only.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq, receiveSample } from '../helpers/fixtures';

const BLOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'rawdata-review-'));
process.env.BLOB_DIR = BLOBS;

let t: TestApp;
const H: Record<string, { Authorization: string }> = {};
beforeAll(async () => {
  t = await startTestApp();
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1', 'analyst2']) H[u] = await t.auth(`${u}@gxp.com`);
});
afterAll(() => {
  delete process.env.BLOB_DIR;
  fs.rmSync(BLOBS, { recursive: true, force: true });
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const PW = 'password';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(2048)]);

async function instrument(due = '2099-12-31') {
  const id = uniq('INST');
  await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, 'HPLC 1', 'HPLC', 'Active', $2, '2026-01-01')`, [id, due]);
  return id;
}

async function sampleInTesting() {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }] as any);
  const created = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch: uniq('B') });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await receiveSample(t, created.body.id);
  const sub = await t.request.post(`/api/samples/${created.body.id}/transition`).set(H.analyst1).send({ action: 'submit', expectedVersion: 1 });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const [r] = await sql('SELECT id FROM results WHERE sample_id = $1', [created.body.id]);
  return { id: created.body.id as string, resultId: r.id as string };
}
const resultVersion = async (id: string) => (await sql('SELECT version FROM results WHERE id = $1', [id]))[0].version as number;
const sampleVersion = async (id: string) => (await sql('SELECT version FROM samples WHERE id = $1', [id]))[0].version as number;
const enter = async (s: { id: string; resultId: string }, body: Record<string, unknown>) => {
  const res = await t.request.put(`/api/samples/${s.id}/results/${s.resultId}`).set(H.analyst1)
    .send({ reason: 'routine entry', expectedVersion: await resultVersion(s.resultId), ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const attach = async (s: { id: string; resultId: string }, file = pdf()) => {
  const res = await t.request.post(`/api/samples/${s.id}/attachments`).set(H.analyst1).set('Content-Type', 'application/octet-stream')
    .query({ fileName: 'run.pdf', resultId: s.resultId }).send(file);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.attachment;
};
const toReview = async (s: { id: string }) => {
  const res = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'review', expectedVersion: await sampleVersion(s.id), password: PW });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const approve = async (s: { id: string }) => t.request.post(`/api/samples/${s.id}/transition`).set(H.reviewer)
  .send({ action: 'approve', expectedVersion: await sampleVersion(s.id), password: PW, reason: 'Results reviewed' });
const checklist = async (s: { id: string }, who = 'reviewer') => {
  const res = await t.request.get(`/api/samples/${s.id}/review-checklist`).set(H[who]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const status = (body: any) => Object.fromEntries(body.items.map((i: any) => [i.code, i.status]));

describe('the server items', () => {
  it('a sample measured on a calibrated instrument with its raw data attached is ready, and is approved', async () => {
    const s = await sampleInTesting();
    const inst = await instrument();
    await enter(s, { value: '99.2', instrumentId: inst });
    await attach(s);
    await toReview(s);
    const c = await checklist(s);
    expect(status(c)).toEqual({
      RESULTS_ENTERED: 'pass', RESULT_HISTORY: 'pass', REINTEGRATIONS_APPROVED: 'na', INSTRUMENTS_CALIBRATED: 'pass',
      RAW_DATA_ATTACHED: 'pass', ATTACHMENTS_INTACT: 'pass', SYSTEM_SUITABILITY: 'pass',
    });
    expect(c.ready).toBe(true);
    expect(c.attestationCodes).toEqual(['AUDIT_TRAIL_REVIEWED', 'RAW_DATA_VERIFIED', 'REAGENTS_IN_DATE']);
    const res = await approve(s);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('approving with a failed server item is 400 listing the items, and costs the signer nothing', async () => {
    const s = await sampleInTesting();
    const inst = await instrument();
    await enter(s, { value: '99.2', instrumentId: inst });
    await toReview(s);
    expect(status(await checklist(s)).RAW_DATA_ATTACHED).toBe('fail');

    const before = (await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-reviewer'`))[0].failed_attempts;
    const res = await t.request.post(`/api/samples/${s.id}/transition`).set(H.reviewer)
      .send({ action: 'approve', expectedVersion: await sampleVersion(s.id), password: 'wrong-password', reason: 'x' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('TRANSITION_BLOCKED');
    const item = res.body.details.find((d: any) => d.guard === 'review-checklist');
    expect(item.message).toMatch(/RAW_DATA_ATTACHED/);
    expect(item.message).toContain('Assay');
    expect((await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-reviewer'`))[0].failed_attempts).toBe(before);
    expect((await sql('SELECT state FROM samples WHERE id = $1', [s.id]))[0].state).toBe('Pending Review');
  });

  it('a reintegration without its QA signature blocks approval until QA signs it', async () => {
    const s = await sampleInTesting();
    await enter(s, { value: '99.0' });
    await enter(s, { value: '99.4', reasonCode: 'REINTEGRATION', reason: 'shoulder peak separated' });
    await toReview(s);
    expect(status(await checklist(s)).REINTEGRATIONS_APPROVED).toBe('fail');
    const blocked = await approve(s);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/REINTEGRATIONS_APPROVED/);

    const [v] = await sql(`SELECT id FROM result_versions WHERE result_id = $1 AND change_code = 'REINTEGRATION'`, [s.resultId]);
    const signed = await t.request.post(`/api/result-versions/${v.id}/sign`).set(H.qa).send({ password: PW, reason: 'Integration events reviewed' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(status(await checklist(s)).REINTEGRATIONS_APPROVED).toBe('pass');
    expect((await approve(s)).status).toBe(200);
  });

  it('a damaged or missing file fails ATTACHMENTS_INTACT', async () => {
    const s = await sampleInTesting();
    await enter(s, { value: '99.0' });
    const file = pdf();
    await attach(s, file);
    await toReview(s);
    expect(status(await checklist(s)).ATTACHMENTS_INTACT).toBe('pass');
    const stored = path.join(BLOBS, sha(file));
    fs.chmodSync(stored, 0o644);
    fs.appendFileSync(stored, 'x');
    const c = await checklist(s);
    expect(status(c).ATTACHMENTS_INTACT).toBe('fail');
    expect(c.items.find((i: any) => i.code === 'ATTACHMENTS_INTACT').detail).toContain('run.pdf');
    expect((await approve(s)).status).toBe(400);
  });

  it('an instrument that was out of calibration when the result was measured fails INSTRUMENTS_CALIBRATED', async () => {
    const s = await sampleInTesting();
    const inst = await instrument();
    await enter(s, { value: '99.0', instrumentId: inst });
    await attach(s);
    await toReview(s);
    // History: the calibration due on 2026-01-10 was only done on 2026-02-01; the result is recorded as measured on 2026-01-15.
    await sql(`UPDATE results SET entered_at = '2026-01-15T10:00:00Z' WHERE id = $1`, [s.resultId]);
    await sql(`INSERT INTO calibration_history (id, instrument_id, performed_by, performed_at, previous_due_date, new_due_date, status_before, status_after, instrument_version, reason)
      VALUES ($1, $2, 'usr-qa', '2026-02-01T09:00:00Z', '2026-01-10', '2099-12-31', 'Active', 'Active', 2, 'annual calibration')`, [uniq('CAL'), inst]);
    const c = await checklist(s);
    expect(status(c).INSTRUMENTS_CALIBRATED).toBe('fail');
    expect(c.items.find((i: any) => i.code === 'INSTRUMENTS_CALIBRATED').detail).toContain('2026-01-10');
  });

  it('a value changed outside the result path fails RESULT_HISTORY', async () => {
    const s = await sampleInTesting();
    await enter(s, { value: '99.0' });
    await toReview(s);
    await sql(`UPDATE results SET value = '101.0' WHERE id = $1`, [s.resultId]);
    const c = await checklist(s);
    expect(status(c).RESULT_HISTORY).toBe('fail');
    expect(c.ready).toBe(false);
  });
});

describe('the reviewer records the checklist', () => {
  it('records the attestations with the server items as they stand; others may not; the record is append-only', async () => {
    const s = await sampleInTesting();
    await enter(s, { value: '99.0' });
    const early = await t.request.post(`/api/samples/${s.id}/review-checklist`).set(H.reviewer)
      .send({ attestations: ['AUDIT_TRAIL_REVIEWED'], expectedVersion: await sampleVersion(s.id) });
    expect(early.status).toBe(409);
    await toReview(s);
    const version = await sampleVersion(s.id);
    const post = (who: string, body: Record<string, unknown>) => t.request.post(`/api/samples/${s.id}/review-checklist`).set(H[who]).send(body);

    expect((await post('analyst2', { attestations: ['AUDIT_TRAIL_REVIEWED'], expectedVersion: version })).status).toBe(403);
    expect((await post('reviewer', { attestations: ['LOOKED_AT_IT'], expectedVersion: version })).status).toBe(400);
    expect((await post('reviewer', { attestations: ['AUDIT_TRAIL_REVIEWED'], expectedVersion: version - 1 })).status).toBe(409);
    expect((await post('reviewer', { attestations: ['AUDIT_TRAIL_REVIEWED'], expectedVersion: version, recordedBy: 'usr-qa' })).status).toBe(400);

    const ok = await post('reviewer', { attestations: ['AUDIT_TRAIL_REVIEWED', 'RAW_DATA_VERIFIED', 'REAGENTS_IN_DATE'], comment: 'Chromatograms compared with the reported values.', expectedVersion: version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const [row] = await sql('SELECT sample_version, attestations, items, server_items_passed, recorded_by FROM review_checklists WHERE sample_id = $1', [s.id]);
    expect(row).toMatchObject({ sample_version: version, server_items_passed: true, recorded_by: 'usr-reviewer' });
    expect(row.attestations).toEqual(['AUDIT_TRAIL_REVIEWED', 'RAW_DATA_VERIFIED', 'REAGENTS_IN_DATE']);
    expect(row.items.map((i: any) => i.code)).toContain('RESULT_HISTORY');
    expect(await sql(`SELECT action FROM audit_trail WHERE entity = 'ReviewChecklist' AND entity_id = $1`, [ok.body.checklist.id])).toEqual([{ action: 'Create' }]);
    await expect(sql(`UPDATE review_checklists SET server_items_passed = false WHERE sample_id = $1`, [s.id])).rejects.toThrow(/append-only/);

    const c = await checklist(s, 'qa');
    expect(c.latest).toMatchObject({ id: ok.body.checklist.id, recordedBy: 'usr-reviewer', attestations: ['AUDIT_TRAIL_REVIEWED', 'RAW_DATA_VERIFIED', 'REAGENTS_IN_DATE'] });
  });
});
