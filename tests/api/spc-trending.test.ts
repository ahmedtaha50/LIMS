/**
 * Roadmap M39 (r3-spc), SPC and OOT trending against the real application and PostgreSQL.
 *
 * Before: the only "SPC" was a smoothed line with USL/LSL from row 0 (no mean, sigma or rules); /reports/trends included unapproved and
 * rejected samples, ordered by sample creation and loaded every result. There was no control-limit baseline, no out-of-trend alert and
 * no shelf-life estimate.
 *
 * Acceptance:
 *   1. A 30-point seeded series matches the hand-calculated CL/UCL/LCL within 1e-6.
 *   2. A point at 3.2 sigma is flagged as rule 1 (smoothing off). Unapproved samples are excluded by default.
 *   3. A baseline change needs a reason and an e-signature and creates a new version. The stability regression matches a reference
 *      calculation to 3 decimals.
 * Advisory: nothing here changes a result, a sample or a disposition (asserted by comparing the rows before and after).
 */
import { createHash } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1';
let H: Record<Who, { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const SIGN = { password: 'password' };
// The 30-point series of tests/unit/spc/spc.test.ts: CL 100.01, MRbar 0.503448275862069, UCL 101.3491724137931, LCL 98.6708275862069.
const SERIES = [100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6, 100.3, 99.9, 99.5, 100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6, 100.3, 99.9, 99.5, 100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6];
const CL = 100.01; const MRBAR = 0.503448275862069; const SIGMA = (2.66 * MRBAR) / 3;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-01-01T08:00:00Z');

beforeAll(async () => {
  t = await startTestApp();
  H = { admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'), analyst1: await t.auth('analyst1@gxp.com') };
});

const post = (path: string, body: unknown, who: Who) => t.request.post(`/api${path}`).set(H[who]).send(body as object);
const get = (path: string, who: Who) => t.request.get(`/api${path}`).set(H[who]);
function ok<T = any>(res: { status: number; body: any }, status = 200): T {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}

interface Product { id: string; name: string; seq: number }
async function product(): Promise<Product> {
  const name = uniq('Metformin 500 mg');
  const p = ok(await post('/products', { code: uniq('MET'), name }, 'qa'));
  return { id: p.id, name, seq: 0 };
}

/** Approved (or other state) samples with one numeric result each, entered one hour apart from `startHour`. */
async function seed(pr: Product, parameter: string, values: Array<number | string>, opts: { startHour?: number; state?: string; origin?: string; specMin?: number; specMax?: number; createdReverse?: boolean } = {}) {
  const ids: Array<{ sampleId: string; resultId: string }> = [];
  for (let i = 0; i < values.length; i++) {
    const sampleId = uniq('S'); const resultId = uniq('R');
    const hour = (opts.startHour ?? 0) + i;
    const createdAt = new Date(T0 + (opts.createdReverse ? (1000 - hour) : hour) * HOUR).toISOString();
    await sql(`insert into samples (id, material, batch, state, created_by, created_at) values ($1, $2, $3, $4, 'usr-analyst1', $5)`, [sampleId, pr.name, `B${pr.seq++}-${hour}`, opts.state ?? 'Approved', createdAt]);
    await sql(`insert into results (id, sample_id, parameter, value, spec_min, spec_max, entered_by, entered_at, unit) values ($1, $2, $3, $4, $5, $6, 'usr-analyst1', $7, '%')`,
      [resultId, sampleId, parameter, String(values[i]), opts.specMin ?? 98, opts.specMax ?? 102, new Date(T0 + hour * HOUR).toISOString()]);
    if (opts.origin) await sql(`insert into sample_context (sample_id, product_id, batch_id, origin) select $1, $2, b.id, $3 from product_batches b limit 1`, [sampleId, pr.id, opts.origin]).catch(() => undefined);
    ids.push({ sampleId, resultId });
  }
  return ids;
}
const series = async (pr: Product, parameter: string, extra = '') => ok<any>(await get(`/trending/series?productId=${pr.id}&parameter=${encodeURIComponent(parameter)}${extra}`, 'analyst1'));
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);
const baselineBody = (pr: Product, parameter: string, over: Record<string, unknown> = {}) => ({ productId: pr.id, parameter, expectedRevision: 0, reason: 'Initial limits from the first 30 batches', ...SIGN, ...over });

describe('the chart data: approved only, ordered by entry time, limits as hand-calculated', () => {
  it('a 30-point series gives the hand-calculated CL, UCL, LCL and Cpk (1e-6)', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    const s = await series(pr, 'Assay');
    expect(s.points).toHaveLength(30);
    expect(s.limitsSource).toBe('computed');
    expect(s.provisional).toBe(false);
    near(s.limits.cl, CL); near(s.limits.mrBar, MRBAR); near(s.limits.ucl, 101.3491724137931); near(s.limits.lcl, 98.6708275862069); near(s.limits.sigma, SIGMA);
    expect(s.capability.ok).toBe(true);
    near(s.capability.value.cpk, 1.4862301369862974);
    expect(s.specLimits).toEqual({ lower: 98, upper: 102, changed: false });
    expect(s.advisory).toMatch(/advisory/i);
  });

  it('a point at 3.2 sigma is flagged as rule 1; one at 2.9 sigma is not (smoothing off: the value is the value)', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    const hi = CL + 3.2 * SIGMA; const lo = CL - 2.9 * SIGMA;
    await seed(pr, 'Assay', [hi.toFixed(6), lo.toFixed(6)], { startHour: 100 });
    // against a signed baseline of the first 30: the extra points do not move the limits
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay', { to: new Date(T0 + 29 * HOUR).toISOString() }), 'qa'));
    const s = await series(pr, 'Assay');
    expect(s.limitsSource).toBe('baseline');
    const flagged = s.points.filter((p: any) => p.violations.some((v: any) => v.rule === 'N1'));
    expect(flagged.map((p: any) => p.value)).toEqual([Number(hi.toFixed(6))]);
    expect(flagged[0].z).toBeGreaterThan(3.19);
    expect(s.points[31].violations.filter((v: any) => v.rule === 'N1')).toEqual([]);
  });

  it('unapproved samples are excluded by default; on opt-in they are shown, marked, and never used for limits or rules; rejected never', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    await seed(pr, 'Assay', [130], { startHour: 200, state: 'Pending Review' });
    await seed(pr, 'Assay', [131], { startHour: 201, state: 'Testing' });
    await seed(pr, 'Assay', [132], { startHour: 202, state: 'Rejected' });
    const plain = await series(pr, 'Assay');
    expect(plain.points).toHaveLength(30);
    expect(plain.includesUnapproved).toBe(false);
    const opt = await series(pr, 'Assay', '&includeUnapproved=true');
    expect(opt.points).toHaveLength(32);
    expect(opt.points.filter((p: any) => !p.approved).map((p: any) => [p.value, p.sampleState])).toEqual([[130, 'Pending Review'], [131, 'Testing']]);
    near(opt.limits.cl, CL); near(opt.limits.ucl, plain.limits.ucl);
    expect(opt.points.filter((p: any) => !p.approved).every((p: any) => p.violations.length === 0 && p.index === null)).toBe(true);
    expect(opt.violations).toEqual(plain.violations);
  });

  it('is ordered by the time the result was entered, not by the sample creation; stability pulls and non-numeric values are not plotted', async () => {
    const pr = await product();
    await seed(pr, 'Assay', [100.1, 100.2, 100.3, 100.4], { createdReverse: true });
    await seed(pr, 'Assay', ['<0.1', 'Complies'], { startHour: 50 });
    const s = await series(pr, 'Assay');
    expect(s.points.map((p: any) => p.value)).toEqual([100.1, 100.2, 100.3, 100.4]);
    expect(s.skippedNonNumeric).toBe(2);
    const stab = await seed(pr, 'Assay', [90], { startHour: 60 });
    const [b] = await sql(`insert into product_batches (id, product_id, batch_no) values ($1, $2, $3) returning id`, [uniq('PB'), pr.id, uniq('SB')]);
    await sql(`insert into sample_context (sample_id, product_id, batch_id, origin) values ($1, $2, $3, 'stability')`, [stab[0].sampleId, pr.id, b.id]);
    expect((await series(pr, 'Assay')).points).toHaveLength(4);
  });

  it('Cpk is withheld below 20 points and without both limits', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES.slice(0, 12));
    const s = await series(pr, 'Assay');
    expect(s.capability).toMatchObject({ ok: false, reason: 'TOO_FEW_POINTS' });
    expect(s.provisional).toBe(true);
    const pr2 = await product();
    await seed(pr2, 'Assay', SERIES, { specMax: undefined as any });
    await sql(`update results r set spec_max = null from samples s where s.id = r.sample_id and s.material = $1`, [pr2.name]);
    expect((await series(pr2, 'Assay')).capability).toMatchObject({ ok: false, reason: 'NEEDS_BOTH_LIMITS' });
  });

  it('refuses a bad query (strict) and an unknown product', async () => {
    const pr = await product();
    expect((await get(`/trending/series?productId=${pr.id}`, 'analyst1')).status).toBe(400);
    expect((await get(`/trending/series?productId=${pr.id}&parameter=Assay&extra=1`, 'analyst1')).status).toBe(400);
    expect((await get(`/trending/series?productId=${pr.id}&parameter=Assay&from=yesterday`, 'analyst1')).status).toBe(400);
    expect((await get('/trending/series?productId=NOPE&parameter=Assay', 'analyst1')).status).toBe(404);
    const params = ok<any>(await get(`/trending/parameters?productId=${pr.id}`, 'analyst1'));
    expect(params.parameters).toEqual([]);
  });
});

