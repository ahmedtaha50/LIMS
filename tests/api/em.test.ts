/**
 * Roadmap M32 (r2-em): the environmental monitoring programme.
 *
 * Before: location and grade were free text with no sampling-point master; particle counts were never judged; the batch dossier attached
 * every EM record to every batch; an action-level result opened no deviation; nothing looked for adverse trends.
 *
 * After (acceptance of M32, each asserted below):
 *   - a client-supplied status is rejected by .strict(), and an Analyst changing a count gets 403;
 *   - 3 consecutive alerts at a point are flagged as an adverse trend (fixture, and through the API and the scheduled job);
 *   - the batch dossier lists only the EM results of the batch's rooms within its window.
 * Plus: limit profiles are master data approved by an e-signature of someone who did not write them; only an Approved profile judges;
 * an action-level result opens its excursion and deviation in the same transaction, with the exposed batches linked (release blocker).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1';
let H: Record<Who, { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];
const PW = 'password';

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst1: await t.auth('analyst1@gxp.com') };
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, hour = 8) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00Z`;
const post = (path: string, body: unknown, who: Who) => t.request.post(`/api${path}`).set(H[who]).send(body as object);
const put = (path: string, body: unknown, who: Who) => t.request.put(`/api${path}`).set(H[who]).send(body as object);
const get = (path: string, who: Who) => t.request.get(`/api${path}`).set(H[who]);
const ok = (res: { status: number; body: unknown }, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status);

async function point(grade = 'Grade B', room = uniq('Room')) {
  const res = await post('/em/points', { code: uniq('P').slice(0, 30), room, description: 'Filling line, left of the stopper bowl', grade }, 'qa');
  ok(res);
  return res.body as { id: string; code: string; room: string; version: number };
}

/** A limit profile drafted by the Administrator and approved by QA (the approver did not write it). */
async function approvedLimit(grade: string, method: string, actionLimit: number, alertLimit: number | null = null, occupancy = 'In operation', extra: Record<string, unknown> = {}) {
  const draft = await post('/em/limit-profiles', { grade, method, occupancy, actionLimit, alertLimit, source: 'Site EM programme SOP-EM-001 rev 3, table 2', ...extra }, 'admin');
  ok(draft);
  const res = await post(`/em/limit-profiles/${draft.body.id}/approve`, { password: PW, expectedVersion: draft.body.version }, 'qa');
  ok(res);
  return res.body as { id: string; status: string; version: number; signature: { id: string; meaningCode: string; recordVersion: number } };
}

const viable = (pointId: string, count: number, over: Record<string, unknown> = {}) => ({
  pointId, method: 'Settle plate', occupancy: 'In operation', sampledOn: day(-3), count, mediaLot: 'TSA-2611-04',
  incubationStartedAt: at(-3, 12), incubationEndedAt: at(-1, 12), ...over,
});
async function record(body: Record<string, unknown>, who: Who = 'analyst1') {
  const res = await post('/em/results', body, who);
  ok(res);
  return res.body as { id: string; status: string; version: number; count: number; excursionId: string | null; deviationId: string | null; impactedBatches: string[] };
}

async function batch(batchNo = uniq('B')) {
  const productId = uniq('PRD');
  await sql(`INSERT INTO products (id, code, name) VALUES ($1, $1, $2)`, [productId, uniq('Product')]);
  const id = uniq('PB');
  await sql(`INSERT INTO product_batches (id, product_id, batch_no) VALUES ($1, $2, $3)`, [id, productId, batchNo]);
  return { id, batchNo };
}

