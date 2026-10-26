/**
 * Roadmap M18 (r2-methods-calc), migration 0110_methods_calc: methods, calc_formulas, test_plans, spec_parameters, result_inputs and
 * sst_runs, the three approval meanings and the methods permissions.
 *
 * Acceptance: "the spec_parameters migration shows identical limits (row-count and value diff)". The backfill is checked against
 * normalizeParameters(), the reader the application has used since R1, on every shape a stored specification can hold: v0.1.0's
 * {name, min, max}, the R1 shape with each limit kind, mixed and odd rows, a specification with no parameters, and the real v0.1.0
 * fixture. The JSONB column is not touched (it stays for rollback), and the specification signatures verify as before.
 */
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pushSchema } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import * as calc from '../../src/db/schema/calc';
import * as master from '../../src/db/schema/master';
import * as methods from '../../src/db/schema/methods';
import { normalizeParameters } from '../../src/lib/validations/specifications';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { loadV010, scratchDb, tableExists, type Scratch } from '../upgrade/helpers';

const DIR = path.join(path.resolve(__dirname, '..', '..'), 'drizzle');
const ID = '0110_methods_calc';
const TABLES = ['methods', 'calc_formulas', 'test_plans', 'spec_parameters', 'result_inputs', 'sst_runs'];
const MEANINGS = ['FORMULA_APPROVAL', 'METHOD_APPROVAL', 'TEST_PLAN_APPROVAL'];
const backup = async () => ({ file: 'methods-test.bak', sha256: 'c'.repeat(64), verified: true });
const lastBefore = () => loadMigrations(DIR).map(f => f.id).filter(id => id < ID).pop()!;

/** spec_parameters, as the reader sees them, keyed and ordered like normalizeParameters() of the JSONB. */
async function diff(s: Scratch) {
  const specs = (await s.pool.query('SELECT id, parameters FROM specifications ORDER BY id')).rows;
  const expected = specs.flatMap(sp => normalizeParameters(sp.parameters).map((p, i) => ({ spec_id: sp.id, position: i + 1, ...p })));
  const rows = (await s.pool.query(`
    SELECT spec_id, position, name, unit, limit_kind, lower::float8 AS lower, upper::float8 AS upper, decimals, text
      FROM spec_parameters ORDER BY spec_id, position`)).rows;
  // The exact digits too: the numeric column holds the number exactly as the JSONB wrote it.
  const digits = (await s.pool.query(`
    SELECT count(*)::int AS n FROM spec_parameters sp JOIN specifications s ON s.id = sp.spec_id,
           LATERAL (SELECT e FROM jsonb_array_elements(s.parameters) WITH ORDINALITY AS x(e, i) WHERE x.i = sp.position) j
     WHERE (sp.lower IS NOT NULL AND sp.lower::text <> COALESCE(j.e->'lower', j.e->'min')::text)
        OR (sp.upper IS NOT NULL AND sp.upper::text <> COALESCE(j.e->'upper', j.e->'max')::text)`)).rows[0].n;
  return { expected, rows, digits };
}

describe('the migration file', () => {
  it(`is ${ID}, in the range of this track`, () => {
    expect(loadMigrations(DIR).map(f => f.id)).toContain(ID);
  });
});

describe('a script built from the migrations (the structure a restore starts from)', () => {
  it('creates the tables and seeds nothing', async () => {
    const s = await scratchDb('mc-replay');
    await s.pool.query(buildSchemaSql(loadMigrations(DIR)));
    for (const table of TABLES) {
      expect(await tableExists(s.pool, table), table).toBe(true);
      expect((await s.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM signature_meanings WHERE code = ANY($1)`, [MEANINGS])).rows[0].n).toBe(0);
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM permissions WHERE code LIKE 'method.%'`)).rows[0].n).toBe(0);
  });
});

