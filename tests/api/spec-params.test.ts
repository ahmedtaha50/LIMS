/**
 * Roadmap M11 (r1-spec): the specification parameter schema and the request schemas of the specification routes. Pure: no database.
 *
 * A parameter is {name, unit, limit_kind, lower, upper, decimals, text}. The server refuses what a laboratory cannot test against:
 * a lower limit above the upper one, two parameters with one name, an empty name, a numeric limit with no declared decimals (the
 * rounding rule of the result evaluator is "to the limit's decimals"), a limit written with more decimals than it declares, a text
 * limit with no text. Server-controlled fields never appear in a request schema (AGENTS.md section 3).
 */
import { describe, expect, it } from 'vitest';
import * as v from '../../src/lib/validations/specifications';

const range = (over: Record<string, unknown> = {}) => ({ name: 'Assay (%)', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, ...over });
const issues = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) => (r.success ? [] : r.error!.issues.map(i => i.message));

describe('one parameter', () => {
  it('accepts each limit kind in its complete form', () => {
    for (const p of [
      range(),
      { name: 'Total impurities', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2 },
      { name: 'Assay minimum', unit: '%', limit_kind: 'NLT', lower: 98, upper: null, decimals: 1 },
      { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White to off-white powder' },
      { name: 'Pathogens', unit: '', limit_kind: 'PRESENCE', lower: null, upper: null, decimals: null, text: 'Absent in 10 g' },
    ]) expect(issues(v.specParameterSchema.safeParse(p)), JSON.stringify(p)).toEqual([]);
  });

  it('refuses a lower limit above the upper limit, and allows them to be equal', () => {
    expect(issues(v.specParameterSchema.safeParse(range({ lower: 102, upper: 98 })))).toEqual([expect.stringMatching(/lower limit .* above .*upper/i)]);
    expect(issues(v.specParameterSchema.safeParse(range({ lower: 100, upper: 100 })))).toEqual([]);
  });

  it('refuses an empty or blank name, and trims the name', () => {
    expect(issues(v.specParameterSchema.safeParse(range({ name: '' }))).join()).toMatch(/name is required/i);
    expect(issues(v.specParameterSchema.safeParse(range({ name: '   ' }))).join()).toMatch(/name is required/i);
    expect(v.specParameterSchema.parse(range({ name: '  Assay (%)  ' })).name).toBe('Assay (%)');
  });

  it('needs the limits its kind is made of and none that it is not', () => {
    expect(issues(v.specParameterSchema.safeParse(range({ lower: null }))).join()).toMatch(/lower limit is required/i);
    expect(issues(v.specParameterSchema.safeParse(range({ upper: null }))).join()).toMatch(/upper limit is required/i);
    expect(issues(v.specParameterSchema.safeParse({ ...range(), limit_kind: 'NMT', lower: 1 })).join()).toMatch(/lower limit .*not .*NMT/i);
    expect(issues(v.specParameterSchema.safeParse({ ...range(), limit_kind: 'NLT', upper: 1 })).join()).toMatch(/upper limit .*not .*NLT/i);
    expect(issues(v.specParameterSchema.safeParse({ name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: 1, upper: null, decimals: null, text: 'x' })).join()).toMatch(/TEXT .*no numeric/i);
  });

  it('needs decimals for a numeric limit, and the limit must not be written with more decimals than declared', () => {
    expect(issues(v.specParameterSchema.safeParse(range({ decimals: null }))).join()).toMatch(/decimals .*required/i);
    expect(issues(v.specParameterSchema.safeParse(range({ lower: 98.05, upper: 102, decimals: 1 }))).join()).toMatch(/98\.05 .*more decimals than/i);
    expect(issues(v.specParameterSchema.safeParse(range({ lower: 0, upper: 0.005, decimals: 2 }))).join()).toMatch(/0\.005 .*more decimals than/i);
    expect(issues(v.specParameterSchema.safeParse(range({ lower: 0, upper: 0.005, decimals: 3 })))).toEqual([]);
    expect(issues(v.specParameterSchema.safeParse(range({ decimals: 11 }))).length).toBeGreaterThan(0);
    expect(issues(v.specParameterSchema.safeParse(range({ decimals: 1.5 }))).length).toBeGreaterThan(0);
  });

  it('needs the acceptance text of a TEXT or PRESENCE limit', () => {
    const text = { name: 'Appearance', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null };
    expect(issues(v.specParameterSchema.safeParse({ ...text, text: null })).join()).toMatch(/acceptance text/i);
    expect(issues(v.specParameterSchema.safeParse({ ...text, limit_kind: 'PRESENCE', text: '  ' })).join()).toMatch(/acceptance text/i);
  });

  it('refuses numbers that are not numbers, unknown kinds, unknown keys and the old min/max shape', () => {
    for (const bad of [range({ lower: '98' }), range({ lower: NaN }), range({ upper: Infinity }), range({ limit_kind: 'AROUND' }), { ...range(), extra: 1 }, { name: 'Assay', min: 98, max: 102 }]) {
      expect(v.specParameterSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes a missing unit as none, and a missing text, lower, upper as null', () => {
    const p = v.specParameterSchema.parse({ name: 'pH', limit_kind: 'RANGE', lower: 5, upper: 7.5, decimals: 1 });
    expect(p).toEqual({ name: 'pH', unit: '', limit_kind: 'RANGE', lower: 5, upper: 7.5, decimals: 1, text: null });
  });
});

describe('a list of parameters', () => {
  it('refuses two parameters with one name, whatever the case or spacing', () => {
    const r = v.specParametersSchema.safeParse([range(), range({ name: '  assay  (%)' })]);
    expect(issues(r).join()).toMatch(/duplicate parameter name/i);
  });
  it('allows none (a draft is built up) and at most 100', () => {
    expect(v.specParametersSchema.safeParse([]).success).toBe(true);
    expect(v.specParametersSchema.safeParse(Array.from({ length: 101 }, (_, i) => range({ name: `P${i}` }))).success).toBe(false);
    expect(v.specParametersSchema.safeParse(Array.from({ length: 100 }, (_, i) => range({ name: `P${i}` }))).success).toBe(true);
  });
});

describe('the request schemas', () => {
  it('creating takes a material and an effective date, and no field the server controls', () => {
    expect(v.specificationSchema.safeParse({ material: ' Paracetamol ', effectiveDate: '2026-11-01' }).data).toEqual({ material: 'Paracetamol', effectiveDate: '2026-11-01' });
    expect(v.specificationSchema.safeParse({ material: 'M', effectiveDate: '2026-11-01', reviseFrom: 'SPEC-1' }).success).toBe(true);
    for (const key of ['version', 'revisionLabel', 'revision_label', 'status', 'id', 'createdBy', 'approvedBy', 'parameters', 'signatures']) {
      const r = v.specificationSchema.safeParse({ material: 'M', effectiveDate: '2026-11-01', [key]: 1 });
      expect(r.success, key).toBe(false);
      expect(issues(r).join(), key).toContain(key);
    }
  });
  it('an effective date is a real calendar date written YYYY-MM-DD', () => {
    for (const bad of ['', 'tomorrow', '2026-02-30', '2026-13-01', '01/02/2026', '2026-1-1', '2026-11-01T00:00:00Z']) {
      expect(v.specificationSchema.safeParse({ material: 'M', effectiveDate: bad }).success, bad).toBe(false);
    }
    expect(v.specificationSchema.safeParse({ material: 'M', effectiveDate: '2028-02-29' }).success).toBe(true);
    expect(v.specificationSchema.safeParse({ material: 'M', effectiveDate: '2027-02-29' }).success).toBe(false);
  });
  it('an empty material is refused', () => {
    expect(v.specificationSchema.safeParse({ material: '   ', effectiveDate: '2026-11-01' }).success).toBe(false);
  });

  it('editing takes parameters and/or an effective date and the version seen', () => {
    expect(v.specificationUpdateSchema.safeParse({ parameters: [range()], expectedVersion: 1 }).success).toBe(true);
    expect(v.specificationUpdateSchema.safeParse({ effectiveDate: '2026-12-01', expectedVersion: 1 }).success).toBe(true);
    expect(issues(v.specificationUpdateSchema.safeParse({ expectedVersion: 1 })).join()).toMatch(/nothing to change/i);
    expect(v.specificationUpdateSchema.safeParse({ parameters: [], expectedVersion: 0 }).success).toBe(false);
    expect(v.specificationUpdateSchema.safeParse({ parameters: [], expectedVersion: 1, status: 'Active' }).success).toBe(false);
    expect(v.specificationUpdateSchema.safeParse({ parameters: [], expectedVersion: 1, revisionLabel: 9 }).success).toBe(false);
  });

  it('approving takes the signature fields, the version seen and an optional exception; the meaning is the server\'s', () => {
    expect(v.specificationApproveSchema.safeParse({ password: 'x', expectedVersion: 3 }).success).toBe(true);
    expect(v.specificationApproveSchema.safeParse({ password: 'x', expectedVersion: 3, totpCode: '123456', reason: 'ok', exceptionReason: 'Samples SMP-1 finish on the old limits' }).success).toBe(true);
    expect(v.specificationApproveSchema.safeParse({ password: 'x', expectedVersion: 3, meaning: 'Approval' }).success).toBe(false);
    expect(v.specificationApproveSchema.safeParse({ password: 'x', expectedVersion: 3, meaningCode: 'APPROVAL' }).success).toBe(false);
    expect(v.specificationApproveSchema.safeParse({ password: 'x' }).success).toBe(false);
    expect(v.specificationApproveSchema.safeParse({ password: 'x', expectedVersion: 3, exceptionReason: 'short' }).success).toBe(false);
  });
});

describe('legacy parameters, as v0.1.0 stored them', () => {
  it('are read as limits of the new kinds, with no decimals (nobody declared them)', () => {
    const out = v.normalizeParameters([
      { name: 'Assay', min: 98, max: 102 },
      { name: 'Impurity', min: 0, max: 0.005, unit: '%' },
      { name: 'Total', min: null, max: 0.5 },
      { name: 'Minimum', min: 95, max: null },
      { name: 'No limit', min: null, max: null },
    ]);
    expect(out.map(p => [p.name, p.limit_kind, p.lower, p.upper, p.decimals, p.unit])).toEqual([
      ['Assay', 'RANGE', 98, 102, null, ''],
      ['Impurity', 'RANGE', 0, 0.005, null, '%'],
      ['Total', 'NMT', null, 0.5, null, ''],
      ['Minimum', 'NLT', 95, null, null, ''],
      ['No limit', 'TEXT', null, null, null, ''],
    ]);
  });
  it('a stored parameter of the new shape is read back as written, without the old-reader copies', () => {
    const stored = v.toStoredParameters(v.specParametersSchema.parse([range()]));
    expect(stored[0]).toMatchObject({ limit_kind: 'RANGE', lower: 98, upper: 102, min: 98, max: 102 });
    expect(v.normalizeParameters(stored)).toEqual(v.specParametersSchema.parse([range()]));
  });
  it('the copies for readers that know only min and max follow the kind', () => {
    const stored = v.toStoredParameters(v.specParametersSchema.parse([
      range(),
      { name: 'Total', unit: '%', limit_kind: 'NMT', upper: 0.5, decimals: 1 },
      { name: 'Minimum', unit: '%', limit_kind: 'NLT', lower: 95, decimals: 0 },
      { name: 'Appearance', limit_kind: 'TEXT', text: 'White powder' },
    ]));
    expect(stored.map(p => [p.min, p.max])).toEqual([[98, 102], [null, 0.5], [95, null], [null, null]]);
  });
});