describe('migration 0250', () => {
  it('installs drafts only (the 0070 viable limits and the example particle limits), the approval meaning and the two QA permissions', async () => {
    const drafts = await sql(`SELECT id, status, origin, method, iso_class FROM em_limit_profiles WHERE origin = 'migration' ORDER BY id`);
    expect(drafts).toHaveLength(25);
    expect(new Set(drafts.map(d => d.status))).toEqual(new Set(['Draft']));
    expect(drafts.filter(d => d.method.startsWith('Particles')).every(d => /^ISO [578]$/.test(d.iso_class))).toBe(true);
    expect(await one(`SELECT allowed_roles FROM signature_meanings WHERE code = 'EM_LIMIT_APPROVAL'`)).toEqual({ allowed_roles: ['QA', 'Admin'] });
    const grants = await sql(`SELECT role_id, permission_code FROM role_permissions WHERE permission_code IN ('env.manage', 'env.correct') ORDER BY role_id COLLATE "C", permission_code COLLATE "C"`);
    expect(grants.map(g => `${g.role_id}:${g.permission_code}`)).toEqual(['role-admin:env.correct', 'role-admin:env.manage', 'role-qa:env.correct', 'role-qa:env.manage']);
  });

  it('makes excursions append-only', async () => {
    await expect(sql(`UPDATE em_excursions SET count = 0`)).resolves.toBeDefined(); // no rows yet: nothing to refuse
    await expect(sql(`TRUNCATE em_excursions`)).rejects.toThrow(/append-only/);
  });
});