describe('baselines: computed by the server, signed, versioned', () => {
  it('QA sets a baseline with a reason and a signature bound to the new version; the limits are the hand-calculated ones and reproducible', async () => {
    const pr = await product();
    const ids = await seed(pr, 'Assay', SERIES);
    const created = ok<any>(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa'));
    const b = created.baseline;
    expect(b).toMatchObject({ revision: 1, status: 'Approved', n: 30, ruleSet: 'nelson', createdBy: 'usr-qa', version: 1 });
    near(b.cl, CL); near(b.mrBar, MRBAR); near(b.ucl, 101.3491724137931); near(b.lcl, 98.6708275862069);
    expect(created.signature).toMatchObject({ entityType: 'SpcBaseline', meaningCode: 'SPC_BASELINE_APPROVAL', recordVersion: 1, signerId: 'usr-qa' });
    expect(ok<any>(await get(`/signatures/verify/${created.signature.id}`, 'qa')).valid).toBe(true);
    // reproducible: the stored ids and the stored hash give back the same data
    expect(b.resultIds).toEqual(ids.map(i => i.resultId));
    const hash = createHash('sha256').update(ids.map((i, k) => `${i.resultId}:${SERIES[k]}`).join('\n')).digest('hex');
    expect(b.dataHash).toBe(hash);
    const audit = await sql(`select action, entity, user_id from audit_trail where entity = 'SpcBaseline' and entity_id = $1 order by sequence`, [b.id]);
    expect(audit).toEqual([{ action: 'Create', entity: 'SpcBaseline', user_id: 'usr-qa' }, { action: 'Approve', entity: 'SpcBaseline', user_id: 'usr-qa' }]);
    const list = ok<any[]>(await get(`/trending/baselines?productId=${pr.id}&parameter=Assay`, 'analyst1'));
    expect(list.map(x => x.revision)).toEqual([1]);
  });

  it('needs a reason and a valid signature; a wrong password or a missing reason creates nothing', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    expect((await post('/trending/baselines', { ...baselineBody(pr, 'Assay'), reason: undefined }, 'qa')).status).toBe(400);
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay', { reason: 'ok' }), 'qa')).status).toBe(400);
    expect((await post('/trending/baselines', { ...baselineBody(pr, 'Assay'), password: undefined }, 'qa')).status).toBe(400);
    const bad = await post('/trending/baselines', baselineBody(pr, 'Assay', { password: 'wrong-password' }), 'qa');
    expect([401, 403]).toContain(bad.status);
    expect((await sql(`select count(*)::int n from spc_baselines where product_id = $1`, [pr.id]))[0].n).toBe(0);
  });

  it('is QA/Admin only (spc.manage); the limits, status and version are not the client\'s to send', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay'), 'analyst1')).status).toBe(403);
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay'), 'reviewer')).status).toBe(403);
    for (const extra of [{ cl: 50 }, { ucl: 200 }, { status: 'Approved' }, { version: 9 }, { revision: 4 }, { n: 2 }]) {
      expect((await post('/trending/baselines', baselineBody(pr, 'Assay', extra), 'qa')).status, JSON.stringify(extra)).toBe(400);
    }
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'admin'));
  });

  it('a change creates a new revision and supersedes the old one in the same transaction; a stale expectedRevision is 409', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    const first = ok<any>(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa')).baseline;
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa')).status).toBe(409); // still says "no baseline yet"
    const second = ok<any>(await post('/trending/baselines', baselineBody(pr, 'Assay', { expectedRevision: 1, reason: 'Process change CC-1 implemented', ruleSet: 'westgard' }), 'admin'));
    expect(second.baseline).toMatchObject({ revision: 2, status: 'Approved', ruleSet: 'westgard', createdBy: 'usr-admin' });
    expect(second.signature.signerId).toBe('usr-admin');
    const rows = await sql(`select revision, status, version from spc_baselines where product_id = $1 order by revision`, [pr.id]);
    expect(rows).toEqual([{ revision: 1, status: 'Superseded', version: 2 }, { revision: 2, status: 'Approved', version: 1 }]);
    const audit = await sql(`select action, entity_id from audit_trail where entity = 'SpcBaseline' and entity_id = any($1) order by sequence`, [[first.id, second.baseline.id]]);
    expect(audit).toEqual([{ action: 'Create', entity_id: first.id }, { action: 'Approve', entity_id: first.id }, { action: 'StatusChange', entity_id: first.id }, { action: 'Create', entity_id: second.baseline.id }, { action: 'Approve', entity_id: second.baseline.id }]);
    // the first signature stays verifiable after its record was superseded
    expect(ok<any>(await get(`/signatures/verify/${ok<any>(await get(`/signatures/entity/SpcBaseline/${first.id}`, 'qa'))[0].id}`, 'qa')).valid).toBe(true);
  });

  it('every exclusion is named and justified and the limits are computed without it; fewer than 20 points left is refused before the password is checked', async () => {
    const pr = await product();
    const ids = await seed(pr, 'Assay', [...SERIES, 105]); // an outlier, the 31st point
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay', { exclusions: [{ resultId: ids[30].resultId }] }), 'qa')).status).toBe(400); // no reason
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay', { exclusions: [{ resultId: 'R-nope', reason: 'Not a result' }] }), 'qa')).status).toBe(400);
    expect((await post('/trending/baselines', baselineBody(pr, 'Assay', { exclusions: [{ resultId: ids[30].resultId, reason: 'One' }] }), 'qa')).status).toBe(400); // reason too short
    const created = ok<any>(await post('/trending/baselines', baselineBody(pr, 'Assay', { exclusions: [{ resultId: ids[30].resultId, reason: 'Investigated: sample prepared in the wrong diluent (DEV-1)' }] }), 'qa'));
    near(created.baseline.cl, CL); expect(created.baseline.n).toBe(30);
    expect(created.baseline.exclusions).toEqual([{ resultId: ids[30].resultId, reason: 'Investigated: sample prepared in the wrong diluent (DEV-1)' }]);
    const shown = await series(pr, 'Assay');
    expect(shown.baseline.exclusions).toBe(1);
    expect(shown.points).toHaveLength(31); // the excluded point is still on the chart

    const thin = await product();
    await seed(thin, 'Assay', SERIES.slice(0, 19));
    const refused = await post('/trending/baselines', baselineBody(thin, 'Assay', { password: 'wrong-password' }), 'qa');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TOO_FEW_POINTS');
    const flat = await product();
    await seed(flat, 'Assay', new Array(25).fill(100));
    expect((await post('/trending/baselines', baselineBody(flat, 'Assay'), 'qa')).body.code).toBe('NO_VARIATION');
  });

  it('a window restricts the data the baseline is computed from', async () => {
    const pr = await product();
    await seed(pr, 'Assay', new Array(5).fill(0).map((_, i) => 90 + i)); // before the window
    await seed(pr, 'Assay', SERIES, { startHour: 100 });
    const from = new Date(T0 + 100 * HOUR).toISOString(); const to = new Date(T0 + 129 * HOUR).toISOString();
    const b = ok<any>(await post('/trending/baselines', baselineBody(pr, 'Assay', { from, to }), 'qa')).baseline;
    expect(b.n).toBe(30); near(b.cl, CL);
    expect(new Date(b.dataFrom).toISOString()).toBe(from);
  });
});

