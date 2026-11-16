import { describe, expect, it } from 'vitest';
import { Design } from '../../server/mbr/design.js';
import { evaluate, FormulaError, parseFormula, refsOf } from '../../server/mbr/formula.js';

describe('formulas of calculation steps', () => {
  it('parses arithmetic with precedence, unary minus and references', () => {
    const v = new Map([['granulation.water', 12.5], ['granulation.api', 500], ['loss', 2]]);
    expect(evaluate(parseFormula('granulation.water * 2 + granulation.api / 4'), v)).toBe(150);
    expect(evaluate(parseFormula('-(loss - 5) * 3'), v)).toBe(9);
    expect([...refsOf(parseFormula('a.b + c * (a.b - 1)'))].sort()).toEqual(['a.b', 'c']);
  });
  it('refuses anything that is not arithmetic, with the reason', () => {
    for (const bad of ['process.exit()', 'a; b', 'x = 1', '1 +', '(1 + 2', '2 ** 3', 'Math.max(1)', '"text"', '', 'a[0]']) {
      expect(() => parseFormula(bad), bad).toThrow(FormulaError);
    }
  });
  it('a division by zero or a missing value is an error, never Infinity or NaN', () => {
    expect(() => evaluate(parseFormula('1 / (a - a)'), new Map([['a', 3]]))).toThrow(/division by zero/);
    expect(() => evaluate(parseFormula('a + 1'), new Map())).toThrow(/a has no value yet/);
  });
  it('agrees with JavaScript arithmetic on 2,000 random formulas (seeded)', () => {
    let s = 20261116;
    const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const num = () => String(Math.round(r() * 1000) / 10 + 0.5);
    const gen = (d: number): string => {
      if (d === 0 || r() < 0.3) return r() < 0.5 ? num() : 'x';
      const op = ['+', '-', '*', '/'][Math.floor(r() * 4)];
      const e = `${gen(d - 1)} ${op} ${gen(d - 1)}`;
      return r() < 0.3 ? `(${e})` : r() < 0.1 ? `-(${e})` : e;
    };
    for (let i = 0; i < 2000; i++) {
      const f = gen(4), x = Math.round(r() * 100) / 10 + 1;
      const want = Function('x', `return ${f};`)(x) as number;      // the test's own oracle, on formulas it generated itself
      if (!Number.isFinite(want)) continue;
      expect(evaluate(parseFormula(f), new Map([['x', x]])), f).toBeCloseTo(want, 9);
    }
  });
});

const ok = {
  batchSize: { value: 120, unit: 'kg' },
  phases: [{ key: 'granulation', label: 'Granulation', steps: [
    { key: 'clearance', label: 'Line clearance', type: 'verified', text: 'Room and equipment free of the previous product' },
    { key: 'mixer', label: 'Mixer', type: 'equipment', objectKind: 'equipment' },
    { key: 'api', label: 'Paracetamol', type: 'material', material: 'RM-0001', quantity: 60, unit: 'kg', tolerancePct: 0.5 },
    { key: 'water', label: 'Purified water added', type: 'data', unit: 'L', min: 10, max: 14 },
    { key: 'ratio', label: 'Water per kg of API', type: 'calculation', formula: 'water / 60', unit: 'L/kg', min: 0.15, max: 0.25 },
    { key: 'ipc', label: 'Moisture sample', type: 'sample', test: 'LOD', quantity: 10, unit: 'g' },
  ] }],
};

describe('MBR design validation (E08#1, E08#2)', () => {
  it('a recipe with every step type is accepted', () => {
    expect(() => Design.parse(ok)).not.toThrow();
  });
  it('a calculation that refers to a missing step is refused', () => {
    const bad = structuredClone(ok); (bad.phases[0]!.steps[4] as { formula: string }).formula = 'water_volume / 60';
    expect(() => Design.parse(bad)).toThrow(/uses water_volume, which is not a data or calculation step before this one/);
  });
  it('a calculation placed before the value it uses is refused (the order of steps is checked)', () => {
    const bad = structuredClone(ok); const st = bad.phases[0]!.steps; [st[3], st[4]] = [st[4]!, st[3]!];
    expect(() => Design.parse(bad)).toThrow(/uses water, which is not a data or calculation step before this one/);
  });
  it('limits above each other, limits without a unit, duplicate keys and unknown step types are refused', () => {
    const a = structuredClone(ok); Object.assign(a.phases[0]!.steps[3]!, { min: 20, max: 10 });
    expect(() => Design.parse(a)).toThrow(/lower limit is above the upper limit/);
    const b = structuredClone(ok); Object.assign(b.phases[0]!.steps[3]!, { unit: '' });
    expect(() => Design.parse(b)).toThrow(/needs a unit/);
    const c = structuredClone(ok); c.phases[0]!.steps[1]!.key = 'clearance';
    expect(() => Design.parse(c)).toThrow(/two steps of granulation are called clearance/);
    const d = structuredClone(ok); (d.phases[0]!.steps[0] as { type: string }).type = 'dance';
    expect(() => Design.parse(d)).toThrow();
  });
});
