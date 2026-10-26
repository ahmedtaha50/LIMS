/**
 * Roadmap M18 (r2-methods-calc): methods, specification parameters bound to methods and formulas, version-controlled calculation
 * formulas, server-side calculation of results from their raw inputs, and system suitability (SST) that invalidates a run.
 *
 * Before: a specification held a JSONB list and there was no method; no server code calculated anything; a result was one typed
 * value; nothing knew about system suitability.
 *
 * After (each through the real application, its authorisation layer and PostgreSQL):
 *   - methods and formulas are Draft until an independent person signs them Effective (METHOD_APPROVAL, FORMULA_APPROVAL), bound
 *     to the record version; a new revision supersedes the old one in the same transaction; an Effective record is never edited;
 *   - a formula is approved only when every one of its test cases reproduces its expected value on the server;
 *   - a specification parameter names its method, its formula, its replicates and its stage; the normalised spec_parameters rows are
 *     written in the same transaction as the JSONB they mirror;
 *   - a calculated result is entered as raw inputs and always calculated on the server, rounded once; result_inputs keeps the inputs,
 *     the formula revision and its expression, so approving a new formula revision later changes no existing result;
 *   - entering a result on a parameter whose method has no Effective revision is a 400;
 *   - an SST %RSD of 2.7 against NMT 2.0 makes the run's results Invalid, blocks review, and opens no OOS investigation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { uniq, receiveSample } from '../helpers/fixtures';

let t: TestApp;
type Who = 'admin' | 'qa' | 'reviewer' | 'analyst1' | 'analyst2';
let H: Record<Who, { Authorization: string }>;
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await sql(text, params))[0];

beforeAll(async () => {
  t = await startTestApp();
  H = {
    admin: await t.auth('admin@gxp.com'), qa: await t.auth('qa@gxp.com'), reviewer: await t.auth('reviewer@gxp.com'),
    analyst1: await t.auth('analyst1@gxp.com'), analyst2: await t.auth('analyst2@gxp.com'),
  };
});

const post = (path: string, body: unknown, who: Who = 'qa') => t.request.post(`/api${path}`).set(H[who]).send(body as object);
const put = (path: string, body: unknown, who: Who = 'qa') => t.request.put(`/api${path}`).set(H[who]).send(body as object);
const get = (path: string, who: Who = 'qa') => t.request.get(`/api${path}`).set(H[who]);
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const SIGN = { password: 'password', reason: 'Reviewed and approved for GMP use' };

const RSD_CASE = { name: 'Six injections, hand calculation', inputs: { x: [1000, 1010, 990, 1005, 995, 1000] }, decimals: 2, expected: '0.71' };
const MEAN_CASE = { name: 'Duplicate preparations', inputs: { x: [99.1, 100.1] }, decimals: 1, expected: '99.6' };

/** A formula created by QA and signed Effective by the Administrator (independent of the author). */
async function effectiveFormula(over: Record<string, unknown> = {}) {
  const code = uniq('F');
  const created = ok(await post('/calc/formulas', {
    code, name: `Formula ${code}`, expression: 'mean(x)', inputs: [{ name: 'x', label: 'Replicate results', unit: '%', replicates: true }],
    unit: '%', testCases: [MEAN_CASE], ...over,
  }));
  const approved = ok(await post(`/calc/formulas/${created.id}/approve`, { ...SIGN, expectedVersion: created.version }, 'admin'));
  return approved.formula as { id: string; code: string; revision: number; status: string; version: number };
}

async function method(over: Record<string, unknown> = {}, approve = true) {
  const code = uniq('M');
  const created = ok(await post('/methods', { code, title: `HPLC method ${code}`, ...over }));
  if (!approve) return created as { id: string; code: string; version: number; status: string };
  return ok(await post(`/methods/${created.id}/approve`, { ...SIGN, expectedVersion: created.version }, 'admin')).method as { id: string; code: string; version: number; status: string };
}