describe('the migration runner on a new installation', () => {
  it('installs the three approval meanings and the methods permissions', async () => {
    const s = await scratchDb('mc-new');
    await migrate(s.pool, { dir: DIR });
    const meanings = (await s.pool.query(`SELECT code, allowed_roles, requires_reason, training_exempt FROM signature_meanings WHERE code = ANY($1) ORDER BY code`, [MEANINGS])).rows;
    expect(meanings).toEqual(MEANINGS.map(code => ({ code, allowed_roles: ['QA', 'Admin'], requires_reason: false, training_exempt: false })));
    const grants = (await s.pool.query(`SELECT role_id, permission_code FROM role_permissions WHERE permission_code LIKE 'method.%' ORDER BY 1, 2`)).rows;
    expect(grants.map(g => `${g.role_id}:${g.permission_code}`)).toEqual([
      'role-admin:method.approve', 'role-admin:method.manage', 'role-admin:method.view',
      'role-analyst:method.view',
      'role-qa:method.approve', 'role-qa:method.manage', 'role-qa:method.view',
      'role-reviewer:method.manage', 'role-reviewer:method.view',
    ]);
  });

  it('src/db/schema/methods.ts and calc.ts declare exactly what the migrations build (no drift)', async () => {
    const s = await scratchDb('mc-drift');
    await migrate(s.pool, { dir: DIR });
    const statements = (await pushSchema({ ...schema, ...master, ...methods, ...calc }, drizzle(s.pool) as any, ['public'], ['!schema_migrations'])).statementsToExecute;
    // Only this track's tables: other tracks of the wave may have migrations in drizzle/ whose schema is not exported yet
    // (tests/upgrade/schema-drift.test.ts judges the whole schema at the gate).
    expect(statements.filter(st => TABLES.some(table => st.includes(`"${table}"`)))).toEqual([]);
  });

  it('the database keeps one Draft and one Effective revision per code, and the run records append-only', async () => {
    const s = await scratchDb('mc-keys');
    await migrate(s.pool, { dir: DIR });
    await s.pool.query(`INSERT INTO methods (id, code, title, revision, status) VALUES ('M1', 'HPLC-1', 't', 1, 'Effective'), ('M2', 'HPLC-1', 't', 2, 'Draft')`);
    await expect(s.pool.query(`INSERT INTO methods (id, code, title, revision, status) VALUES ('M3', 'hplc-1', 't', 3, 'Draft')`)).rejects.toThrow(/methods_one_draft_uidx/);
    await expect(s.pool.query(`INSERT INTO methods (id, code, title, revision, status) VALUES ('M4', 'HPLC-1', 't', 2, 'Superseded')`)).rejects.toThrow(/methods_code_revision_uidx/);
    await expect(s.pool.query(`INSERT INTO methods (id, code, title, revision, status) VALUES ('M5', 'HPLC-1', 't', 5, 'Maybe')`)).rejects.toThrow(/methods_status_check/);
    for (const table of ['result_inputs', 'sst_runs']) {
      await expect(s.pool.query(`UPDATE ${table} SET id = id`)).resolves.toBeDefined(); // no rows: nothing to refuse
      await expect(s.pool.query(`TRUNCATE ${table}`)).rejects.toThrow(/not permitted/);
    }
  });
});