describe('out-of-trend alerts: advisory, idempotent, acknowledged by QA', () => {
  it('a rule violation after the baseline raises one alert; a rerun raises none; no result, sample or release is touched', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa'));
    const [bad] = await seed(pr, 'Assay', [(CL + 3.5 * SIGMA).toFixed(6)], { startHour: 100 });
    await seed(pr, 'Assay', [CL.toFixed(3)], { startHour: 101 });
    const frozen = async () => JSON.stringify(await sql(`select (select json_agg(r order by id) from results r where r.sample_id in (select id from samples where material = $1)) as r, (select json_agg(s order by id) from samples s where material = $1) as s, (select count(*) from batch_releases) as br`, [pr.name]));
    const before = await frozen();
    const run = ok<any>(await post('/trending/alerts/evaluate', {}, 'qa'));
    expect(run.raised.length).toBeGreaterThanOrEqual(1);
    const alerts = ok<any[]>(await get(`/trending/alerts?productId=${pr.id}`, 'qa'));
    expect(alerts.map(a => [a.rule, a.severity, a.status, a.resultId])).toEqual([['N1', 'violation', 'Open', bad.resultId]]);
    expect(alerts[0].detail).toMatch(/Advisory/);
    expect(alerts[0].z).toBeGreaterThan(3.4);
    expect(ok<any>(await post('/trending/alerts/evaluate', {}, 'qa')).raised).toEqual([]); // idempotent
    expect(await frozen()).toBe(before);
    expect((await sql(`select count(*)::int n from audit_trail where entity = 'SpcAlert' and entity_id = $1`, [alerts[0].id]))[0].n).toBe(1);
  });

  it('points inside the baseline window never alert; the baseline of another attribute does not apply', async () => {
    const pr = await product();
    await seed(pr, 'Assay', [...SERIES, CL + 4 * SIGMA]); // an outlier INSIDE the window (the 31st point)
    await seed(pr, 'Other', [1, 50, 1, 1]);
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa'));
    ok(await post('/trending/alerts/evaluate', {}, 'qa'));
    expect(ok<any[]>(await get(`/trending/alerts?productId=${pr.id}`, 'qa'))).toEqual([]);
  });

  it('the Westgard rule set applies when the baseline says so; a warning is a warning', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay', { ruleSet: 'westgard' }), 'qa'));
    await seed(pr, 'Assay', [(CL + 2.5 * SIGMA).toFixed(6)], { startHour: 100 });
    ok(await post('/trending/alerts/evaluate', {}, 'qa'));
    const alerts = ok<any[]>(await get(`/trending/alerts?productId=${pr.id}`, 'qa'));
    expect(alerts.map(a => [a.rule, a.severity])).toEqual([['1-2s', 'warning']]);
  });

  it('acknowledging needs spc.manage, a note and the current version; it closes the alert and writes the audit entry', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa'));
    await seed(pr, 'Assay', [(CL + 3.5 * SIGMA).toFixed(6)], { startHour: 100 });
    ok(await post('/trending/alerts/evaluate', {}, 'qa'));
    const [alert] = ok<any[]>(await get(`/trending/alerts?status=Open&productId=${pr.id}`, 'analyst1'));
    expect((await post(`/trending/alerts/${alert.id}/acknowledge`, { note: 'Assessed, no impact', expectedVersion: 1 }, 'analyst1')).status).toBe(403);
    expect((await post('/trending/alerts/evaluate', {}, 'analyst1')).status).toBe(403);
    expect((await post(`/trending/alerts/${alert.id}/acknowledge`, { expectedVersion: 1 }, 'qa')).status).toBe(400);
    expect((await post(`/trending/alerts/${alert.id}/acknowledge`, { note: 'Assessed, no impact', expectedVersion: 1, status: 'Open' }, 'qa')).status).toBe(400);
    expect((await post(`/trending/alerts/${alert.id}/acknowledge`, { note: 'Assessed, no impact', expectedVersion: 7 }, 'qa')).status).toBe(409);
    const done = ok<any>(await post(`/trending/alerts/${alert.id}/acknowledge`, { note: 'Assessed: column replaced, DEV-12 opened', expectedVersion: 1 }, 'qa'));
    expect(done).toMatchObject({ status: 'Acknowledged', acknowledgedBy: 'usr-qa', acknowledgement: 'Assessed: column replaced, DEV-12 opened', version: 2 });
    expect((await post(`/trending/alerts/${alert.id}/acknowledge`, { note: 'Again please', expectedVersion: 2 }, 'qa')).status).toBe(409);
    expect((await sql(`select action from audit_trail where entity = 'SpcAlert' and entity_id = $1 order by sequence`, [alert.id])).map(r => r.action)).toEqual(['Create', 'Acknowledge']);
    expect(ok<any[]>(await get(`/trending/alerts?status=Open&productId=${pr.id}`, 'qa'))).toEqual([]);
  });

  it('the scheduled job does the same evaluation under the service principal', async () => {
    const pr = await product();
    await seed(pr, 'Assay', SERIES);
    ok(await post('/trending/baselines', baselineBody(pr, 'Assay'), 'qa'));
    await seed(pr, 'Assay', [(CL - 3.5 * SIGMA).toFixed(6)], { startHour: 100 });
    const { ootEvaluateHandler, OOT_SCHEDULES } = await import('../../src/server/schedules/oot');
    const { db } = await import('../../src/db/index');
    expect(OOT_SCHEDULES.map(s => s.type)).toEqual(['oot.evaluate']);
    const out: any = await ootEvaluateHandler({}, { db, job: { createdBy: null } } as any);
    expect(out.raised.length).toBeGreaterThanOrEqual(1);
    const [alert] = ok<any[]>(await get(`/trending/alerts?productId=${pr.id}`, 'qa'));
    expect(alert).toMatchObject({ rule: 'N1', detectedBy: 'svc-scheduler' });
  });
});

