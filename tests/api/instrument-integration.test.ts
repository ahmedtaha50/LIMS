/**
 * Roadmap M21 (r2-instrument-integration): capture profiles, ingestion, acceptance.
 *
 *   profile     a mapping is configuration that changes which number becomes which result: Draft until a second person signs
 *               INSTRUMENT_PROFILE_APPROVAL; editing an Approved profile makes it Draft again; strict inputs; stale version 409
 *   ingestion   the file is hashed into the blob store and registered once; identical content is refused and audited; a malformed
 *               file is registered as Failed with a readable message (no value staged, analysts notified); an overdue instrument
 *               is refused
 *   acceptance  a named analyst accepts a staged value through saveResult (entry roles, calibrated instrument, result version),
 *               with its source recorded and the file attached as raw data; double accept and stale versions are 409
 *   guard       a sample with an unaccepted import cannot move to Pending Review
 *   controls    result_sources, the usage log and profile revisions are append-only; instrument_files changes only its disposition
 *
 * Needs the gate patch (docs/changes/r2-instrument-integration.gate.patch).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { race, uniq } from '../helpers/fixtures';
import { FIXTURES, PW, approvedProfile, fixture, instrument, sampleInTesting, tempDir, upload } from './instrument-fixtures';

const BLOBS = tempDir('instr-blobs');
const WATCH = tempDir('instr-watch');
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
  fs.rmSync(WATCH, { recursive: true, force: true });
});
const sql = (text: string, params: unknown[] = []) => t.db.pool.query(text, params).then(r => r.rows);
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const GENERIC = { sampleColumn: 'Sample', fixedParameter: 'Assay', valueColumn: 'Result', fixedUnit: '%' };
const csv = (sampleId: string, value: string, salt = crypto.randomBytes(4).toString('hex')) => `Sample,Result,Run\n${sampleId},${value},${salt}\n`;

async function setup(parser = 'generic-csv', mapping: Record<string, unknown> = GENERIC, due?: string) {
  const inst = await instrument(t, { due });
  const profile = await approvedProfile(t, H, { instrumentId: inst, parser, mapping, watchDir: WATCH });
  return { inst, profile };
}
const rowsOf = (fileId: string) => sql('SELECT * FROM instrument_import_rows WHERE file_id = $1 ORDER BY line_no', [fileId]);

describe('capture profiles', () => {
  it('start as Draft; a second person approves with an e-signature bound to the profile version', async () => {
    const inst = await instrument(t);
    const created = await t.request.post('/api/instrument-profiles').set(H.qa)
      .send({ name: uniq('Balance profile'), instrumentId: inst, parser: 'balance-text', watchDir: WATCH, mapping: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'Draft', version: 1, createdBy: 'usr-qa', approvedBy: null, mapping: { parameter: 'Weight' } });

    // the author cannot approve (403, no attempt counted); an Analyst cannot approve at all
    const before = (await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts;
    const self = await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.qa).send({ expectedVersion: 1, password: 'wrong-password' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SOD_VIOLATION');
    expect((await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts).toBe(before);
    expect((await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.analyst1).send({ expectedVersion: 1, password: PW })).status).toBe(403);

    const stale = await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.admin).send({ expectedVersion: 7, password: PW });
    expect(stale.status).toBe(409);
    const ok = await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.admin).send({ expectedVersion: 1, password: PW });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.profile).toMatchObject({ status: 'Approved', approvedBy: 'usr-admin', version: 2 });
    expect(ok.body.signature).toMatchObject({ meaningCode: 'INSTRUMENT_PROFILE_APPROVAL', recordVersion: 2 });
    const verify = await t.request.get(`/api/signatures/verify/${ok.body.signature.id}`).set(H.qa);
    expect(verify.body.valid, JSON.stringify(verify.body)).toBe(true);
    expect((await t.request.post(`/api/instrument-profiles/${created.body.id}/approve`).set(H.admin).send({ expectedVersion: 2, password: PW })).status).toBe(409);
    expect((await sql(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'InstrumentProfile' AND entity_id = $1`, [created.body.id]))[0].n).toBeGreaterThanOrEqual(2);
  });

  it('an edit of an Approved profile withdraws the approval, and the old signature still verifies', async () => {
    const { profile } = await setup('ph-csv', {});
    const sig = (await sql(`SELECT id FROM signatures WHERE entity_type = 'InstrumentProfile' AND entity_id = $1`, [profile.id]))[0].id;
    const edit = await t.request.put(`/api/instrument-profiles/${profile.id}`).set(H.qa).send({ expectedVersion: profile.version, mapping: { parameter: 'pH value' }, reason: 'Parameter renamed' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body).toMatchObject({ status: 'Draft', approvedBy: null, version: profile.version + 1, mapping: { parameter: 'pH value' } });
    expect((await sql(`SELECT count(*)::int AS n FROM instrument_profile_revisions WHERE profile_id = $1`, [profile.id]))[0].n).toBe(3);
    const verify = await t.request.get(`/api/signatures/verify/${sig}`).set(H.qa);
    expect(verify.body.valid, JSON.stringify(verify.body)).toBe(true);
    // the editor cannot approve the new content; a stale edit is 409; nobody captures while it is a Draft
    expect((await t.request.post(`/api/instrument-profiles/${profile.id}/approve`).set(H.qa).send({ expectedVersion: edit.body.version, password: PW })).status).toBe(403);
    expect((await t.request.put(`/api/instrument-profiles/${profile.id}`).set(H.qa).send({ expectedVersion: profile.version, name: 'x y z', reason: 'stale edit' })).status).toBe(409);
    const draftUpload = await upload(t, H.analyst1, profile.id, 'ph.csv', fixture('ph.csv'));
    expect(draftUpload.status).toBe(409);
    expect(draftUpload.body.code).toBe('PROFILE_NOT_APPROVED');
  });

  it('refuses unknown keys, an invalid mapping, an unsafe folder and the wrong people', async () => {
    const inst = await instrument(t);
    const base = { name: uniq('P'), instrumentId: inst, parser: 'generic-csv', watchDir: WATCH, mapping: GENERIC };
    const post = (b: Record<string, unknown>, who = 'qa') => t.request.post('/api/instrument-profiles').set(H[who]).send(b);
    expect((await post({ ...base, status: 'Approved' })).status).toBe(400);
    expect((await post({ ...base, approvedBy: 'usr-qa' })).status).toBe(400);
    expect((await post({ ...base, version: 5 })).status).toBe(400);
    const badMap = await post({ ...base, name: uniq('P'), mapping: { valueColumn: 'Result' } });
    expect(badMap.status).toBe(400);
    expect(badMap.body.error).toMatch(/parameterColumn/);
    expect((await post({ ...base, name: uniq('P'), mapping: { ...GENERIC, delimeter: ';' } })).status).toBe(400);
    expect((await post({ ...base, name: uniq('P'), watchDir: 'relative/dir' })).body.error).toMatch(/absolute/);
    expect((await post({ ...base, name: uniq('P'), watchDir: `${WATCH}/../etc` })).body.error).toMatch(/\.\./);
    expect((await post({ ...base, name: uniq('P'), watchDir: BLOBS })).body.error).toMatch(/system uses/);
    expect((await post({ ...base, name: uniq('P'), glob: '../*.csv' })).status).toBe(400);
    expect((await post({ ...base, name: uniq('P'), instrumentId: 'INST-NOPE' })).status).toBe(400);
    expect((await post({ ...base, name: uniq('P') }, 'analyst1')).status).toBe(403);
    expect((await post({ ...base, name: uniq('P') }, 'reviewer')).status).toBe(403);
    const one = await post({ ...base, name: 'Same name' });
    expect(one.status).toBe(201);
    expect((await post({ ...base, name: 'Same name' })).status).toBe(409);
  });

  it('a dry run returns the rows or the readable error and stores nothing', async () => {
    const before = (await sql('SELECT count(*)::int AS n FROM instrument_files'))[0].n;
    const ok = await t.request.post('/api/instrument-profiles/dry-run').set(H.qa).send({ parser: 'ph-csv', content: fixture('ph.csv').toString() });
    expect(ok.body).toMatchObject({ ok: true, rowCount: 2 });
    expect(ok.body.rows[0]).toMatchObject({ sampleRef: 'SMP-FX-1', parameter: 'pH', value: '7.02' });
    const bad = await t.request.post('/api/instrument-profiles/dry-run').set(H.qa).send({ parser: 'ph-csv', content: fixture('ph-malformed.csv').toString() });
    expect(bad.body).toMatchObject({ ok: false, error: 'Line 2: the pH "seven" is not a number.' });
    expect((await sql('SELECT count(*)::int AS n FROM instrument_files'))[0].n).toBe(before);
  });

  it('a retired profile is final', async () => {
    const { profile } = await setup();
    const retired = await t.request.post(`/api/instrument-profiles/${profile.id}/retire`).set(H.qa).send({ expectedVersion: profile.version, reason: 'Instrument replaced' });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.status).toBe('Retired');
    expect((await t.request.put(`/api/instrument-profiles/${profile.id}`).set(H.qa).send({ expectedVersion: retired.body.version, name: 'new name', reason: 'try again' })).status).toBe(423);
    expect((await upload(t, H.analyst1, profile.id, 'a.csv', csv('S-1', '1'))).status).toBe(409);
  });
});

describe('ingestion', () => {
  it('a balance export creates one file row with the right sha256, and the same content again is refused and audited', async () => {
    const { profile, inst } = await setup('balance-text', {});
    const body = fixture('balance.txt');
    const first = await upload(t, H.analyst1, profile.id, 'balance.txt', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: 'Captured', rowCount: 3, file: { sha256: sha(body), bytes: body.length, parseStatus: 'Parsed', instrumentId: inst, disposition: 'Processed', receivedBy: 'usr-analyst1', source: 'upload' } });
    expect(fs.readFileSync(path.join(BLOBS, sha(body)))).toEqual(body);
    const rows = await rowsOf(first.body.file.id);
    expect(rows.map(r => [r.sample_ref, r.parameter, r.value, r.unit, r.state])).toEqual([
      ['SMP-FX-1', 'Weight', '12.3456', 'g', 'Pending'], ['SMP-FX-2', 'Weight', '-0.0020', 'g', 'Pending'], [null, 'Weight', '101.5', 'mg', 'Pending'],
    ]);
    expect((await sql(`SELECT event, user_id FROM instrument_usage_log WHERE file_id = $1`, [first.body.file.id]))).toEqual([{ event: 'DataCaptured', user_id: 'usr-analyst1' }]);
    expect((await sql(`SELECT count(*)::int AS n FROM audit_trail WHERE entity = 'InstrumentFile' AND entity_id = $1 AND action = 'Create'`, [first.body.file.id]))[0].n).toBe(1);

    const dup = await upload(t, H.analyst2, profile.id, 'renamed copy.txt', body);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_FILE');
    expect((await sql('SELECT count(*)::int AS n FROM instrument_files WHERE sha256 = $1', [sha(body)]))[0].n).toBe(1);
    const audit = await sql(`SELECT user_id, reason FROM audit_trail WHERE action = 'DuplicateRefused' AND entity_id = $1`, [first.body.file.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe('usr-analyst2');
    expect(audit[0].reason).toContain('renamed copy.txt');
  });

  it('two uploads of one new file at once register it once', async () => {
    const { profile } = await setup();
    const body = Buffer.from(csv('S-RACE', '5.5'));
    const codes = await race(5, () => upload(t, H.analyst1, profile.id, 'race.csv', body));
    expect(codes.filter(c => c === 201)).toHaveLength(1);
    expect(codes.filter(c => c === 409)).toHaveLength(4);
    expect((await sql('SELECT count(*)::int AS n FROM instrument_files WHERE sha256 = $1', [sha(body)]))[0].n).toBe(1);
  });

  it('a malformed file is Failed with a readable message, keeps the raw file, stages nothing and notifies the analysts', async () => {
    const { profile } = await setup('ph-csv', {});
    const body = fixture('ph-malformed.csv');
    const res = await upload(t, H.analyst1, profile.id, 'ph.csv', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'Failed', message: 'Line 2: the pH "seven" is not a number.', file: { parseStatus: 'Failed', parseError: 'Line 2: the pH "seven" is not a number.', rowCount: 0, disposition: 'Error' } });
    expect(await rowsOf(res.body.file.id)).toHaveLength(0);
    expect(fs.existsSync(path.join(BLOBS, sha(body)))).toBe(true);
    expect((await sql(`SELECT count(*)::int AS n FROM instrument_usage_log WHERE file_id = $1`, [res.body.file.id]))[0].n).toBe(0);
    const ev = await sql(`SELECT payload, audience FROM outbox_events WHERE type = 'instrument.import_failed' AND entity_id = $1`, [res.body.file.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ fileName: 'ph.csv', problem: 'Line 2: the pH "seven" is not a number.' });
    const detail = await t.request.get(`/api/instrument-files/${res.body.file.id}`).set(H.qa);
    expect(detail.body.file.parseError).toBe('Line 2: the pH "seven" is not a number.');
    const list = await t.request.get('/api/instrument-files').set(H.qa);
    expect(list.body.find((f: any) => f.id === res.body.file.id)).toMatchObject({ parseStatus: 'Failed', profileName: expect.any(String) });
    // a binary file and an empty file
    expect((await upload(t, H.analyst1, profile.id, 'bin.csv', Buffer.from([0x53, 0x61, 0, 1, 2]))).body.message).toMatch(/binary/);
    expect((await upload(t, H.analyst1, profile.id, 'empty.csv', '')).status).toBe(400);
  });

  it('an instrument past its calibration, or out of service, captures nothing', async () => {
    const { profile, inst } = await setup('generic-csv', GENERIC, '2020-01-01');
    const overdue = await upload(t, H.analyst1, profile.id, 'late.csv', csv('S-1', '99.0'));
    expect(overdue.status).toBe(201);
    expect(overdue.body.status).toBe('Failed');
    expect(overdue.body.message).toMatch(/past its calibration due date \(2020-01-01\)/);
    expect(await rowsOf(overdue.body.file.id)).toHaveLength(0);
    await sql(`UPDATE instruments SET calibration_due_date = '2099-12-31', status = 'Out of Service' WHERE id = $1`, [inst]);
    const out = await upload(t, H.analyst1, profile.id, 'oos.csv', csv('S-1', '99.1'));
    expect(out.body.message).toMatch(/is Out of Service/);
  });

  it('only people who enter results hand in files; the file is the body, and a bigger file than the limit is refused', async () => {
    const { profile } = await setup();
    expect((await upload(t, H.qa, profile.id, 'a.csv', csv('S-1', '1'))).status).toBe(403);
    expect((await upload(t, H.reviewer, profile.id, 'a.csv', csv('S-1', '1'))).status).toBe(403);
    const plain = await t.request.post('/api/instrument-files').set(H.analyst1).set('Content-Type', 'text/plain').query({ profileId: profile.id, fileName: 'a.csv' }).send('Sample,Result');
    expect(plain.status).toBe(415);
    expect((await t.request.post('/api/instrument-files').set(H.analyst1).query({ profileId: profile.id, fileName: 'a.csv' }).send({ x: 1 })).status).toBe(400);
    expect((await t.request.post('/api/instrument-files').set(H.analyst1).set('Content-Type', 'application/octet-stream').query({ profileId: profile.id, fileName: '../a.csv' }).send('x')).status).toBe(400);
    expect((await t.request.post('/api/instrument-files').set(H.analyst1).set('Content-Type', 'application/octet-stream').query({ profileId: profile.id, fileName: 'a.csv', by: 'usr-admin' }).send('x')).status).toBe(400);
    const big = await upload(t, H.analyst1, profile.id, 'big.csv', Buffer.alloc(5 * 1024 * 1024 + 1, 0x31));
    expect(big.status).toBe(413);
  });

  it('the stored file can be downloaded after it is re-hashed; a damaged file is refused and audited', async () => {
    const { profile } = await setup();
    const body = Buffer.from(csv('S-DL', '98.8'));
    const up = await upload(t, H.analyst1, profile.id, 'dl.csv', body);
    const ok = await t.request.get(`/api/instrument-files/${up.body.file.id}/content`).set(H.reviewer).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(body);
    expect(ok.headers['x-content-sha256']).toBe(sha(body));
    // replace the stored file by other bytes (removing it first: the store keeps files read-only)
    fs.rmSync(path.join(BLOBS, sha(body)));
    fs.writeFileSync(path.join(BLOBS, sha(body)), 'tampered');
    const bad = await t.request.get(`/api/instrument-files/${up.body.file.id}/content`).set(H.reviewer);
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INSTRUMENT_FILE_INTEGRITY_FAILED');
    expect((await sql(`SELECT user_id FROM audit_trail WHERE action = 'IntegrityCheckFailed' AND entity_id = $1`, [up.body.file.id]))).toEqual([{ user_id: 'usr-reviewer' }]);
    // the staged values of a damaged file cannot be accepted either
    const s = await sampleInTesting(t, H);
    const up2 = await upload(t, H.analyst1, profile.id, 'dl2.csv', csv(s.id, '99.1'));
    fs.rmSync(path.join(BLOBS, up2.body.file.sha256));
    const [row] = await rowsOf(up2.body.file.id);
    const acc = await t.request.post(`/api/instrument-imports/${row.id}/accept`).set(H.analyst1).send({ expectedVersion: 1, expectedResultVersion: 1 });
    expect(acc.status).toBe(409);
    expect(acc.body.code).toBe('INSTRUMENT_FILE_INTEGRITY_FAILED');
  });
});

describe('acceptance', () => {
  async function staged(value = '99.2', over: { sampleId?: string; due?: string } = {}) {
    const { profile, inst } = await setup('generic-csv', GENERIC, over.due);
    const s = await sampleInTesting(t, H);
    const up = await upload(t, H.analyst1, profile.id, 'run.csv', csv(over.sampleId ?? s.id, value));
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const [row] = await rowsOf(up.body.file.id);
    return { profile, inst, s, up: up.body, row };
  }
  const accept = (rowId: string, body: Record<string, unknown>, who = 'analyst1') => t.request.post(`/api/instrument-imports/${rowId}/accept`).set(H[who]).send(body);

  it('a named analyst accepts the value: it becomes the result with its source, and the file is its raw data', async () => {
    const { s, up, row, inst } = await staged('99.2');
    const listed = await t.request.get('/api/instrument-imports').query({ sampleId: s.id }).set(H.analyst1);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: row.id, value: '99.2', fileName: 'run.csv', match: { resultId: s.resultId, version: 1, sampleState: 'Testing' } });

    const res = await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.row).toMatchObject({ state: 'Accepted', resultId: s.resultId, decidedBy: 'usr-analyst1' });
    const [result] = await sql('SELECT value, instrument_id, entered_by, version FROM results WHERE id = $1', [s.resultId]);
    expect(result).toMatchObject({ value: '99.2', instrument_id: inst, entered_by: 'usr-analyst1', version: 2 });
    const [source] = await sql('SELECT * FROM result_sources WHERE result_id = $1', [s.resultId]);
    expect(source).toMatchObject({ result_version: 2, source: 'instrument', file_id: up.file.id, import_row_id: row.id, sha256: up.file.sha256, accepted_by: 'usr-analyst1' });
    expect((await sql('SELECT change_code, reason FROM result_versions WHERE result_id = $1 AND result_version = 2', [s.resultId]))[0].reason).toContain('run.csv');
    expect((await sql(`SELECT event, sample_id, result_id, user_id FROM instrument_usage_log WHERE instrument_id = $1 ORDER BY at, id`, [inst])).map(r => r.event)).toEqual(['DataCaptured', 'ResultAccepted']);
    expect((await sql(`SELECT sha256, result_id FROM attachments WHERE sample_id = $1`, [s.id]))).toEqual([{ sha256: up.file.sha256, result_id: s.resultId }]);
    expect((await sql(`SELECT user_id FROM audit_trail WHERE action = 'Accept' AND entity_id = $1`, [row.id]))).toEqual([{ user_id: 'usr-analyst1' }]);
    const src = await t.request.get(`/api/samples/${s.id}/result-sources`).set(H.reviewer);
    expect(src.body[0]).toMatchObject({ parameter: 'Assay', fileName: 'run.csv', acceptedBy: 'usr-analyst1', sha256: up.file.sha256 });
    const log = await t.request.get(`/api/instruments/${inst}/usage-log`).set(H.qa);
    expect(log.body.map((r: any) => r.event).sort()).toEqual(['DataCaptured', 'ResultAccepted']);
    // the review checklist finds the raw data and the history consistent
    const checklist = await t.request.get(`/api/samples/${s.id}/review-checklist`).set(H.reviewer);
    expect(Object.fromEntries(checklist.body.items.map((i: any) => [i.code, i.status]))).toMatchObject({ RAW_DATA_ATTACHED: 'pass', ATTACHMENTS_INTACT: 'pass', RESULT_HISTORY: 'pass', INSTRUMENTS_CALIBRATED: 'pass' });
  });

  it('a stale value version or result version is 409, a second accept is 409, and the value is accepted once under concurrency', async () => {
    const { row, s } = await staged('99.3');
    expect((await accept(row.id, { expectedVersion: 9, expectedResultVersion: 1 })).status).toBe(409);
    expect((await accept(row.id, { expectedVersion: 1, expectedResultVersion: 9 })).status).toBe(409);
    expect((await sql('SELECT state FROM instrument_import_rows WHERE id = $1', [row.id]))[0].state).toBe('Pending');
    const codes = await race(4, () => accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 }));
    expect(codes.filter(c => c === 200)).toHaveLength(1);
    expect(codes.filter(c => c === 409)).toHaveLength(3);
    expect((await sql('SELECT count(*)::int AS n FROM result_sources WHERE result_id = $1', [s.resultId]))[0].n).toBe(1);
    expect((await accept(row.id, { expectedVersion: 1, expectedResultVersion: 2 })).body.code).toBe('IMPORT_ALREADY_DECIDED');
  });

  it('an instrument that became overdue after the capture is refused, and nothing changes', async () => {
    const { row, s, inst } = await staged('99.4');
    await sql(`UPDATE instruments SET calibration_due_date = '2020-01-01' WHERE id = $1`, [inst]);
    const res = await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past its calibration due date/);
    expect((await sql('SELECT value, version FROM results WHERE id = $1', [s.resultId]))[0]).toMatchObject({ value: null, version: 1 });
    expect((await sql('SELECT state, version FROM instrument_import_rows WHERE id = $1', [row.id]))[0]).toMatchObject({ state: 'Pending', version: 1 });
    expect((await sql('SELECT count(*)::int AS n FROM result_sources WHERE import_row_id = $1', [row.id]))[0].n).toBe(0);
  });

  it('only entry roles accept or reject; a value cannot be moved to another sample; units must agree; no value in another state', async () => {
    const { row, s, profile } = await staged('99.5');
    expect((await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 }, 'qa')).status).toBe(403);
    expect((await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 }, 'reviewer')).status).toBe(403);
    expect((await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1, status: 'Accepted' })).status).toBe(400);
    expect((await t.request.post(`/api/instrument-imports/${row.id}/reject`).set(H.qa).send({ expectedVersion: 1, reason: 'not mine to reject' })).status).toBe(403);

    // another sample's result
    const other = await sampleInTesting(t, H);
    const moved = await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1, resultId: other.resultId });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toContain(`measured for sample ${s.id}`);

    // a unit that differs from the result's unit (the result is entered in %)
    const mgProfile = (await setup('generic-csv', { ...GENERIC, fixedUnit: 'mg' })).profile;
    const mg = await upload(t, H.analyst1, mgProfile.id, 'mg.csv', csv(s.id, '99.5'));
    const [mgRow] = await rowsOf(mg.body.file.id);
    const unit = await accept(mgRow.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(unit.status).toBe(400);
    expect(unit.body.error).toContain('Unit mismatch');
    // a value that names no sample needs a resultId
    const none = await upload(t, H.analyst1, profile.id, 'none.csv', `Sample,Result,Run\n,98.9,${crypto.randomBytes(3).toString('hex')}\n`);
    const [noneRow] = await rowsOf(none.body.file.id);
    const miss = await accept(noneRow.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(miss.status).toBe(400);
    expect(miss.body.error).toMatch(/names no sample/);
    const given = await accept(noneRow.id, { expectedVersion: 1, expectedResultVersion: 1, resultId: s.resultId, reason: 'Sample name was missing in the export' });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    expect((await sql('SELECT value FROM results WHERE id = $1', [s.resultId]))[0].value).toBe('98.9');
  });

  it('a value with no matching parameter, or an unknown sample, is 400 and can be rejected with a reason', async () => {
    const { profile } = await setup('generic-csv', { ...GENERIC, fixedParameter: 'Water' });
    const s = await sampleInTesting(t, H);
    const up = await upload(t, H.analyst1, profile.id, 'w.csv', csv(s.id, '1.2'));
    const [row] = await rowsOf(up.body.file.id);
    const res = await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no result for the parameter "Water"');
    expect((await t.request.post(`/api/instrument-imports/${row.id}/reject`).set(H.analyst1).send({ expectedVersion: 1, reason: 'no' })).status).toBe(400);
    const rej = await t.request.post(`/api/instrument-imports/${row.id}/reject`).set(H.analyst1).send({ expectedVersion: 1, reason: 'Parameter is not part of this sample' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body).toMatchObject({ state: 'Rejected', decidedBy: 'usr-analyst1', decisionReason: 'Parameter is not part of this sample' });
    expect((await sql(`SELECT reason FROM audit_trail WHERE action = 'Reject' AND entity_id = $1`, [row.id]))[0].reason).toBe('Parameter is not part of this sample');
    expect((await t.request.post(`/api/instrument-imports/${row.id}/reject`).set(H.analyst1).send({ expectedVersion: 1, reason: 'Parameter is not part of this sample' })).status).toBe(409);
    expect((await sql('SELECT count(*)::int AS n FROM result_sources WHERE import_row_id = $1', [row.id]))[0].n).toBe(0);
  });

  it('an OOS value is accepted like any other: it opens its investigation', async () => {
    const { row, s } = await staged('90.0');
    const res = await accept(row.id, { expectedVersion: 1, expectedResultVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.isOos).toBe(true);
    expect((await sql('SELECT count(*)::int AS n FROM oos_investigations WHERE result_id = $1', [s.resultId]))[0].n).toBe(1);
  });
});

describe('the sample cannot go to review with unaccepted imports', () => {
  it('blocks Pending Review (400 TRANSITION_BLOCKED, no signature attempt spent) until every import naming the sample is decided', async () => {
    const { profile } = await setup();
    const s = await sampleInTesting(t, H);
    const entered = await t.request.put(`/api/samples/${s.id}/results/${s.resultId}`).set(H.analyst1).send({ value: '99.0', reason: 'manual entry', expectedVersion: 1 });
    expect(entered.status, JSON.stringify(entered.body)).toBe(200);
    const up = await upload(t, H.analyst1, profile.id, 'late.csv', csv(s.id, '99.1'));
    const [row] = await rowsOf(up.body.file.id);
    const sampleVersion = async () => (await sql('SELECT version FROM samples WHERE id = $1', [s.id]))[0].version;
    const before = (await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst1'`))[0].failed_attempts;
    const blocked = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'review', expectedVersion: await sampleVersion(), password: 'wrong-password' });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(400);
    expect(blocked.body.code).toBe('TRANSITION_BLOCKED');
    const detail = blocked.body.details.find((d: any) => d.guard === 'unaccepted-imports');
    expect(detail.message).toContain('Assay (late.csv)');
    expect((await sql(`SELECT failed_attempts FROM users WHERE id = 'usr-analyst1'`))[0].failed_attempts).toBe(before);

    const rej = await t.request.post(`/api/instrument-imports/${row.id}/reject`).set(H.analyst1).send({ expectedVersion: 1, reason: 'Superseded by the manual entry' });
    expect(rej.status).toBe(200);
    const ok = await t.request.post(`/api/samples/${s.id}/transition`).set(H.analyst1).send({ action: 'review', expectedVersion: await sampleVersion(), password: PW });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await sql('SELECT state FROM samples WHERE id = $1', [s.id]))[0].state).toBe('Pending Review');
  });
});

describe('database controls', () => {
  it('result_sources, the usage log and the profile revisions refuse UPDATE, DELETE and TRUNCATE', async () => {
    const { profile } = await setup();
    const s = await sampleInTesting(t, H);
    const up = await upload(t, H.analyst1, profile.id, 'c.csv', csv(s.id, '99.0'));
    const [row] = await rowsOf(up.body.file.id);
    expect((await t.request.post(`/api/instrument-imports/${row.id}/accept`).set(H.analyst1).send({ expectedVersion: 1, expectedResultVersion: 1 })).status).toBe(200);
    for (const [table, set] of [['result_sources', `sha256 = '${'0'.repeat(64)}'`], ['instrument_usage_log', `event = 'DataCaptured'`], ['instrument_profile_revisions', `version = 99`]]) {
      await expect(sql(`UPDATE ${table} SET ${set}`)).rejects.toThrow(/append-only/);
      await expect(sql(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      await expect(sql(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
    }
  });

  it('a captured file keeps its hash, name and parse result for ever; only where it went may change', async () => {
    const { profile } = await setup();
    const up = await upload(t, H.analyst1, profile.id, 'f.csv', csv('S-F', '1.5'));
    const id = up.body.file.id;
    for (const set of [`sha256 = '${'1'.repeat(64)}'`, `file_name = 'other.csv'`, `parse_status = 'Failed'`, `row_count = 99`, `bytes = 5`, `received_by = 'usr-qa'`]) {
      await expect(sql(`UPDATE instrument_files SET ${set} WHERE id = $1`, [id]), set).rejects.toThrow(/only the disposition/);
    }
    await expect(sql('DELETE FROM instrument_files WHERE id = $1', [id])).rejects.toThrow(/only the disposition/);
    await expect(sql('TRUNCATE instrument_files CASCADE')).rejects.toThrow(/append-only/);
    await sql(`UPDATE instrument_files SET disposition = 'Error', disposition_note = 'moved by hand' WHERE id = $1`, [id]);
    expect((await sql('SELECT disposition FROM instrument_files WHERE id = $1', [id]))[0].disposition).toBe('Error');
  });

  it('the database refuses an approved profile without an approver and a decided value without a decider', async () => {
    const { profile } = await setup();
    await expect(sql(`UPDATE instrument_profiles SET approved_by = NULL WHERE id = $1`, [profile.id])).rejects.toThrow(/instrument_profiles_approval_check/);
    const up = await upload(t, H.analyst1, profile.id, 'g.csv', csv('S-G', '1.6'));
    const [row] = await rowsOf(up.body.file.id);
    await expect(sql(`UPDATE instrument_import_rows SET state = 'Accepted' WHERE id = $1`, [row.id])).rejects.toThrow(/instrument_import_rows_decision_check/);
  });
});

describe('the profile mapping files of the fixtures folder are what the tests read', () => {
  it('exist', () => { expect(fs.existsSync(path.join(FIXTURES, 'balance.txt'))).toBe(true); });
});
