/**
 * Roadmap M18 (r2-methods-calc): the seeded formulas (scripts/dev/seed/seeds/methods.ts) are the "validated seeds" of the roadmap.
 * Each one must pass the checks the server applies before a formula can be approved: the expression compiles, it uses exactly its
 * declared inputs, the test case inputs match the declaration, and every test case reproduces its hand-calculated value. Each
 * method's SST criteria name a seeded formula. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { SEED_FORMULAS, SEED_METHODS } from '../../../scripts/dev/seed/seeds/methods';
import { calculate, compileFormula } from '../../../src/server/lib/calc';
import { formulaCreateSchema, methodCreateSchema } from '../../../src/lib/validations/methods';

describe('seeded formulas', () => {
  it.each(SEED_FORMULAS.map(f => [f.code, f] as const))('%s is a valid formula whose test cases all reproduce their values', (_code, f) => {
    const { id: _id, ...body } = f;
    expect(formulaCreateSchema.safeParse(body).success).toBe(true);
    const compiled = compileFormula(f.expression);
    expect([...compiled.variables].sort()).toEqual(f.inputs.map(i => i.name).sort());
    expect(f.testCases.length).toBeGreaterThan(0);
    for (const c of f.testCases) {
      for (const i of f.inputs) expect(Array.isArray(c.inputs[i.name]), `${c.name}: ${i.name}`).toBe(i.replicates);
      expect(calculate(compiled, c.inputs, c.decimals).reported, c.name).toBe(c.expected);
    }
  });

  it('covers the HPLC assay, %RSD, dissolution, Karl Fischer and the USP <905> acceptance value', () => {
    expect(SEED_FORMULAS.map(f => f.code)).toEqual(['ASSAY-HPLC-EXT', 'SST-RSD', 'DISS-UNIT', 'DISS-Q-S1', 'KF-WATER', 'USP905-AV']);
  });
});

describe('seeded methods', () => {
  it('are valid, and their system suitability criteria name seeded formulas', () => {
    const codes = new Set(SEED_FORMULAS.map(f => f.code));
    for (const m of SEED_METHODS) {
      const { id: _id, ...body } = m;
      expect(methodCreateSchema.safeParse(body).success, m.code).toBe(true);
      for (const c of m.sstCriteria) expect(codes.has(c.formulaCode), `${m.code}: ${c.formulaCode}`).toBe(true);
    }
  });
});
