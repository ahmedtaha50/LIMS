/**
 * Roadmap M35 (r2-audit-tamper): the signed audit-trail review, review by exception, the release interlock, the keyed chain, the
 * anchor and clock routes, and the signing block while the clock is in doubt. Through the real application (routes, route table,
 * release blockers and signRecord wired by docs/changes/r2-audit-tamper.gate.patch).
 *
 *   GET  /audit/exceptions?batch=B | ?from=&to=       the rows of the scope that need a reviewer's attention
 *   POST /audit/reviews                               the signed review (AUDIT_REVIEW) of a batch's rows or of a sequence range
 *   GET  /audit/reviews[?batch=B]                     reviews, newest first, with the batch's coverage
 *   GET|PUT /audit/review-settings                    "a review is required before release", changed only with AUDIT_REVIEW_SETTING
 *   GET  /audit/anchors, POST /audit/anchors, POST /audit/anchors/verify
 *   GET  /audit/clock, POST /audit/clock-anomalies/:id/acknowledge (CLOCK_ANOMALY_ACK)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { insertActiveSpec, uniq } from '../helpers/fixtures';

let t: TestApp;
let writeAudit: typeof import('../../src/db/utils').writeAudit;
let appDb: any;
const H: Record<string, { Authorization: string }> = {};
const anchorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-anchors-'));

beforeAll(async () => {
  process.env.AUDIT_ANCHOR_DIR = anchorDir;
  t = await startTestApp();
  writeAudit = (await import('../../src/db/utils')).writeAudit;
  appDb = (await import('../../src/db/index')).db;
  for (const u of ['admin', 'qa', 'reviewer', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});

const q = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const audit = (userId: string, action: string, entity: string, entityId: string, field: string, oldValue: string, newValue: string, reason = 'arranged by the test') =>
  appDb.transaction((tx: any) => writeAudit(tx, userId, action, entity, entityId, field, oldValue, newValue, reason));
const sign = { password: 'password' };

/** An Approved sample of `batch` registered by analyst1 through the API; returns the sample and its first result. */
async function sample(batch: string) {
  const material = uniq('Mat');
  await insertActiveSpec(t, material, [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null }] as any);
  const res = await t.request.post('/api/samples').set(H.analyst1).send({ material, batch });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await q(`UPDATE samples SET state = 'Approved' WHERE id = $1`, [res.body.id]);
  await q(`UPDATE results SET value = '99.0' WHERE sample_id = $1`, [res.body.id]);
  const [r] = await q('SELECT id FROM results WHERE sample_id = $1', [res.body.id]);
  return { id: res.body.id as string, resultId: r.id as string };
}
const release = (batch: string, body: Record<string, unknown> = {}) =>
  t.request.post(`/api/traceability/batch/${encodeURIComponent(batch)}/release`).set(H.qa).send({ ...sign, reason: 'Batch conforms', ...body });