describe('stability shelf-life trending (one-sided 95 % confidence bound, ICH Q1E approach)', () => {
  const MONTHS = [0, 3, 6, 9, 12]; const ASSAY = [100.1, 99.6, 98.7, 98.4, 97.5];
  /** A study of the product with a pulled, approved sample per month point. */
  async function study(pr: Product, batch: string, values: number[], condition = 'LT-25-60', conditionId = 'STC-LT-25-60') {
    const [u] = await sql(`select id from users limit 1`);
    const [b] = await sql(`insert into product_batches (id, product_id, batch_no) values ($1, $2, $3) returning id`, [uniq('PB'), pr.id, batch]);
    const proto = uniq('SPR');
    await sql(`insert into stability_protocols (id, code, title, product_id, test_plan_code, conditions, month_points, window_days, revision, status) values ($1, $1, 't', $2, 'TP', '[]', '[0]', 7, 1, 'Approved')`, [proto, pr.id]);
    const studyId = uniq('STB');
    await sql(`insert into stability_studies (id, product, batch, condition, pull_points, start_date, status) values ($1, $2, $3, $4, '[0]', '2025-01-01', 'Ongoing')`, [studyId, pr.name, batch, condition]);
    await sql(`insert into stability_study_links (study_id, protocol_id, product_id, batch_id) values ($1, $2, $3, $4)`, [studyId, proto, pr.id, b.id]);
    for (let i = 0; i < values.length; i++) {
      const sampleId = uniq('S'); const resultId = uniq('R');
      await sql(`insert into samples (id, material, batch, state, created_by) values ($1, $2, $3, 'Approved', $4)`, [sampleId, pr.name, batch, u.id]);
      await sql(`insert into results (id, sample_id, parameter, value, spec_min, spec_max, entered_at) values ($1, $2, 'Assay', $3, 95, 105, now())`, [resultId, sampleId, String(values[i])]);
      await sql(`insert into stability_timepoints (id, study_id, condition_id, condition_code, month, due_date, window_start, window_end, status, sample_id) values ($1, $2, $3, $4, $5, '2025-01-01', '2025-01-01', '2025-01-01', 'Complete', $6)`, [uniq('TP'), studyId, conditionId, condition, MONTHS[i], sampleId]);
    }
    return studyId;
  }

  it('matches the reference calculation to 3 decimals; the supported figure is rounded down and capped; advisory', async () => {
    const pr = await product();
    await study(pr, 'STAB-1', ASSAY);
    const r = ok<any>(await get(`/stability-trend?productId=${pr.id}&parameter=Assay`, 'analyst1'));
    expect(r.advisory).toMatch(/advisory/i);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.points.map((p: any) => [p.month, p.value])).toEqual(MONTHS.map((m, i) => [m, ASSAY[i]]));
    expect(g).toMatchObject({ batch: 'STAB-1', conditionCode: 'LT-25-60', lower: 95, upper: 105, limitsChanged: false });
    expect(g.estimate.ok).toBe(true);
    const e = g.estimate.value;
    expect(e.fit.slope).toBeCloseTo(-0.21333333333333335, 3);
    expect(e.fit.intercept).toBeCloseTo(100.14, 3);
    expect(e.fit.s).toBeCloseTo(0.1591644851508443, 3);
    expect(e.estimateMonths).toBeCloseTo(21.17711120504538, 3);
    expect(e.predictionMonths).toBeCloseTo(20.753752007436812, 3);
    expect(e.limiting).toBe('lower');
    expect(e.supportedMonths).toBe(21);
    expect(r.conditions).toEqual([{ conditionCode: 'LT-25-60', supportedMonths: 21, estimateMonths: expect.any(Number), limitingBatch: 'STAB-1', batches: 1, estimated: 1 }]);
  });

  it('takes the shortest batch per condition; a short study says why it has no estimate; unapproved samples are not data', async () => {
    const pr = await product();
    await study(pr, 'STAB-A', ASSAY);
    await study(pr, 'STAB-B', [100.0, 99.0, 97.9, 96.8, 95.9]); // steeper
    await study(pr, 'STAB-C', [100.1, 99.6, 98.7], 'ACC-40-75', 'STC-ACC-40-75'); // 3 points only
    const r = ok<any>(await get(`/stability-trend?productId=${pr.id}&parameter=Assay`, 'analyst1'));
    const lt = r.conditions.find((c: any) => c.conditionCode === 'LT-25-60');
    expect(lt).toMatchObject({ batches: 2, estimated: 2, limitingBatch: 'STAB-B' });
    expect(lt.supportedMonths).toBeLessThan(21);
    const acc = r.groups.find((g: any) => g.conditionCode === 'ACC-40-75');
    expect(acc.estimate).toMatchObject({ ok: false, reason: 'TOO_FEW_POINTS' });
    expect(r.conditions.find((c: any) => c.conditionCode === 'ACC-40-75')).toMatchObject({ supportedMonths: null, estimated: 0 });
    await sql(`update samples set state = 'Pending Review' where material = $1 and batch = 'STAB-A'`, [pr.name]);
    const after = ok<any>(await get(`/stability-trend?productId=${pr.id}&parameter=Assay&conditionCode=LT-25-60`, 'analyst1'));
    expect(after.groups.map((g: any) => g.batch)).toEqual(['STAB-B']);
  });

  it('requires a valid query and a known product', async () => {
    const pr = await product();
    expect((await get(`/stability-trend?productId=${pr.id}`, 'analyst1')).status).toBe(400);
    expect((await get('/stability-trend?productId=NOPE&parameter=Assay', 'analyst1')).status).toBe(404);
    expect((await t.request.get('/api/stability-trend?productId=x&parameter=Assay')).status).toBe(401);
  });
});