const ASSAY = (binding: Record<string, unknown>) => ({ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null, ...binding });
const APPEARANCE = { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White tablets' };

/** An Active specification of a new material with the given parameters, written and approved through the API. */
async function activeSpec(parameters: unknown[]) {
  const material = uniq('Paracetamol 500 mg');
  const draft = ok(await post('/specifications', { material, effectiveDate: todayIso() }));
  const edited = ok(await put(`/specifications/${draft.id}`, { parameters, expectedVersion: draft.version }));
  const approved = ok(await post(`/specifications/${draft.id}/approve`, { ...SIGN, expectedVersion: edited.version }, 'admin'));
  return { material, spec: approved };
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A sample of `material` registered by analyst1 and moved to Testing; its results by parameter. */
async function sampleInTesting(material: string) {
  const s = ok(await post('/samples', { material, batch: uniq('B') }, 'analyst1'));
  await receiveSample(t, s.id);
  ok(await post(`/samples/${s.id}/transition`, { action: 'submit', expectedVersion: 1 }, 'analyst1'));
  const detail = ok(await get(`/samples/${s.id}`, 'analyst1'));
  const byName = Object.fromEntries(detail.results.map((r: any) => [r.parameter, r]));
  return { id: s.id as string, results: byName as Record<string, { id: string; version: number }> };
}

const sampleVersion = async (id: string) => (await one('SELECT version FROM samples WHERE id = $1', [id])).version as number;
const resultRow = (id: string) => one('SELECT value, is_oos, version, entered_by FROM results WHERE id = $1', [id]);

describe('methods', () => {
  it('are Draft when created, edited with the version predicate, and signed Effective by someone other than the author', async () => {
    const code = uniq('HPLC');
    const created = ok(await post('/methods', { code, title: 'Assay by HPLC', instrumentType: 'HPLC', requiredTrainingModule: 'SOP-QC-014' }));
    expect(created).toMatchObject({ code, revision: 1, status: 'Draft', version: 1, instrumentType: 'HPLC', requiredTrainingModule: 'SOP-QC-014', createdBy: 'usr-qa' });

    const edited = ok(await put(`/methods/${created.id}`, { title: 'Assay of paracetamol by HPLC', expectedVersion: 1 }));
    expect(edited).toMatchObject({ title: 'Assay of paracetamol by HPLC', version: 2 });
    expect((await put(`/methods/${created.id}`, { title: 'Stale', expectedVersion: 1 })).status).toBe(409);

    const own = await post(`/methods/${created.id}/approve`, { ...SIGN, expectedVersion: 2 });
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body.code).toBe('SOD_VIOLATION');
    expect((await one('SELECT count(*)::int AS n FROM signatures WHERE entity_type = $1 AND entity_id = $2', ['Method', created.id])).n).toBe(0);

    const res = ok(await post(`/methods/${created.id}/approve`, { ...SIGN, expectedVersion: 2 }, 'admin'));
    expect(res.method).toMatchObject({ status: 'Effective', approvedBy: 'usr-admin', version: 3 });
    const sig = await one('SELECT entity_type, meaning_code, record_version, signer_id FROM signatures WHERE id = $1', [res.signature.id]);
    expect(sig).toEqual({ entity_type: 'Method', meaning_code: 'METHOD_APPROVAL', record_version: 3, signer_id: 'usr-admin' });
    expect(ok(await get(`/signatures/verify/${res.signature.id}`))).toMatchObject({ status: 'valid', valid: true });

    const audit = await sql(`SELECT action FROM audit_trail WHERE entity = 'Method' AND entity_id = $1 ORDER BY sequence`, [created.id]);
    expect(audit.map(a => a.action)).toEqual(['Create', 'Update', 'Approve']);
    expect((await put(`/methods/${created.id}`, { title: 'Changed after approval', expectedVersion: 3 })).status).toBe(423);
  });

  it('a new revision is a Draft clone; approving it supersedes the Effective one in the same transaction', async () => {
    const m1 = await method({ instrumentType: 'HPLC' });
    const rev2 = ok(await post(`/methods/${m1.id}/revise`, {}));
    expect(rev2).toMatchObject({ code: m1.code, revision: 2, status: 'Draft', instrumentType: 'HPLC' });
    expect((await post(`/methods/${m1.id}/revise`, {})).status).toBe(409); // one Draft per code
    ok(await post(`/methods/${rev2.id}/approve`, { ...SIGN, expectedVersion: rev2.version }, 'admin'));
    const rows = await sql('SELECT revision, status FROM methods WHERE code = $1 ORDER BY revision', [m1.code]);
    expect(rows).toEqual([{ revision: 1, status: 'Superseded' }, { revision: 2, status: 'Effective' }]);
  });

  it('accept only what a person states (strict), and are created only with the methods permission', async () => {
    for (const extra of [{ status: 'Effective' }, { revision: 4 }, { version: 2 }, { id: 'M-1' }, { approvedBy: 'usr-qa' }, { surprise: 1 }]) {
      expect((await post('/methods', { code: uniq('M'), title: 'x', ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await post('/methods', { code: uniq('M'), title: 'x' }, 'analyst1')).status).toBe(403);
    const draft = await method({}, false);
    expect((await post(`/methods/${draft.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'reviewer')).status).toBe(403);
  });
});

describe('calculation formulas', () => {
  it('compile on the server: an undeclared or unused input, a forbidden name or call is a 400', async () => {
    const base = { code: uniq('F'), name: 'f', inputs: [{ name: 'x', replicates: true }], testCases: [] };
    expect((await post('/calc/formulas', { ...base, expression: 'mean(x) + y' })).status).toBe(400);
    expect((await post('/calc/formulas', { ...base, expression: '42' })).status).toBe(400);
    expect((await post('/calc/formulas', { ...base, expression: 'mean(x) + __proto__' })).status).toBe(400);
    expect((await post('/calc/formulas', { ...base, expression: 'eval(x)' })).status).toBe(400);
    expect((await post('/calc/formulas', { ...base, expression: 'mean(x); 1' })).status).toBe(400);
    expect((await post('/calc/formulas', { ...base, inputs: [{ name: '__proto__', replicates: false }], expression: '__proto__' })).status).toBe(400);
  });

  it('are approved only when every test case reproduces its hand-calculated value, and never without one', async () => {
    const none = ok(await post('/calc/formulas', { code: uniq('F'), name: 'RSD', expression: 'rsd(x)', inputs: [{ name: 'x', replicates: true }], testCases: [] }));
    const r1 = await post(`/calc/formulas/${none.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin');
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('FORMULA_UNTESTED');

    const wrong = ok(await post('/calc/formulas', { code: uniq('F'), name: 'RSD', expression: 'rsd(x)', inputs: [{ name: 'x', replicates: true }], testCases: [{ ...RSD_CASE, expected: '0.70' }] }));
    const r2 = await post(`/calc/formulas/${wrong.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin');
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('FORMULA_TEST_FAILED');
    expect(r2.body.error).toContain('0.71');
    expect((await one('SELECT status FROM calc_formulas WHERE id = $1', [wrong.id])).status).toBe('Draft');
    expect((await one(`SELECT count(*)::int AS n FROM audit_trail WHERE action = 'SignatureFailed' AND entity_id = $1`, [wrong.id])).n).toBe(0);

    const good = ok(await post('/calc/formulas', { code: uniq('F'), name: 'RSD', expression: 'rsd(x)', inputs: [{ name: 'x', replicates: true }], testCases: [RSD_CASE] }));
    const res = ok(await post(`/calc/formulas/${good.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin'));
    expect(res.formula).toMatchObject({ status: 'Effective', revision: 1, approvedBy: 'usr-admin' });
    expect(res.signature).toMatchObject({ entityType: 'CalcFormula', meaningCode: 'FORMULA_APPROVAL', recordVersion: res.formula.version });
    expect(ok(await get(`/signatures/verify/${res.signature.id}`))).toMatchObject({ status: 'valid' });
  });

  it('POST /calc/evaluate tries an expression without writing anything', async () => {
    const res = ok(await post('/calc/evaluate', { expression: 'rsd(x)', inputs: { x: [103, 97, 103, 97, 100, 100] }, decimals: 1 }, 'analyst1'));
    expect(res).toMatchObject({ reported: '2.7' });
    const bad = await post('/calc/evaluate', { expression: 'sd(x)', inputs: { x: [1] } }, 'analyst1');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/two/);
  });
});

describe('specification parameters bound to a method and a formula', () => {
  it('are stored in the JSONB and in spec_parameters, in one transaction, with the same limits', async () => {
    const m = await method();
    const f = await effectiveFormula();
    const { spec } = await activeSpec([ASSAY({ method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' }), APPEARANCE]);
    const rows = await sql('SELECT position, name, unit, limit_kind, lower::text, upper::text, decimals, text, method_code, formula_code, replicates, stage FROM spec_parameters WHERE spec_id = $1 ORDER BY position', [spec.id]);
    expect(rows).toEqual([
      // The numbers exactly as the JSONB holds them (98, as JSON writes 98.0); the declared decimals say how they are written.
      { position: 1, name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: '98', upper: '102', decimals: 1, text: null, method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' },
      { position: 2, name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White tablets', method_code: null, formula_code: null, replicates: null, stage: null },
    ]);
    const listed = ok<any[]>(await get('/specifications')).find(s => s.id === spec.id);
    expect(listed.parameters[0]).toMatchObject({ name: 'Assay', method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' });
    expect(listed.parameters[1]).not.toHaveProperty('method_code');
    // The signature on the specification covers the binding (it is in the signed JSONB).
    const stored = await one('SELECT parameters FROM specifications WHERE id = $1', [spec.id]);
    expect(stored.parameters[0]).toMatchObject({ method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' });
  });

  it('refuses a binding to a method or formula that does not exist, a formula on a text limit, and bad replicates', async () => {
    const draft = ok(await post('/specifications', { material: uniq('Material'), effectiveDate: todayIso() }));
    const f = await effectiveFormula();
    for (const bad of [
      [ASSAY({ method_code: 'NO-SUCH-METHOD' })],
      [ASSAY({ formula_code: 'NO-SUCH-FORMULA' })],
      [{ ...APPEARANCE, formula_code: f.code }],
      [ASSAY({ replicates: 0 })],
      [ASSAY({ replicates: 1.5 })],
      [ASSAY({ unknown_binding: 'x' })],
    ]) {
      const res = await put(`/specifications/${draft.id}`, { parameters: bad, expectedVersion: 1 });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await one('SELECT count(*)::int AS n FROM spec_parameters WHERE spec_id = $1', [draft.id])).n).toBe(0);
    expect((await one('SELECT version FROM specifications WHERE id = $1', [draft.id])).version).toBe(1);
  });

  it('the database refuses to change the parameters of a specification that is no longer a Draft', async () => {
    const { spec } = await activeSpec([ASSAY({})]);
    await expect(t.db.pool.query(`UPDATE spec_parameters SET upper = 105 WHERE spec_id = $1`, [spec.id])).rejects.toThrow(/Draft/);
    await expect(t.db.pool.query(`DELETE FROM spec_parameters WHERE spec_id = $1`, [spec.id])).rejects.toThrow(/Draft/);
  });
});

describe('calculated results', () => {
  it('are calculated on the server from the raw inputs, rounded once, and keep the inputs and the formula revision', async () => {
    const m = await method();
    const f = await effectiveFormula();
    const { material } = await activeSpec([ASSAY({ method_code: m.code, formula_code: f.code, replicates: 2 }), APPEARANCE]);
    const s = await sampleInTesting(material);
    const assay = s.results.Assay;

    // The client never sends the value.
    expect((await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [99.1, 100.1] }, value: '100.0', reason: 'Calculated', expectedVersion: 1 }, 'analyst1')).status).toBe(400);
    // The replicates the specification declares.
    const three = await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [99.1, 100.1, 99.0] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1');
    expect(three.status).toBe(400);
    expect(three.body.error).toMatch(/2/);
    // A calculated parameter is not typed in.
    const typed = await put(`/samples/${s.id}/results/${assay.id}`, { value: '99.6', reason: 'Typed in', expectedVersion: 1 }, 'analyst1');
    expect(typed.status).toBe(400);
    expect(typed.body.error).toMatch(/calculat/i);

    const res = ok(await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Duplicate preparations', expectedVersion: 1 }, 'analyst1'));
    expect(res.result).toMatchObject({ value: '99.6', isOos: false, version: 2 });
    expect(res.input).toMatchObject({ formulaId: f.id, formulaRevision: 1, rawValue: '99.6', reportedValue: '99.6' });
    const stored = await one('SELECT result_id, result_version, formula_id, formula_revision, expression, inputs, raw_value, reported_value, entered_by FROM result_inputs WHERE id = $1', [res.input.id]);
    expect(stored).toEqual({
      result_id: assay.id, result_version: 2, formula_id: f.id, formula_revision: 1, expression: 'mean(x)', inputs: { x: [99.1, 100.1] },
      raw_value: '99.6', reported_value: '99.6', entered_by: 'usr-analyst1',
    });
    const audit = await sql(`SELECT entity, action FROM audit_trail WHERE entity_id IN ($1, $2) ORDER BY sequence`, [assay.id, res.input.id]);
    expect(audit).toEqual([{ entity: 'Result', action: 'Update' }, { entity: 'ResultInput', action: 'Create' }]);
    await expect(t.db.pool.query(`UPDATE result_inputs SET raw_value = '100' WHERE id = $1`, [res.input.id])).rejects.toThrow(/append-only/);

    // An out-of-specification calculation opens its investigation, as a typed one does.
    const oos = ok(await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [96.0, 96.4] }, reason: 'Re-calculated', expectedVersion: 2, reasonCode: 'CALCULATION_ERROR' }, 'analyst1'));
    expect(oos.result).toMatchObject({ value: '96.2', isOos: true });
    expect(oos.oosInvestigationId).toMatch(/^OOS-/);

    // Replacing a calculated OOS value names its open investigation and a coded reason, as a typed one does.
    const bare = await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [99.0, 99.4] }, reason: 'Re-preparation', expectedVersion: 3, reasonCode: 'SAMPLE_PREPARATION_ERROR' }, 'analyst1');
    expect(bare.status).toBe(400);
    expect(bare.body.error).toContain(oos.oosInvestigationId);
    const fixed = ok(await post(`/calc/samples/${s.id}/results/${assay.id}`, {
      inputs: { x: [99.0, 99.4] }, reason: 'Dilution error confirmed in Phase I', expectedVersion: 3, oosId: oos.oosInvestigationId, reasonCode: 'SAMPLE_PREPARATION_ERROR',
    }, 'analyst1'));
    expect(fixed.result).toMatchObject({ value: '99.2', isOos: false, version: 4 });
    expect(fixed.input).toMatchObject({ resultVersion: 4, reportedValue: '99.2' });
    const reason = await one(`SELECT reason FROM audit_trail WHERE entity = 'Result' AND entity_id = $1 ORDER BY sequence DESC LIMIT 1`, [assay.id]);
    expect(reason.reason).toMatch(new RegExp(`^\\[SAMPLE_PREPARATION_ERROR\\] OOS ${oos.oosInvestigationId}`));
  });

  it('approving a new formula revision afterwards leaves an existing result exactly as it was', async () => {
    const m = await method();
    const f1 = await effectiveFormula();
    const { material } = await activeSpec([ASSAY({ method_code: m.code, formula_code: f1.code })]);
    const s = await sampleInTesting(material);
    const first = ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1'));

    const rev2 = ok(await post(`/calc/formulas/${f1.id}/revise`, {}));
    const edited = ok(await put(`/calc/formulas/${rev2.id}`, { expression: 'mean(x) * 1.01', testCases: [{ ...MEAN_CASE, expected: '100.6' }], expectedVersion: rev2.version }));
    ok(await post(`/calc/formulas/${rev2.id}/approve`, { ...SIGN, expectedVersion: edited.version }, 'admin'));
    expect((await one('SELECT status FROM calc_formulas WHERE id = $1', [f1.id])).status).toBe('Superseded');
    expect((await put(`/calc/formulas/${f1.id}`, { expression: 'mean(x) * 2', expectedVersion: 99 })).status).toBe(423);

    expect(await resultRow(s.results.Assay.id)).toMatchObject({ value: '99.6', version: 2 });
    expect(await one('SELECT formula_id, formula_revision, expression, reported_value FROM result_inputs WHERE id = $1', [first.input.id]))
      .toEqual({ formula_id: f1.id, formula_revision: 1, expression: 'mean(x)', reported_value: '99.6' });

    // The next calculation uses the revision now in force.
    const next = ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Recalculated with rev 2', expectedVersion: 2, reasonCode: 'CALCULATION_ERROR' }, 'analyst1'));
    expect(next.input).toMatchObject({ formulaId: rev2.id, formulaRevision: 2, reportedValue: '100.6' });

    // A Draft revision is never used, even when it is the newest.
    const rev3 = ok(await post(`/calc/formulas/${rev2.id}/revise`, {}));
    ok(await put(`/calc/formulas/${rev3.id}`, { expression: 'mean(x) * 2', expectedVersion: rev3.version }));
    const again = ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Recalculated while rev 3 is a Draft', expectedVersion: 3, reasonCode: 'CALCULATION_ERROR' }, 'analyst1'));
    expect(again.input).toMatchObject({ formulaId: rev2.id, formulaRevision: 2, reportedValue: '100.6' });
  });
});

describe('calculated results: concurrency, the record, and a new specification revision', () => {
  it('a stale version is a 409 and writes nothing; the sample view shows the calculation of the current version', async () => {
    const m = await method();
    const f = await effectiveFormula();
    const { material } = await activeSpec([ASSAY({ method_code: m.code, formula_code: f.code, replicates: 2 })]);
    const s = await sampleInTesting(material);
    const assay = s.results.Assay;
    ok(await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1'));
    const stale = await post(`/calc/samples/${s.id}/results/${assay.id}`, { inputs: { x: [98.0, 98.2] }, reason: 'Stale screen', expectedVersion: 1 }, 'analyst1');
    expect(stale.status).toBe(409);
    expect((await one('SELECT count(*)::int AS n FROM result_inputs WHERE result_id = $1', [assay.id])).n).toBe(1);
    expect(await resultRow(assay.id)).toMatchObject({ value: '99.6', version: 2 });

    const view = ok(await get(`/calc/samples/${s.id}`, 'analyst1'));
    const row = view.results.find((r: any) => r.resultId === assay.id);
    expect(row).toMatchObject({ methodCode: m.code, formulaCode: f.code, replicates: 2, version: 2, validity: { status: 'Valid' } });
    expect(row.calculation).toMatchObject({ resultVersion: 2, reportedValue: '99.6', inputs: { x: [99.1, 100.1] } });
  });

  it('a new revision of the specification keeps the bindings of the one it is drafted from', async () => {
    const m = await method();
    const f = await effectiveFormula();
    const { material, spec } = await activeSpec([ASSAY({ method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' })]);
    const rev2 = ok(await post('/specifications', { material, effectiveDate: todayIso(), reviseFrom: spec.id }));
    expect(rev2.parameters[0]).toMatchObject({ method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' });
    expect(await one('SELECT method_code, formula_code, replicates, stage FROM spec_parameters WHERE spec_id = $1', [rev2.id]))
      .toEqual({ method_code: m.code, formula_code: f.code, replicates: 2, stage: 'Release' });
  });
});

describe('entry on a parameter whose method is not Effective', () => {
  it('is a 400, typed or calculated, and nothing is written', async () => {
    const draftMethod = await method({}, false);
    const f = await effectiveFormula();
    const { material } = await activeSpec([ASSAY({ method_code: draftMethod.code, formula_code: f.code }), { ...APPEARANCE, method_code: draftMethod.code }]);
    const s = await sampleInTesting(material);

    const calc = await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1');
    expect(calc.status).toBe(400);
    expect(calc.body.error).toMatch(/Draft/);
    const typed = await put(`/samples/${s.id}/results/${s.results.Appearance.id}`, { value: 'Complies', reason: 'Visual inspection', expectedVersion: 1 }, 'analyst1');
    expect(typed.status).toBe(400);
    expect(typed.body.error).toMatch(/Draft/);
    expect(await resultRow(s.results.Assay.id)).toMatchObject({ value: null, version: 1 });
    expect(await resultRow(s.results.Appearance.id)).toMatchObject({ value: null, version: 1 });
    expect((await one('SELECT count(*)::int AS n FROM result_inputs WHERE sample_id = $1', [s.id])).n).toBe(0);
  });

  it('a method that names an instrument type needs an instrument of that type', async () => {
    const m = await method({ instrumentType: 'KF Titrator' });
    const { material } = await activeSpec([{ ...APPEARANCE, method_code: m.code }]);
    const s = await sampleInTesting(material);
    const res = await put(`/samples/${s.id}/results/${s.results.Appearance.id}`, { value: 'Complies', reason: 'Visual inspection', expectedVersion: 1 }, 'analyst1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/KF Titrator/);
  });
});

describe('system suitability', () => {
  async function sstSetup(over: Record<string, unknown> = {}) {
    const rsd = await effectiveFormula({ expression: 'rsd(x)', testCases: [RSD_CASE] });
    const mean = await effectiveFormula();
    const m = await method({ sstCriteria: [{ name: 'Repeatability, %RSD of 6 standard injections', formulaCode: rsd.code, limit_kind: 'NMT', lower: null, upper: 2.0, decimals: 1, replicates: 6 }], ...over });
    const { material } = await activeSpec([ASSAY({ method_code: m.code, formula_code: mean.code }), APPEARANCE]);
    const s = await sampleInTesting(material);
    return { m, s };
  }
  const sst = (sampleId: string, methodCode: string, x: number[]) =>
    post(`/calc/samples/${sampleId}/sst`, { methodCode, criteria: [{ name: 'Repeatability, %RSD of 6 standard injections', inputs: { x } }], reason: 'Run 1 system suitability' }, 'analyst1');
  const review = async (id: string) => post(`/samples/${id}/transition`, { action: 'review', expectedVersion: await sampleVersion(id), password: 'password', reason: 'Results complete' }, 'analyst1');

  it('RSD 2.7 against NMT 2.0 makes the run Invalid, blocks review and opens no OOS; a passing run and re-entry clear it', async () => {
    const { m, s } = await sstSetup();
    ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1'));
    ok(await put(`/samples/${s.id}/results/${s.results.Appearance.id}`, { value: 'Complies', reason: 'Visual inspection', expectedVersion: 1 }, 'analyst1'));

    const failed = ok(await sst(s.id, m.code, [103, 97, 103, 97, 100, 100]));
    expect(failed.run).toMatchObject({ passed: false, methodCode: m.code });
    expect(failed.run.outcomes).toEqual([expect.objectContaining({ name: 'Repeatability, %RSD of 6 standard injections', reported: '2.7', passed: false })]);
    expect(failed.invalidatedResults).toEqual([s.results.Assay.id]);
    const invalidated = await sql(`SELECT field, old_value, new_value FROM audit_trail WHERE entity = 'Result' AND entity_id = $1 AND action = 'Invalidate'`, [s.results.Assay.id]);
    expect(invalidated).toEqual([{ field: 'validity', old_value: 'Valid', new_value: 'Invalid' }]);

    const view = ok(await get(`/calc/samples/${s.id}`, 'analyst1'));
    expect(view.results.find((r: any) => r.resultId === s.results.Assay.id).validity.status).toBe('Invalid');
    expect(view.results.find((r: any) => r.resultId === s.results.Appearance.id).validity.status).toBe('Valid');

    const blocked = await review(s.id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('TRANSITION_BLOCKED');
    expect(blocked.body.error).toMatch(/system suitability/i);
    expect((await one('SELECT count(*)::int AS n FROM oos_investigations WHERE sample_id = $1', [s.id])).n).toBe(0);
    expect((await resultRow(s.results.Assay.id)).is_oos).toBe(false);

    // No result of the run is entered while its system suitability has failed.
    const during = await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Retry', expectedVersion: 2, reasonCode: 'INSTRUMENT_MALFUNCTION' }, 'analyst1');
    expect(during.status).toBe(400);
    expect(during.body.error).toMatch(/system suitability/i);

    // A passing run does not revalidate a result measured in the failed one: it must be entered again.
    expect(ok(await sst(s.id, m.code, [100.2, 100.4, 99.9, 100.1, 100.3, 100.0])).run).toMatchObject({ passed: true });
    expect((await review(s.id)).status).toBe(400);
    ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.3, 100.1] }, reason: 'Re-injected after passing SST', expectedVersion: 2, reasonCode: 'INSTRUMENT_MALFUNCTION' }, 'analyst1'));
    const passed = await review(s.id);
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(passed.body.state).toBe('Pending Review');
  });

  it('a method with SST criteria needs a recorded run before review, and the run must cover every criterion', async () => {
    const { m, s } = await sstSetup();
    ok(await post(`/calc/samples/${s.id}/results/${s.results.Assay.id}`, { inputs: { x: [99.1, 100.1] }, reason: 'Calculated', expectedVersion: 1 }, 'analyst1'));
    ok(await put(`/samples/${s.id}/results/${s.results.Appearance.id}`, { value: 'Complies', reason: 'Visual inspection', expectedVersion: 1 }, 'analyst1'));
    const blocked = await review(s.id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/system suitability/i);

    expect((await post(`/calc/samples/${s.id}/sst`, { methodCode: m.code, criteria: [] }, 'analyst1')).status).toBe(400);
    expect((await sst(s.id, m.code, [100, 100, 100, 100, 100])).status).toBe(400); // 6 injections declared
    expect((await post(`/calc/samples/${s.id}/sst`, { methodCode: m.code, criteria: [{ name: 'Repeatability, %RSD of 6 standard injections', inputs: { x: [100, 101, 99, 100, 101, 99] } }] }, 'reviewer')).status).toBe(403);
  });
});

describe('system suitability on an instrument', () => {
  const CRITERION = 'Repeatability, %RSD of 6 standard injections';
  const instrument = async (type: string, due: string, status = 'Active') => {
    const id = uniq('INS');
    await sql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ($1, $2, $3, $4, $5, '2026-01-01')`, [id, `${type} 1`, type, status, due]);
    return id;
  };

  it('is recorded only on an existing, Active, calibrated instrument of the type the method names', async () => {
    const rsd = await effectiveFormula({ expression: 'rsd(x)', testCases: [RSD_CASE] });
    const mean = await effectiveFormula();
    const m = await method({ instrumentType: 'HPLC', sstCriteria: [{ name: CRITERION, formulaCode: rsd.code, limit_kind: 'NMT', lower: null, upper: 2.0, decimals: 1, replicates: 6 }] });
    const { material } = await activeSpec([ASSAY({ method_code: m.code, formula_code: mean.code })]);
    const s = await sampleInTesting(material);
    const run = (instrumentId?: string) => post(`/calc/samples/${s.id}/sst`, {
      methodCode: m.code, criteria: [{ name: CRITERION, inputs: { x: [100.2, 100.4, 99.9, 100.1, 100.3, 100.0] } }], ...(instrumentId ? { instrumentId } : {}),
    }, 'analyst1');

    const refusals: Array<[string | undefined, RegExp]> = [
      [undefined, /HPLC/],
      ['NO-SUCH-INSTRUMENT', /does not exist/],
      [await instrument('Weighing', '2030-01-01'), /HPLC/],
      [await instrument('HPLC', '2020-01-01'), /calibration/],
      [await instrument('HPLC', '2030-01-01', 'Out of Service'), /Out of Service/],
    ];
    for (const [id, pattern] of refusals) {
      const res = await run(id);
      expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error, String(id)).toMatch(pattern);
    }
    expect((await one('SELECT count(*)::int AS n FROM sst_runs WHERE sample_id = $1', [s.id])).n).toBe(0);

    const good = await instrument('HPLC', '2030-01-01');
    expect(ok(await run(good)).run).toMatchObject({ passed: true, instrumentId: good });
  });
});

describe('test plans', () => {
  it('name the parameters of the specification in force that a kind of sample is tested for, and are signed Effective', async () => {
    const { material } = await activeSpec([ASSAY({}), APPEARANCE]);
    const plan = ok(await post('/test-plans', { code: uniq('TP'), name: 'Stability pull', material, purpose: 'Stability', parameters: ['Assay'] }));
    expect(plan).toMatchObject({ status: 'Draft', revision: 1, parameters: ['Assay'] });
    const bad = ok(await post('/test-plans', { code: uniq('TP'), name: 'Wrong', material, purpose: 'Release', parameters: ['Assay', 'Dissolution'] }));
    const refused = await post(`/test-plans/${bad.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('Dissolution');

    const res = ok(await post(`/test-plans/${plan.id}/approve`, { ...SIGN, expectedVersion: 1 }, 'admin'));
    expect(res.plan).toMatchObject({ status: 'Effective' });
    expect(res.signature).toMatchObject({ entityType: 'TestPlan', meaningCode: 'TEST_PLAN_APPROVAL' });
    const listed = ok<any[]>(await get(`/test-plans?material=${encodeURIComponent(material)}`, 'analyst1'));
    expect(listed.map(p => p.id).sort()).toEqual([plan.id, bad.id].sort());
  });
});