describe('the spec_parameters backfill', () => {
  it('gives the same rows and the same limits as the reader, for every stored shape', async () => {
    const s = await scratchDb('mc-shapes');
    await migrate(s.pool, { dir: DIR, upTo: lastBefore(), backup });
    const specs: Array<[string, unknown]> = [
      ['S-LEGACY', [{ name: 'HPLC Assay (% Label Claim)', min: 98.0, max: 102.0 }, { name: '4-Aminophenol (%)', min: 0.0, max: 0.005 }, { name: 'Water', max: 3 }, { name: 'pH', min: 5 }, { name: 'Odd' }]],
      ['S-R1', [
        { name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null, min: 98.0, max: 102.0 },
        { name: 'Impurity A', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.10, decimals: 2, text: null, min: null, max: 0.10 },
        { name: 'Dissolution', unit: '%', limit_kind: 'NLT', lower: 80, upper: null, decimals: 0, text: null, min: 80, max: null },
        { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White, round tablets', min: null, max: null },
        { name: 'E. coli', unit: '', limit_kind: 'PRESENCE', lower: null, upper: null, decimals: null, text: 'Absent in 1 g', min: null, max: null },
      ]],
      ['S-EMPTY', []],
      ['S-ODD', [{ name: 'Weird', limit_kind: 'NOPE', min: 1, max: 1.50 }, 'not an object', { unit: 7, limit_kind: 'RANGE', lower: '1', upper: 2.000, decimals: 1.5, text: '' }]],
      ['S-NOT-ARRAY', { name: 'not a list' }],
    ];
    for (const [id, parameters] of specs) {
      await s.pool.query(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ($1, $2, 1, '2026-01-01', 'Active', $3::jsonb)`,
        [id, `Material ${id}`, JSON.stringify(parameters)]);
    }
    const before = (await s.pool.query('SELECT json_agg(t ORDER BY id) AS j FROM specifications t')).rows[0].j;

    await migrate(s.pool, { dir: DIR, backup });

    const { expected, rows, digits } = await diff(s);
    expect(rows.length).toBe(13);
    expect(rows).toEqual(expected);
    expect(digits).toBe(0);
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM spec_parameters WHERE method_code IS NOT NULL OR formula_code IS NOT NULL OR replicates IS NOT NULL OR stage IS NOT NULL`)).rows[0].n).toBe(0);
    // The JSONB is kept as it was (for rollback, and because signatures cover it).
    expect((await s.pool.query('SELECT json_agg(t ORDER BY id) AS j FROM specifications t')).rows[0].j).toEqual(before);
  });

  it('on the real v0.1.0 installation: the row count and every limit match, and every signature verifies as before', async () => {
    const s = await scratchDb('mc-v010');
    await loadV010(s);
    await migrate(s.pool, { dir: DIR, upTo: lastBefore(), backup });
    const db = drizzle(s.pool, { schema }) as any;
    const { verifySignature } = await import('../../src/server/esign');
    const sigIds = (await s.pool.query('SELECT id FROM signatures ORDER BY id')).rows.map(r => r.id as string);
    const verdicts = async () => Object.fromEntries(await Promise.all(sigIds.map(async id => [id, (await verifySignature(db, id))?.status])));
    const verdictsBefore = await verdicts();
    const total = (await s.pool.query(`SELECT COALESCE(sum(jsonb_array_length(parameters)), 0)::int AS n FROM specifications WHERE jsonb_typeof(parameters) = 'array'`)).rows[0].n;
    expect(total).toBeGreaterThan(0);

    await migrate(s.pool, { dir: DIR, backup });

    const { expected, rows, digits } = await diff(s);
    expect(rows.length).toBe(total);
    expect(rows).toEqual(expected);
    expect(digits).toBe(0);
    expect(await verdicts()).toEqual(verdictsBefore);
  });
});

describe('spec_parameters stays derived from the JSONB', () => {
  it('is rebuilt when the JSONB is written, skips an identical row loaded by a restore, and refuses every other direct write', async () => {
    const s = await scratchDb('mc-derived');
    await migrate(s.pool, { dir: DIR, backup });
    await s.pool.query(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ('S-1', 'M', 1, '2026-01-01', 'Draft', $1::jsonb)`,
      [JSON.stringify([{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98.0, upper: 102.0, decimals: 1, text: null, method_code: 'HPLC-1' }])]);
    expect((await s.pool.query(`SELECT name, method_code FROM spec_parameters WHERE spec_id = 'S-1'`)).rows).toEqual([{ name: 'Assay', method_code: 'HPLC-1' }]);

    await s.pool.query(`UPDATE specifications SET parameters = $1::jsonb WHERE id = 'S-1'`,
      [JSON.stringify([{ name: 'Water', min: 0, max: 0.5 }, { name: 'pH', min: 5 }])]);
    expect((await s.pool.query(`SELECT position, name, limit_kind, lower::text, upper::text FROM spec_parameters WHERE spec_id = 'S-1' ORDER BY position`)).rows)
      .toEqual([{ position: 1, name: 'Water', limit_kind: 'RANGE', lower: '0', upper: '0.5' }, { position: 2, name: 'pH', limit_kind: 'NLT', lower: '5', upper: null }]);

    // A restore inserts the specification (which rebuilds its rows) and then the table's own rows: identical rows are skipped.
    const row = (await s.pool.query(`SELECT * FROM spec_parameters WHERE spec_id = 'S-1' AND position = 1`)).rows[0];
    const cols = Object.keys(row);
    await s.pool.query(`INSERT INTO spec_parameters (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(c => row[c]));
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM spec_parameters WHERE spec_id = 'S-1'`)).rows[0].n).toBe(2);
    await expect(s.pool.query(`INSERT INTO spec_parameters (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map(c => (c === 'upper' ? '9' : row[c])))).rejects.toThrow(/derived/);
    await expect(s.pool.query(`UPDATE spec_parameters SET upper = 9 WHERE spec_id = 'S-1'`)).rejects.toThrow(/derived/);
    await expect(s.pool.query(`DELETE FROM spec_parameters WHERE spec_id = 'S-1'`)).rejects.toThrow(/derived/);
    await expect(s.pool.query(`TRUNCATE spec_parameters`)).rejects.toThrow(/derived/);
  });
});