describe('the site map', () => {
  it('is QA\'s: an Analyst gets 403; codes are unique ignoring case; an edit needs a reason and the version; a retired point records nothing', async () => {
    ok(await post('/em/points', { code: 'X-1', room: 'R', description: 'x', grade: 'Grade A' }, 'analyst1'), 403);
    const p = await point('D');
    expect(p).toMatchObject({ status: 'Active', version: 1 });
    expect((await one(`SELECT grade FROM em_sampling_points WHERE id = $1`, [p.id])).grade).toBe('Grade D');
    ok(await post('/em/points', { code: p.code.toLowerCase(), room: 'R', description: 'x', grade: 'Grade A' }, 'qa'), 409);
    ok(await post('/em/points', { code: uniq('Y').slice(0, 20), room: 'R', description: 'x', grade: 'Grade A', status: 'Active' }, 'qa'), 400);

    ok(await put(`/em/points/${p.id}`, { description: 'moved', expectedVersion: 1 }, 'qa'), 400);
    ok(await put(`/em/points/${p.id}`, { description: 'moved', reason: 'Point relocated per zoning plan rev 4', expectedVersion: 7 }, 'qa'), 409);
    ok(await put(`/em/points/${p.id}`, { description: 'moved', reason: 'Point relocated per zoning plan rev 4', expectedVersion: 1 }, 'qa'));
    ok(await post(`/em/points/${p.id}/retire`, { reason: 'Room decommissioned', expectedVersion: 2 }, 'qa'));
    const audit = await sql(`SELECT action, reason FROM audit_trail WHERE entity = 'EmSamplingPoint' AND entity_id = $1 ORDER BY sequence`, [p.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Update', 'StatusChange']);
    const res = await post('/em/results', viable(p.id, 0), 'analyst1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('POINT_RETIRED');
  });
});

describe('limit profiles (approved master data)', () => {
  it('a draft is not used; the author cannot approve it (403, no password tried); QA approves it with EM_LIMIT_APPROVAL bound to its version', async () => {
    const p = await point('Grade C');
    const before = await post('/em/results', viable(p.id, 1, { method: 'Contact plate' }), 'analyst1');
    // The migration's Grade C contact-plate draft exists, but nothing is approved: the result cannot be judged and is not recorded.
    expect(before.status).toBe(400);
    expect(before.body.code).toBe('NO_APPROVED_LIMIT');

    ok(await post('/em/limit-profiles', { grade: 'Grade C', method: 'Contact plate', occupancy: 'In operation', actionLimit: 25, source: 'x' }, 'analyst1'), 403);
    for (const extra of [{ status: 'Approved' }, { unit: 'CFU' }, { id: 'EML-X' }, { approvedBy: 'usr-qa' }, { version: 2 }]) {
      ok(await post('/em/limit-profiles', { grade: 'Grade C', method: 'Contact plate', occupancy: 'In operation', actionLimit: 25, source: 'x', ...extra }, 'admin'), 400);
    }
    ok(await post('/em/limit-profiles', { grade: 'Grade C', method: 'Contact plate', occupancy: 'In operation', actionLimit: 25, alertLimit: 30, source: 'x' }, 'admin'), 400);
    ok(await post('/em/limit-profiles', { grade: 'Grade C', method: 'Particles 0.5 um', occupancy: 'In operation', actionLimit: 3520000, source: 'x' }, 'admin'), 400);

    const draft = await post('/em/limit-profiles', { grade: 'Grade C', method: 'Contact plate', occupancy: 'In operation', actionLimit: 25, alertLimit: 15, source: 'SOP-EM-001 rev 3' }, 'admin');
    ok(draft);
    expect(draft.body).toMatchObject({ status: 'Draft', unit: 'CFU/plate', createdBy: 'usr-admin' });
    const attemptsBefore = (await one(`SELECT failed_attempts FROM users WHERE id = 'usr-admin'`)).failed_attempts;
    const self = await post(`/em/limit-profiles/${draft.body.id}/approve`, { password: 'wrong', expectedVersion: 1 }, 'admin');
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SOD_VIOLATION');
    expect((await one(`SELECT failed_attempts FROM users WHERE id = 'usr-admin'`)).failed_attempts).toBe(attemptsBefore);
    ok(await post(`/em/limit-profiles/${draft.body.id}/approve`, { password: PW, expectedVersion: 1, meaningCode: 'EM_LIMIT_APPROVAL' }, 'qa'), 400);
    ok(await post(`/em/limit-profiles/${draft.body.id}/approve`, { password: 'wrong', expectedVersion: 1 }, 'qa'), 401);
    expect((await one(`SELECT status FROM em_limit_profiles WHERE id = $1`, [draft.body.id])).status).toBe('Draft');

    const approved = await post(`/em/limit-profiles/${draft.body.id}/approve`, { password: PW, expectedVersion: 1 }, 'qa');
    ok(approved);
    expect(approved.body).toMatchObject({ status: 'Approved', approvedBy: 'usr-qa', version: 2 });
    expect(approved.body.signature).toMatchObject({ meaningCode: 'EM_LIMIT_APPROVAL', recordVersion: 2, entityType: 'EmLimitProfile' });
    const v = await get(`/signatures/verify/${approved.body.signature.id}`, 'qa');
    ok(v);
    expect(v.body.status).toBe('valid');

    // Frozen once approved (423); a new limit is a new profile, whose approval retires this one, and the old signature still verifies.
    ok(await put(`/em/limit-profiles/${draft.body.id}`, { actionLimit: 30, expectedVersion: 2 }, 'admin'), 423);
    const next = await approvedLimit('Grade C', 'Contact plate', 20, 10);
    const old = await one(`SELECT status, superseded_by FROM em_limit_profiles WHERE id = $1`, [draft.body.id]);
    expect(old).toEqual({ status: 'Retired', superseded_by: next.id });
    expect((await get(`/signatures/verify/${approved.body.signature.id}`, 'qa')).body.status).toBe('valid');
    const judged = await record(viable(p.id, 12, { method: 'Contact plate' }));
    expect(judged).toMatchObject({ status: 'Alert' });
    expect(await one(`SELECT limit_profile_id, limit_alert, limit_action, unit, grade, room FROM em_results WHERE id = $1`, [judged.id]))
      .toEqual({ limit_profile_id: next.id, limit_alert: 10, limit_action: 20, unit: 'CFU/plate', grade: 'Grade C', room: p.room });
  });

  it('a draft is edited only with its version, by QA, and approving a migration draft makes it the limit in force', async () => {
    const draft = await one(`SELECT id, version FROM em_limit_profiles WHERE id = 'EML-PART-C-OPER-05'`);
    ok(await put(`/em/limit-profiles/${draft.id}`, { alertLimit: 2000000, expectedVersion: draft.version + 1 }, 'qa'), 409);
    ok(await put(`/em/limit-profiles/${draft.id}`, { alertLimit: 2000000, expectedVersion: draft.version }, 'analyst1'), 403);
    ok(await put(`/em/limit-profiles/${draft.id}`, { alertLimit: 2000000, reason: 'Site alert level from the 2025 trend review', expectedVersion: draft.version }, 'admin'));
    ok(await post(`/em/limit-profiles/${draft.id}/approve`, { password: PW, expectedVersion: draft.version + 1 }, 'qa'));
    const p = await point('Grade C');
    const r = await record({ pointId: p.id, method: 'Particles 0.5 um', occupancy: 'In operation', sampledOn: day(-1), count: 2500000 });
    expect(r).toMatchObject({ status: 'Alert' });
    expect((await one(`SELECT unit FROM em_results WHERE id = $1`, [r.id])).unit).toBe('particles/m3');
    // A particle count has no media, incubation or organism.
    ok(await post('/em/results', { pointId: p.id, method: 'Particles 0.5 um', occupancy: 'In operation', sampledOn: day(-1), count: 1, mediaLot: 'X' }, 'analyst1'), 400);
  });
});

describe('recording a result', () => {
  let p: { id: string; code: string; room: string };
  beforeAll(async () => {
    p = await point('Grade A');
    await approvedLimit('Grade A', 'Settle plate', 0);
  });

  it('refuses a client-supplied status and every other server-controlled field (.strict(), 400), and nothing is written', async () => {
    const before = (await one(`SELECT count(*)::int AS n FROM em_results`)).n;
    for (const extra of [{ status: 'Pass' }, { id: 'EMR-X' }, { version: 1 }, { unit: 'CFU' }, { grade: 'Grade D' }, { room: 'Elsewhere' }, { recordedBy: 'usr-qa' }, { limitAction: 100 }]) {
      const res = await post('/em/results', viable(p.id, 1, extra), 'analyst1');
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await one(`SELECT count(*)::int AS n FROM em_results`)).n).toBe(before);
  });

  it('a viable result names the media lot and its incubation, read after incubation ended', async () => {
    for (const over of [{ mediaLot: undefined }, { incubationStartedAt: undefined }, { incubationEndedAt: undefined }, { incubationEndedAt: at(-3, 11) }, { incubationEndedAt: at(2) }, { sampledOn: day(1) }, { count: -1 }, { count: 1.5 }]) {
      const res = await post('/em/results', viable(p.id, 1, over), 'analyst1');
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
  });

  it('Grade A, 1 CFU: Action, with its excursion and its deviation (QA Triage, auto:em-excursion) in the same transaction', async () => {
    const r = await record(viable(p.id, 1));
    expect(r.status).toBe('Action');
    expect(r.id).toMatch(new RegExp(`^EMR-${new Date().getUTCFullYear()}-\\d{5}$`));
    const exc = await one(`SELECT id, qms_record_id, count, limit_value, opened_by FROM em_excursions WHERE result_id = $1`, [r.id]);
    expect(exc).toMatchObject({ id: r.excursionId, qms_record_id: r.deviationId, count: 1, limit_value: 0, opened_by: 'usr-analyst1' });
    const dev = await one(`SELECT type, state, origin, source_id FROM qms_records WHERE id = $1`, [r.deviationId]);
    expect(dev).toEqual({ type: 'Deviation', state: 'QA Triage', origin: 'auto:em-excursion', source_id: r.id });
    const audit = await sql(`SELECT entity FROM audit_trail WHERE entity_id IN ($1, $2, $3) ORDER BY sequence`, [r.id, r.excursionId, r.deviationId]);
    expect(audit.map(a => a.entity)).toEqual(['EmResult', 'QmsRecord', 'EmExcursion']);
    // 0 CFU passes and opens nothing.
    const pass = await record(viable(p.id, 0));
    expect(pass).toMatchObject({ status: 'Pass', excursionId: null, deviationId: null });
  });

  it('an Analyst or a Reviewer changing a count gets 403 and the result is unchanged', async () => {
    const r = await record(viable(p.id, 0));
    for (const who of ['analyst1', 'reviewer'] as const) {
      const res = await put(`/em/results/${r.id}`, { count: 3, reason: 'Recount of the plate', expectedVersion: 1 }, who);
      expect(res.status, who).toBe(403);
    }
    expect(await one(`SELECT count, version, status FROM em_results WHERE id = $1`, [r.id])).toEqual({ count: 0, version: 1, status: 'Pass' });
    const denied = await sql(`SELECT 1 FROM security_events WHERE event_type = 'AUTHZ_DENIED' AND actor_id = 'usr-analyst1'`);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('QA corrects a count with a reason and the version: re-judged, audited before and after, an excursion opened; lowering it closes nothing', async () => {
    const r = await record(viable(p.id, 0));
    ok(await put(`/em/results/${r.id}`, { count: 2, expectedVersion: 1 }, 'qa'), 400);
    ok(await put(`/em/results/${r.id}`, { count: 2, reason: 'Recount of the plate', expectedVersion: 4 }, 'qa'), 409);
    ok(await put(`/em/results/${r.id}`, { count: 2, reason: 'Recount', expectedVersion: 1, status: 'Pass' }, 'qa'), 400);
    const up = await put(`/em/results/${r.id}`, { count: 2, reason: 'Recount of the plate by a second analyst', expectedVersion: 1 }, 'qa');
    ok(up);
    expect(up.body).toMatchObject({ count: 2, status: 'Action', version: 2 });
    expect(up.body.excursionId).toBeTruthy();
    const audit = await one(`SELECT user_id, old_value, new_value, reason FROM audit_trail WHERE entity = 'EmResult' AND entity_id = $1 AND action = 'Update'`, [r.id]);
    expect(audit.user_id).toBe('usr-qa');
    expect(JSON.parse(audit.old_value)).toMatchObject({ count: 0, status: 'Pass' });
    expect(JSON.parse(audit.new_value)).toMatchObject({ count: 2, status: 'Action' });
    expect(audit.reason).toBe('Recount of the plate by a second analyst');

    const down = await put(`/em/results/${r.id}`, { count: 0, reason: 'Transcription error corrected', expectedVersion: 2 }, 'admin');
    ok(down);
    expect(down.body).toMatchObject({ status: 'Pass', excursionId: up.body.excursionId });
    expect((await sql(`SELECT 1 FROM em_excursions WHERE result_id = $1`, [r.id])).length).toBe(1);
  });

  it('the organism is identified once by the bench; a change is a QA correction', async () => {
    const r = await record(viable(p.id, 3));
    ok(await post(`/em/results/${r.id}/identification`, { organism: 'Staphylococcus epidermidis', expectedVersion: 2 }, 'analyst1'), 409);
    const idd = await post(`/em/results/${r.id}/identification`, { organism: 'Staphylococcus epidermidis', expectedVersion: 1 }, 'analyst1');
    ok(idd);
    expect(idd.body).toMatchObject({ organism: 'Staphylococcus epidermidis', identifiedBy: 'usr-analyst1', version: 2 });
    const again = await post(`/em/results/${r.id}/identification`, { organism: 'Micrococcus luteus', expectedVersion: 2 }, 'analyst1');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_IDENTIFIED');
    const none = await record(viable(p.id, 0));
    expect((await post(`/em/results/${none.id}/identification`, { organism: 'Bacillus', expectedVersion: 1 }, 'analyst1')).body.code).toBe('NO_GROWTH');
  });
});

describe('batch impact by room and date window', () => {
  it('the batch dossier lists only the EM results of the batch\'s rooms inside its window', async () => {
    const roomIn = uniq('Suite');
    const pIn = await point('Grade B', roomIn);
    const pOther = await point('Grade B', uniq('Suite'));
    await approvedLimit('Grade B', 'Air', 10, 5);
    const air = (pointId: string, sampledOn: string, count = 0) => viable(pointId, count, { method: 'Air', sampledOn, incubationStartedAt: `${sampledOn}T12:00:00Z` });
    const inside = await record(air(pIn.id, day(-7)));
    const before = await record(air(pIn.id, day(-12)));
    const after = await record(air(pIn.id, day(-2)));
    const otherRoom = await record(air(pOther.id, day(-7)));
    ok(await post('/env-records', { location: roomIn, grade: 'Grade B', sampleType: 'Air', date: day(-7), viableCount: 0, nonViableCount: 0 }, 'analyst1'));

    const b = await batch();
    ok(await post('/em/batch-rooms', { productBatchId: b.id, room: roomIn, fromDate: day(-8), toDate: day(-5) }, 'analyst1'), 403);
    ok(await post('/em/batch-rooms', { productBatchId: b.id, room: 'Nowhere-without-points', fromDate: day(-8), toDate: day(-5) }, 'qa'), 400);
    ok(await post('/em/batch-rooms', { productBatchId: b.id, room: roomIn, fromDate: day(-5), toDate: day(-8) }, 'qa'), 400);
    const w = await post('/em/batch-rooms', { productBatchId: b.id, room: roomIn, fromDate: day(-8), toDate: day(-5) }, 'qa');
    ok(w);

    const dossier = await get(`/traceability/batch/${b.batchNo}`, 'qa');
    ok(dossier);
    expect(dossier.body.cleanroom.map((c: { id: string }) => c.id)).toEqual([inside.id]);
    expect(dossier.body.cleanroom[0]).toMatchObject({ room: roomIn, pointCode: pIn.code, status: 'Pass', method: 'Air' });
    expect(dossier.body.cleanroomWindows).toHaveLength(1);
    for (const id of [before.id, after.id, otherRoom.id]) expect(JSON.stringify(dossier.body.cleanroom)).not.toContain(id);

    // A batch with no window has no EM results: nothing is attached to every batch.
    const lonely = await batch();
    const empty = await get(`/traceability/batch/${lonely.batchNo}`, 'qa');
    ok(empty);
    expect(empty.body.cleanroom).toEqual([]);

    // Moving the window (QA, reason, version) moves the results with it.
    ok(await put(`/em/batch-rooms/${w.body.id}`, { toDate: day(-1), reason: 'Batch record shows packing on the later day', expectedVersion: 1 }, 'qa'));
    const moved = await get(`/em/batch-impact/${b.batchNo}`, 'analyst1');
    ok(moved);
    expect(moved.body.results.map((c: { id: string }) => c.id)).toEqual([inside.id, after.id]);
  });

  it('an action-level result affects the batches in its room that day: the deviation is linked and holds their release', async () => {
    const room = uniq('Suite');
    const pt = await point('Grade B', room);
    await approvedLimit('Grade B', 'Glove print', 5);
    const exposed = await batch();
    const elsewhere = await batch();
    ok(await post('/em/batch-rooms', { productBatchId: exposed.id, room, fromDate: day(-6), toDate: day(-2) }, 'qa'));
    ok(await post('/em/batch-rooms', { productBatchId: elsewhere.id, room, fromDate: day(-30), toDate: day(-20) }, 'qa'));

    const r = await record(viable(pt.id, 9, { method: 'Glove print', sampledOn: day(-4), incubationStartedAt: at(-4, 12) }));
    expect(r.status).toBe('Action');
    expect(r.impactedBatches).toEqual([exposed.batchNo]);
    expect(await sql(`SELECT relation, target_type, target_id FROM qms_links WHERE record_id = $1 AND relation = 'affects'`, [r.deviationId]))
      .toEqual([{ relation: 'affects', target_type: 'Batch', target_id: exposed.batchNo }]);
    const dossier = await get(`/traceability/batch/${exposed.batchNo}`, 'qa');
    expect(dossier.body.deviations).toEqual([expect.objectContaining({ id: r.deviationId, open: true, blocksRelease: true })]);
    expect((await get(`/traceability/batch/${elsewhere.batchNo}`, 'qa')).body.deviations).toEqual([]);

    // A window recorded after the excursion links the open deviation too.
    const late = await batch();
    const lw = await post('/em/batch-rooms', { productBatchId: late.id, room, fromDate: day(-4), toDate: day(-4) }, 'qa');
    ok(lw);
    expect(lw.body.linkedDeviations).toEqual([r.deviationId]);
    const exc = await get('/em/excursions', 'analyst1');
    ok(exc);
    expect(exc.body.find((e: { resultId: string }) => e.resultId === r.id)).toMatchObject({ deviationState: 'QA Triage', batches: expect.arrayContaining([exposed.batchNo, late.batchNo]) });
  });

  it('a legacy action-level record (POST /env-records) also opens its deviation, in the same transaction', async () => {
    const res = await post('/env-records', { location: 'Legacy hood', grade: 'Grade A', sampleType: 'Air', date: day(-1), viableCount: 1, nonViableCount: 0 }, 'analyst1');
    ok(res);
    expect(res.body.status).toBe('Action');
    expect(await one(`SELECT type, state, origin FROM qms_records WHERE source_id = $1`, [res.body.id])).toEqual({ type: 'Deviation', state: 'QA Triage', origin: 'auto:em-excursion' });
  });
});

describe('adverse trends', () => {
  it('fixture: 3 consecutive alert-level results at a point and method are one finding; a Pass breaks the run', async () => {
    const { findTrends } = await import('../../src/server/em/trends');
    const row = (id: string, status: string, sampledOn: string, over: Record<string, unknown> = {}) => ({ id, pointId: 'P1', room: 'R1', method: 'Air', sampledOn, status, organism: null, ...over });
    const three = findTrends([row('r1', 'Alert', '2026-01-01'), row('r2', 'Alert', '2026-01-08'), row('r3', 'Action', '2026-01-15'), row('r4', 'Alert', '2026-01-22')]);
    expect(three.filter(f => f.rule === 'CONSECUTIVE_ALERTS')).toEqual([expect.objectContaining({ dedupeKey: 'CONSECUTIVE_ALERTS:r1', resultIds: ['r1', 'r2', 'r3'], pointId: 'P1' })]);
    expect(findTrends([row('r1', 'Alert', '2026-01-01'), row('r2', 'Alert', '2026-01-08'), row('r3', 'Pass', '2026-01-15'), row('r4', 'Alert', '2026-01-22')])).toEqual([]);
    // Other methods or points do not continue the run.
    expect(findTrends([row('r1', 'Alert', '2026-01-01'), row('r2', 'Alert', '2026-01-08', { method: 'Settle plate' }), row('r3', 'Alert', '2026-01-15', { pointId: 'P2' })])).toEqual([]);
    // 2 action-level results within 30 days; a recurring organism in a room within 90 days.
    expect(findTrends([row('a1', 'Action', '2026-01-01'), row('a2', 'Action', '2026-01-31', { method: 'Settle plate' })]).map(f => f.rule)).toEqual(['REPEATED_ACTIONS']);
    expect(findTrends([row('a1', 'Action', '2026-01-01'), row('a2', 'Action', '2026-02-01')])).toEqual([]);
    const org = findTrends([row('o1', 'Pass', '2026-01-01', { organism: 'Bacillus cereus' }), row('o2', 'Pass', '2026-03-01', { pointId: 'P2', organism: ' bacillus  CEREUS' })]);
    expect(org).toEqual([expect.objectContaining({ rule: 'RECURRING_ORGANISM', dedupeKey: 'RECURRING_ORGANISM:o1:o2', room: 'R1' })]);
  });

  it('through the API and the scheduled job: 3 consecutive alerts at a point are flagged once, then acknowledged by QA', async () => {
    const p = await point('Grade D');
    await approvedLimit('Grade D', 'Contact plate', 50, 25);
    const ids: string[] = [];
    for (const [i, count] of [30, 40, 26].entries()) ids.push((await record(viable(p.id, count, { method: 'Contact plate', sampledOn: day(-10 + i), incubationStartedAt: at(-10 + i, 12) }))).id);

    ok(await post('/em/trends/evaluate', {}, 'analyst1'), 403);
    ok(await post('/em/trends/evaluate', { all: true }, 'qa'), 400);
    const ev = await post('/em/trends/evaluate', {}, 'qa');
    ok(ev);
    const mine = ev.body.flagged.filter((f: { pointId: string }) => f.pointId === p.id);
    expect(mine).toEqual([expect.objectContaining({ rule: 'CONSECUTIVE_ALERTS' })]);
    const flag = await one(`SELECT id, result_ids, status, detected_by FROM em_trend_flags WHERE point_id = $1`, [p.id]);
    expect(flag).toMatchObject({ result_ids: ids, status: 'Open', detected_by: 'usr-qa' });
    expect((await sql(`SELECT 1 FROM audit_trail WHERE entity = 'EmTrendFlag' AND entity_id = $1 AND action = 'Create'`, [flag.id])).length).toBe(1);

    // The scheduled job (em.trends) runs the same evaluation as the service principal; the finding is not flagged twice.
    const { defaultSchedules } = await import('../../src/server/schedules');
    const { defaultHandlers } = await import('../../src/server/jobs/handlers');
    expect(defaultSchedules().find(s => s.name === 'em.trends')).toMatchObject({ type: 'em.trends' });
    const { db } = await import('../../src/db/index');
    const out = await defaultHandlers()['em.trends']({}, { db, job: { createdBy: 'usr-qa' } } as never);
    expect(out).toMatchObject({ flagged: 0 });
    expect((await sql(`SELECT 1 FROM em_trend_flags WHERE point_id = $1`, [p.id])).length).toBe(1);

    const list = await get('/em/trends', 'reviewer');
    ok(list);
    expect(list.body.find((f: { id: string }) => f.id === flag.id)).toMatchObject({ pointCode: p.code, rule: 'CONSECUTIVE_ALERTS' });
    ok(await post(`/em/trends/${flag.id}/acknowledge`, { acknowledgement: 'Reviewed: cleaning frequency raised', expectedVersion: 1 }, 'analyst1'), 403);
    ok(await post(`/em/trends/${flag.id}/acknowledge`, { acknowledgement: 'ok', expectedVersion: 1 }, 'qa'), 400);
    ok(await post(`/em/trends/${flag.id}/acknowledge`, { acknowledgement: 'Reviewed: cleaning frequency raised, see DEV follow-up', expectedVersion: 1 }, 'qa'));
    ok(await post(`/em/trends/${flag.id}/acknowledge`, { acknowledgement: 'Reviewed again by QA', expectedVersion: 2 }, 'qa'), 423);
  });

  it('the heat grid gives the worst status per point and week', async () => {
    const p = await point('Grade D');
    await approvedLimit('Grade D', 'Settle plate', 100, 50);
    const today = (count: number) => ({ pointId: p.id, method: 'Settle plate', occupancy: 'In operation', sampledOn: day(0), count, mediaLot: 'TSA-1', incubationStartedAt: at(-1, 1), incubationEndedAt: new Date(Date.now() - 60_000).toISOString() });
    await record(today(60));
    await record(today(10));
    const res = await get('/em/heatmap?weeks=4', 'analyst1');
    ok(res);
    expect(res.body.columns).toHaveLength(4);
    const row = res.body.rows.find((r: { pointId: string }) => r.pointId === p.id);
    expect(row.cells[3]).toEqual({ worst: 'Alert', n: 2 });
    expect(row.cells.slice(0, 3)).toEqual([null, null, null]);
    ok(await get('/em/heatmap?weeks=99', 'analyst1'), 400);
  });
});
