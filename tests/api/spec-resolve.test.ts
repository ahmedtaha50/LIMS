/**
 * Roadmap M11 (r1-spec): resolveActiveSpec(), the one way registration (r1-results-oos) chooses the specification a sample is
 * tested against.
 *
 *   * the Active revision with the latest effective date that is on or before the date asked for;
 *   * a future-dated revision is not selectable before its date; a Draft or an Obsolete one never is;
 *   * what it returns carries the id and the revision number, which the sample keeps (sidecar table of r1-results-oos), so a sample
 *     registered under revision 2 is still tested against revision 2's limits after revision 3 is approved.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let t: TestApp;
let specs: typeof import('../../src/server/lib/specs');
let appDb: typeof import('../../src/db/index')['db'];
const H: Record<string, { Authorization: string }> = {};
const sql = async (text: string, params: unknown[] = []) => (await t.db.pool.query(text, params)).rows;

const pad = (n: number) => String(n).padStart(2, '0');
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const P = (over: Record<string, unknown> = {}) => ({ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, ...over });

beforeAll(async () => {
  t = await startTestApp();
  specs = await import('../../src/server/lib/specs');
  appDb = (await import('../../src/db/index')).db;
  const { ROUTE_RULES } = await import('../../src/server/authz/routeTable');
  const v = await import('../../src/lib/validations/specifications');
  const rules = ROUTE_RULES as Record<string, { body?: unknown }>;
  if ((v as any).specificationUpdateSchema) rules['PUT /specifications/:id'].body = (v as any).specificationUpdateSchema;
  if ((v as any).specificationApproveSchema) rules['POST /specifications/:id/approve'].body = (v as any).specificationApproveSchema;
  for (const u of ['qa', 'analyst1']) H[u] = await t.auth(`${u}@gxp.com`);
});

let n = 0;
async function put(material: string, revision: number, date: string, status = 'Active', parameters: unknown[] = [P()]) {
  const id = `SPEC-RS-${process.pid}-${++n}`;
  await sql(`INSERT INTO specifications (id, material, version, revision_label, effective_date, status, parameters) VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb)`,
    [id, material, revision, date, status, JSON.stringify(parameters)]);
  return id;
}

describe('resolveActiveSpec', () => {
  it('returns the id, the revision, the effective date and the limits of the Active revision', async () => {
    const m = uniq('Resolve');
    const id = await put(m, 3, day(-10));
    expect(await specs.resolveActiveSpec(appDb, m)).toEqual({
      id, material: m, revision: 3, effectiveDate: day(-10),
      parameters: [{ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null }],
    });
  });

  it('returns null when the material has no specification, or none that is Active', async () => {
    expect(await specs.resolveActiveSpec(appDb, uniq('Nothing'))).toBeNull();
    const m = uniq('OnlyDraft');
    await put(m, 1, day(-1), 'Draft'); await put(m, 2, day(-1), 'Obsolete');
    expect(await specs.resolveActiveSpec(appDb, m)).toBeNull();
  });

  it('chooses the latest effective date on or before the date: the future one is not selectable before its day', async () => {
    const m = uniq('Dated');
    const r1 = await put(m, 1, day(-30)); const r2 = await put(m, 2, day(30));
    expect((await specs.resolveActiveSpec(appDb, m))?.id).toBe(r1);
    expect((await specs.resolveActiveSpec(appDb, m, day(29)))?.id).toBe(r1);
    expect((await specs.resolveActiveSpec(appDb, m, day(30)))?.id).toBe(r2);
    expect((await specs.resolveActiveSpec(appDb, m, day(300)))?.id).toBe(r2);
    expect(await specs.resolveActiveSpec(appDb, m, day(-31))).toBeNull(); // before the first one existed
  });

  it('a material whose only revision is dated in the future has no specification today', async () => {
    const m = uniq('FutureOnly');
    await put(m, 1, day(2));
    expect(await specs.resolveActiveSpec(appDb, m)).toBeNull();
  });

  it('takes a Date (its calendar day on this machine) or a YYYY-MM-DD text, and refuses anything else', async () => {
    const m = uniq('Types');
    const r1 = await put(m, 1, '2026-03-01'); const r2 = await put(m, 2, '2026-06-01');
    expect((await specs.resolveActiveSpec(appDb, m, new Date(2026, 4, 31, 23, 59)))?.id).toBe(r1);
    expect((await specs.resolveActiveSpec(appDb, m, new Date(2026, 5, 1, 0, 0)))?.id).toBe(r2);
    expect((await specs.resolveActiveSpec(appDb, m, '2026-06-01'))?.id).toBe(r2);
    await expect(specs.resolveActiveSpec(appDb, m, 'June 1')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(specs.resolveActiveSpec(appDb, m, '2026-02-30')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('two Active revisions with one date: the higher revision wins', async () => {
    const m = uniq('Tie');
    await put(m, 1, day(-5)); const r2 = await put(m, 2, day(-5));
    expect((await specs.resolveActiveSpec(appDb, m))?.id).toBe(r2);
  });

  it('never selects a revision whose effective date is not a date (v0.1.0 took any text): it fails closed', async () => {
    const m = uniq('Garbage');
    await put(m, 1, 'next Tuesday'); await put(m, 2, '15/03/2026');
    expect(await specs.resolveActiveSpec(appDb, m)).toBeNull();
  });

  it('reads the limits of a specification written by v0.1.0 as limits of the new kinds', async () => {
    const m = uniq('OldShape');
    await put(m, 1, day(-1), 'Active', [{ name: 'Assay', min: 98, max: 102 }, { name: 'Water', min: null, max: 3 }]);
    const s = await specs.resolveActiveSpec(appDb, m);
    expect(s?.parameters.map(p => [p.name, p.limit_kind, p.lower, p.upper, p.decimals])).toEqual([['Assay', 'RANGE', 98, 102, null], ['Water', 'NMT', null, 3, null]]);
  });

  it('works inside a transaction, so registration can resolve and bind in one', async () => {
    const m = uniq('InTx');
    const id = await put(m, 1, day(-1));
    const got = await appDb.transaction(async tx => specs.resolveActiveSpec(tx, m));
    expect(got?.id).toBe(id);
  });
});

describe('todayIso', () => {
  it('is the calendar day on this machine, not the UTC day', () => {
    expect(specs.todayIso(new Date(2026, 0, 31, 23, 59, 59))).toBe('2026-01-31');
    expect(specs.todayIso(new Date(2026, 1, 1, 0, 0, 0))).toBe('2026-02-01');
    expect(specs.todayIso()).toBe(day(0));
  });
});

describe('a sample keeps the revision it was registered under', () => {
  it('after revision 3 is approved, the id and revision a sample stored still lead to revision 2 and its limits, unchanged', async () => {
    const material = uniq('Keeps');
    const create = (body: Record<string, unknown>) => t.request.post('/api/specifications').set(H.analyst1).send(body);
    const edit = (s: { id: string; version: number }, upper: number) => t.request.put(`/api/specifications/${s.id}`).set(H.analyst1).send({ parameters: [P({ upper })], expectedVersion: s.version });
    const approve = (s: { id: string; version: number }) => t.request.post(`/api/specifications/${s.id}/approve`).set(H.qa).send({ password: TEST_PASSWORD, expectedVersion: s.version });

    const c1 = await create({ material, effectiveDate: day(0) });
    expect((await approve((await edit(c1.body, 102)).body)).status).toBe(200);
    const c2 = await create({ material, effectiveDate: day(0), reviseFrom: c1.body.id });
    expect((await approve((await edit(c2.body, 103)).body)).status).toBe(200);

    // Registration, as r1-results-oos will do it: resolve inside the sample's transaction and keep what it returns.
    const registered = await appDb.transaction(async tx => {
      const spec = await specs.resolveActiveSpec(tx, material);
      return { specId: spec!.id, specRevision: spec!.revision };
    });
    expect(registered.specRevision).toBe(2);

    const c3 = await create({ material, effectiveDate: day(0), reviseFrom: registered.specId });
    expect((await approve((await edit(c3.body, 104)).body)).status).toBe(200);

    expect((await specs.resolveActiveSpec(appDb, material))?.revision).toBe(3);
    const kept = (await sql('SELECT revision_label, status, parameters FROM specifications WHERE id = $1', [registered.specId]))[0];
    expect(kept.revision_label).toBe(2);
    expect(kept.status).toBe('Obsolete');
    expect(kept.parameters[0]).toMatchObject({ lower: 98, upper: 103 }); // revision 2's limits, not revision 3's 104
  });
});