const settings = async () => (await t.request.get('/api/audit/review-settings').set(H.qa)).body;
async function setRequired(on: boolean) {
  const s = await settings();
  if (s.requiredForRelease === on) return;
  const res = await t.request.put('/api/audit/review-settings').set(H.qa).send({ requiredForRelease: on, expectedVersion: s.version, ...sign, reason: 'Audit trail review before release, per SOP QA-017' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
/** A batch review signs what the reviewer was shown: unless the test says otherwise, it reads the scope first, as the screen does. */
async function review(who: string, body: Record<string, unknown>) {
  const extra: Record<string, unknown> = {};
  if (body.scope === 'batch' && !('throughSequence' in body)) {
    const shown = await t.request.get(`/api/audit/exceptions?batch=${encodeURIComponent(String(body.batch))}`).set(H.qa);
    if (shown.body.toSequence !== null) extra.throughSequence = shown.body.toSequence;
  }
  return t.request.post('/api/audit/reviews').set(H[who]).send({ ...sign, ...extra, ...body });
}

describe('review by exception', () => {
  it('lists the rows of a batch that need attention: edit after submit, failed signature, creator approving, and nothing else', async () => {
    const batch = uniq('B-EXC');
    const a = await sample(batch);
    const b = await sample(batch);
    await audit('usr-analyst1', 'Transition', 'Sample', a.id, 'state', 'Testing', 'Pending Review');
    await audit('usr-analyst1', 'Update', 'Result', a.resultId, 'value', '99.0', '99.4', 'Transcription error corrected');
    await audit('usr-reviewer', 'SignatureFailed', 'Sample', a.id, 'signature', '', '', 'Wrong password');
    await audit('usr-analyst1', 'Transition', 'Sample', b.id, 'state', 'Pending Review', 'Approved');

    const res = await t.request.get(`/api/audit/exceptions?batch=${encodeURIComponent(batch)}`).set(H.qa);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scope).toEqual({ kind: 'batch', batch });
    expect(res.body.rowCount).toBeGreaterThanOrEqual(6);
    const kinds = res.body.exceptions.map((e: any) => `${e.kind}:${e.entityId}`).sort();
    expect(kinds).toEqual([`EDIT_AFTER_SUBMIT:${a.resultId}`, `SAME_USER_CREATED_AND_APPROVED:${b.id}`, `SIGNATURE_FAILED:${a.id}`].sort());
    expect(res.body.authors).toEqual(expect.arrayContaining(['usr-analyst1', 'usr-reviewer']));
  });

  it('a sequence range also shows role and setting changes', async () => {
    const from = (await q('SELECT max(sequence)::int AS s FROM audit_trail'))[0].s + 1;
    await audit('usr-admin', 'RoleChange', 'User', 'usr-analyst2', 'role', 'Analyst', 'Reviewer', 'Promotion approved');
    await audit('usr-admin', 'Update', 'SystemSettings', 'default', 'sessionTimeoutMinutes', '15', '60', 'Longer sessions');
    await audit('usr-analyst1', 'Update', 'Sample', 'S-unrelated', 'material', 'x', 'y', 'typo');
    const to = (await q('SELECT max(sequence)::int AS s FROM audit_trail'))[0].s;
    const res = await t.request.get(`/api/audit/exceptions?from=${from}&to=${to}`).set(H.qa);
    expect(res.status).toBe(200);
    expect(res.body.exceptions.map((e: any) => e.kind)).toEqual(['ROLE_OR_SETTING_CHANGE', 'ROLE_OR_SETTING_CHANGE']);
    expect(res.body).toMatchObject({ scope: { kind: 'range' }, fromSequence: from, toSequence: to, rowCount: 3 });
  });

  it('bad scopes are 400; an Analyst may not read exceptions', async () => {
    expect((await t.request.get('/api/audit/exceptions').set(H.qa)).status).toBe(400);
    expect((await t.request.get('/api/audit/exceptions?from=9&to=3').set(H.qa)).status).toBe(400);
    expect((await t.request.get('/api/audit/exceptions?batch=B&from=1&to=2').set(H.qa)).status).toBe(400);
    expect((await t.request.get('/api/audit/exceptions?batch=B&extra=1').set(H.qa)).status).toBe(400);
    expect((await t.request.get('/api/audit/exceptions?batch=B').set(H.analyst1)).status).toBe(403);
  });
});

describe('the signed review', () => {
  it('is AUDIT_REVIEW by QA, names its scope and range, and needs a comment when there are exceptions', async () => {
    const batch = uniq('B-REV');
    const a = await sample(batch);
    await audit('usr-reviewer', 'SignatureFailed', 'Sample', a.id, 'signature', '', '', 'Wrong password');
    expect((await review('qa', { scope: 'batch', batch })).body.code).toBe('COMMENT_REQUIRED');
    expect((await review('analyst1', { scope: 'batch', batch, comment: 'Reviewed every entry, all acceptable.' })).status).toBe(403);
    expect((await review('qa', { scope: 'batch', batch, comment: 'x'.repeat(20), status: 'Signed' })).status).toBe(400);
    expect((await review('qa', { scope: 'batch', batch, comment: 'Reviewed every entry, all acceptable.', password: 'wrong' })).status).toBe(401);
    await q(`UPDATE users SET failed_attempts = 0, locked_at = NULL WHERE id = 'usr-qa'`);

    const res = await review('qa', { scope: 'batch', batch, comment: 'The failed signature was a typing error by the reviewer; no data changed.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const head = (await q(`SELECT max(sequence)::int AS s FROM audit_trail WHERE entity IN ('Sample', 'Result') AND entity_id IN ($1, $2)`, [a.id, a.resultId]))[0].s;
    expect(res.body.review).toMatchObject({ scope: 'batch', scopeId: batch, toSequence: head, exceptionCount: 1, reviewerId: 'usr-qa', version: 1 });
    const [sig] = await q(`SELECT meaning_code, signer_id, record_version FROM signatures WHERE entity_type = 'AuditReview' AND entity_id = $1`, [res.body.review.id]);
    expect(sig).toEqual({ meaning_code: 'AUDIT_REVIEW', signer_id: 'usr-qa', record_version: 1 });
    expect(res.body.signature.id).toBeTruthy();
    const v = await t.request.get(`/api/signatures/verify/${res.body.signature.id}`).set(H.qa);
    expect(v.body).toMatchObject({ valid: true });

    const list = await t.request.get(`/api/audit/reviews?batch=${encodeURIComponent(batch)}`).set(H.qa);
    expect(list.body.reviews.map((r: any) => r.id)).toEqual([res.body.review.id]);
    expect(list.body.coverage).toMatchObject({ covered: true, uncoveredRows: 0 });
  });

  it('the reviewer may not have authored any of the rows reviewed (403 SOD_VIOLATION)', async () => {
    const batch = uniq('B-SOD');
    const a = await sample(batch);
    await audit('usr-qa', 'Update', 'Result', a.resultId, 'value', '99.0', '99.1', 'QA corrected a value');
    const res = await review('qa', { scope: 'batch', batch, comment: 'Reviewed every entry, all acceptable.' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect((await review('admin', { scope: 'batch', batch, comment: 'Reviewed every entry, all acceptable.' })).status).toBe(200);
  });

  it('a range beyond the head or a batch with no rows is refused', async () => {
    const head = (await q('SELECT max(sequence)::int AS s FROM audit_trail'))[0].s;
    expect((await review('qa', { scope: 'range', fromSequence: head - 1, toSequence: head + 100, comment: 'Reviewed every entry, all acceptable.' })).status).toBe(400);
    expect((await review('qa', { scope: 'batch', batch: uniq('B-NONE'), throughSequence: 1, comment: 'Reviewed every entry, all acceptable.' })).status).toBe(404);
  });

  it('a batch review signs what the reviewer was shown: throughSequence is required, and an entry written since is 409 SCOPE_CHANGED', async () => {
    const batch = uniq('B-SHOWN');
    const a = await sample(batch);
    const shown = (await t.request.get(`/api/audit/exceptions?batch=${encodeURIComponent(batch)}`).set(H.qa)).body;
    expect(shown.toSequence).toBeGreaterThan(0);
    const ok = 'Reviewed every entry, all acceptable.';
    expect((await review('qa', { scope: 'batch', batch, throughSequence: undefined, comment: ok })).status).toBe(400);

    // Another user changes the batch while the reviewer reads the screen.
    await audit('usr-analyst1', 'Update', 'Sample', a.id, 'material', 'x', 'y', 'Label corrected');
    const stale = await review('qa', { scope: 'batch', batch, throughSequence: shown.toSequence, comment: ok });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.code).toBe('SCOPE_CHANGED');
    expect((await q(`SELECT count(*)::int AS n FROM audit_reviews WHERE scope_id = $1`, [batch]))[0].n).toBe(0);
    const failed = (await q(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts;
    expect(failed).toBe(0);
    // A number above what the server holds is not accepted either: the client must name exactly the last entry it was shown.
    expect((await review('qa', { scope: 'batch', batch, throughSequence: shown.toSequence + 1_000_000, comment: ok })).status).toBe(409);

    const now = (await t.request.get(`/api/audit/exceptions?batch=${encodeURIComponent(batch)}`).set(H.qa)).body;
    const res = await review('qa', { scope: 'batch', batch, throughSequence: now.toSequence, comment: ok });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.review.toSequence).toBe(now.toSequence);
  });
});

describe('acceptance: the release interlock', () => {
  it('the setting is off on installation and only changed with an AUDIT_REVIEW_SETTING signature', async () => {
    const s = await settings();
    expect(s).toMatchObject({ requiredForRelease: false, version: 1 });
    expect((await t.request.put('/api/audit/review-settings').set(H.reviewer).send({ requiredForRelease: true, expectedVersion: 1, ...sign, reason: 'try it' })).status).toBe(403);
    expect((await t.request.put('/api/audit/review-settings').set(H.qa).send({ requiredForRelease: true, expectedVersion: 7, ...sign, reason: 'Audit review before release' })).status).toBe(409);
    await setRequired(true);
    const [sig] = await q(`SELECT meaning_code FROM signatures WHERE entity_type = 'AuditReviewSettings' ORDER BY timestamp DESC LIMIT 1`);
    expect(sig.meaning_code).toBe('AUDIT_REVIEW_SETTING');
  });

  it('release returns 400 until an AUDIT_REVIEW covers the batch rows, and again after a new row', async () => {
    await setRequired(true);
    const batch = uniq('B-REL');
    const a = await sample(batch);
    let res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RELEASE_BLOCKED');
    expect(res.body.error).toMatch(/audit.trail review/i);

    expect((await review('qa', { scope: 'batch', batch, comment: 'Reviewed every entry, all acceptable.' })).status).toBe(200);
    // A change after the review is not covered by it.
    await audit('usr-analyst1', 'Update', 'Result', a.resultId, 'value', '99.0', '99.2', 'Recalculated');
    res = await release(batch);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 audit-trail entr/i);

    expect((await review('qa', { scope: 'batch', batch, comment: 'The recalculation was checked against the raw data.' })).status).toBe(200);
    res = await release(batch);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a signed review of a sequence range covers the batch rows inside it', async () => {
    await setRequired(true);
    const batch = uniq('B-RNG');
    const a = await sample(batch);
    const rows = await q(`SELECT min(sequence)::int AS f, max(sequence)::int AS l FROM audit_trail WHERE entity_id IN ($1, $2)`, [a.id, a.resultId]);
    expect((await review('qa', { scope: 'range', fromSequence: rows[0].f, toSequence: rows[0].l, comment: 'Periodic review of the period, all acceptable.' })).status).toBe(200);
    expect((await release(batch)).status).toBe(200);
  });

  it('with the setting off nothing changes for release', async () => {
    await setRequired(false);
    const batch = uniq('B-OFF');
    await sample(batch);
    expect((await release(batch)).status).toBe(200);
  });
});

describe('the keyed chain', () => {
  it('new rows are hmac-sha256-v1 and the chain verifies, older sha256 rows included', async () => {
    const [row] = await q('SELECT hash_alg, hash_version FROM audit_trail ORDER BY sequence DESC LIMIT 1');
    expect(row).toEqual({ hash_alg: 'hmac-sha256-v1', hash_version: 2 });
    const v = await t.request.post('/api/audit/verify').set(H.qa).send({});
    expect(v.body).toMatchObject({ isValid: true });
  });

  it('a keyed row rewritten and re-hashed with the published unkeyed formula is DOWNGRADE', async () => {
    await audit('usr-analyst1', 'Update', 'Sample', 'S-downgrade', 'material', 'x', 'y', 'typo');
    const [r] = await q('SELECT * FROM audit_trail ORDER BY sequence DESC LIMIT 1');
    const hash = createHash('sha256').update(JSON.stringify({ sequence: r.sequence, timestamp: r.timestamp_str, userId: r.user_id, action: r.action, entity: r.entity, entityId: r.entity_id, field: r.field, oldValue: r.old_value, newValue: 'z', reason: r.reason }) + r.prev_hash).digest('hex');
    const c = await t.db.pool.connect();
    try {
      await c.query('ALTER TABLE audit_trail DISABLE TRIGGER USER');
      await c.query(`UPDATE audit_trail SET new_value = 'z', hash = $2, seal = NULL, hash_version = 1, hash_alg = 'sha256' WHERE sequence = $1`, [r.sequence, hash]);
      await c.query('ALTER TABLE audit_trail ENABLE TRIGGER USER');
    } finally { c.release(); }
    const v = await t.request.post('/api/audit/verify').set(H.qa).send({});
    expect(v.body).toMatchObject({ isValid: false, compromisedSequence: r.sequence, reason: 'DOWNGRADE' });
  });
});

describe('anchors through the API', () => {
  it('Admin writes and verifies an anchor; an Analyst may not', async () => {
    expect((await t.request.post('/api/audit/anchors').set(H.analyst1).send({})).status).toBe(403);
    const made = await t.request.post('/api/audit/anchors').set(H.admin).send({});
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(fs.readdirSync(anchorDir)).toContain(made.body.anchor.fileName);
    const list = await t.request.get('/api/audit/anchors').set(H.qa);
    expect(list.body).toMatchObject({ directory: anchorDir, secondPath: true });
    expect(list.body.anchors[0].fileName).toBe(made.body.anchor.fileName);
    const v = await t.request.post('/api/audit/anchors/verify').set(H.qa).send({});
    expect(v.body).toMatchObject({ isValid: true, anchorsChecked: 1 });
  });
});

describe('acceptance: a clock set back blocks signing until an Administrator acknowledges', () => {
  it('423 CLOCK_ANOMALY on a release, nothing counted; the acknowledgement is allowed and lifts the block', async () => {
    await setRequired(false);
    const { checkClock } = await import('../../src/server/audit/clockGuard');
    const r = await checkClock(appDb, { now: new Date(Date.now() - 10 * 60_000), source: 'test' });
    expect(r.ok).toBe(false);
    const batch = uniq('B-CLK');
    await sample(batch);
    const before = (await q(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts;
    const blocked = await release(batch);
    expect(blocked.status).toBe(423);
    expect(blocked.body.code).toBe('CLOCK_ANOMALY');
    expect((await q(`SELECT failed_attempts FROM users WHERE id = 'usr-qa'`))[0].failed_attempts).toBe(before);

    const clockView = await t.request.get('/api/audit/clock').set(H.admin);
    expect(clockView.status).toBe(200);
    const open = clockView.body.anomalies.filter((x: any) => !x.acknowledgedAt);
    expect(open).toHaveLength(1);
    expect(clockView.body.signingBlocked).toBe(true);
    expect((await t.request.post(`/api/audit/clock-anomalies/${open[0].id}/acknowledge`).set(H.qa).send({ expectedVersion: open[0].version, ...sign, reason: 'Clock checked' })).status).toBe(403);
    const ack = await t.request.post(`/api/audit/clock-anomalies/${open[0].id}/acknowledge`).set(H.admin).send({ expectedVersion: open[0].version, ...sign, reason: 'Clock corrected against the time server; no record affected' });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect((await release(batch)).status).toBe(200);
  });
});

describe('the schedules', () => {
  it('ship a daily anchor and a clock check, with their handlers registered', async () => {
    const { SCHEDULES } = await import('../../src/server/schedules');
    const { defaultHandlers } = await import('../../src/server/jobs/handlers');
    const names = SCHEDULES.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['audit.anchor', 'audit.clock']));
    const handlers = defaultHandlers();
    for (const s of SCHEDULES.filter(s => s.name.startsWith('audit.'))) expect(handlers[s.type], s.type).toBeTypeOf('function');
  });

  it('the anchor job writes a file as the job owner', async () => {
    const { auditAnchorHandler } = await import('../../src/server/schedules/audit');
    const before = fs.readdirSync(anchorDir).length;
    const out: any = await auditAnchorHandler({}, { db: appDb, job: { createdBy: 'usr-admin' } as any, workerId: 'w', signal: new AbortController().signal });
    expect(out).toMatchObject({ sequence: expect.any(Number) });
    expect(fs.readdirSync(anchorDir).length).toBe(before + 1);
  });
});
