/**
 * Roadmap M39 (r3-spc), src/lib/spc.ts against hand-computed fixtures (exact rational arithmetic, independent of this code).
 * The t quantiles are published table values.
 */
import { describe, expect, it } from 'vitest';
import { capability, evaluateRules, fixedLimits, imrLimits, ols, shelfLife, tQuantile, zScore, boundHalfWidth, predict } from '../../../src/lib/spc';

// 30 points: 100 + 0.1 * ((7 i mod 11) - 5), i = 1..30.
const SERIES = [100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6, 100.3, 99.9, 99.5, 100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6, 100.3, 99.9, 99.5, 100.2, 99.8, 100.5, 100.1, 99.7, 100.4, 100.0, 99.6];

describe('individuals chart limits', () => {
  it('a 30-point series gives the hand-calculated centre line and limits (1e-6)', () => {
    const l = imrLimits(SERIES);
    expect(l.n).toBe(30);
    expect(Math.abs(l.cl - 100.01)).toBeLessThan(1e-6);
    expect(Math.abs(l.mrBar! - 0.503448275862069)).toBeLessThan(1e-6);
    expect(Math.abs(l.ucl - 101.3491724137931)).toBeLessThan(1e-6);
    expect(Math.abs(l.lcl - 98.6708275862069)).toBeLessThan(1e-6);
    expect(Math.abs(l.sigma - 0.44639080459770114)).toBeLessThan(1e-6);
    expect(Math.abs(l.mrUcl! - 3.267 * 0.503448275862069)).toBeLessThan(1e-6);
  });
  it('refuses fewer than 2 values', () => { expect(() => imrLimits([1])).toThrow(); });
});

describe('capability', () => {
  it('Cpk and Ppk match the hand calculation for LSL 98 / USL 102', () => {
    const r = capability(SERIES, 98, 102);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.value.cpk! - 1.4862301369862974)).toBeLessThan(1e-6);
    expect(Math.abs(r.value.cp! - 1.4936986301369861)).toBeLessThan(1e-6);
    expect(Math.abs(r.value.ppk! - 2.0808498940860036)).toBeLessThan(1e-6);
  });
  it('is reported only with n >= 20 and both limits', () => {
    expect(capability(SERIES.slice(0, 19), 98, 102)).toMatchObject({ ok: false, reason: 'TOO_FEW_POINTS' });
    expect(capability(SERIES, 98, null)).toMatchObject({ ok: false, reason: 'NEEDS_BOTH_LIMITS' });
    expect(capability(SERIES, null, 102)).toMatchObject({ ok: false, reason: 'NEEDS_BOTH_LIMITS' });
    expect(capability(SERIES.slice(0, 20), 98, 102).ok).toBe(true);
    expect(capability(new Array(20).fill(100), 98, 102)).toMatchObject({ ok: false, reason: 'NO_VARIATION' });
    expect(capability(SERIES, 102, 98)).toMatchObject({ ok: false, reason: 'BAD_LIMITS' });
  });
});

const L = fixedLimits(0, 1); // centre 0, sigma 1: a value is its own z
const rules = (v: number[], set: 'nelson' | 'westgard' = 'nelson') => evaluateRules(v, L, set).map(x => `${x.index}:${x.rule}:${x.side}`);

describe('Nelson / Western Electric rules', () => {
  it('N1: a point at 3.2 sigma is flagged, one at 2.9 is not', () => {
    expect(rules([0.1, 3.2])).toEqual(['1:N1:above']);
    expect(rules([0.1, -3.2])).toEqual(['1:N1:below']);
    expect(rules([0.1, 2.9])).toEqual([]);
    expect(rules([3])).toEqual([]); // exactly on the boundary is not beyond it
  });
  it('N1 uses the individuals-chart sigma: a point 3.2 sigma above the CL of a 30-point baseline is flagged', () => {
    const l = imrLimits(SERIES);
    const x = l.cl + 3.2 * l.sigma;
    expect(evaluateRules([...SERIES, x], l).filter(v => v.index === 30).map(v => v.rule)).toContain('N1');
    expect(x).toBeGreaterThan(l.ucl);
  });
  it('N2: 2 of 3 beyond 2 sigma on the same side', () => {
    expect(rules([2.1, 0, 2.2])).toEqual(['2:N2:above']);
    expect(rules([2.1, 0, 0, 2.2])).toEqual([]);
    expect(rules([2.1, 0, -2.2])).toEqual([]);
  });
  it('N3: 4 of 5 beyond 1 sigma on the same side', () => {
    expect(rules([1.1, 0, 1.2, 1.3, 1.4])).toEqual(['4:N3:above']);
    expect(rules([-1.1, -1.2, 0, -1.3, -1.4])).toEqual(['4:N3:below']);
    expect(rules([1.1, 0, 1.2, 0, 1.4])).toEqual([]);
  });
  it('N4: 8 in a row on one side, reported from the 8th point on', () => {
    expect(rules([0.1, 0.2, 0.1, 0.3, 0.1, 0.2, 0.1])).toEqual([]);
    expect(rules([0.1, 0.2, 0.1, 0.3, 0.1, 0.2, 0.1, 0.4, 0.2])).toEqual(['7:N4:above', '8:N4:above']);
    expect(rules([0.1, 0.2, 0.1, 0.3, 0.1, 0.2, -0.1, 0.4, 0.2])).toEqual([]);
  });
  it('N5: 6 in a row steadily rising or falling (an equal step breaks it)', () => {
    expect(rules([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])).toEqual(['5:N5:rising']);
    expect(rules([0.6, 0.5, 0.4, 0.3, 0.2, 0.1])).toEqual(['5:N5:falling']);
    expect(rules([0.1, 0.2, 0.3, 0.4, 0.5])).toEqual([]);
    expect(rules([0.1, 0.2, 0.3, 0.3, 0.5, 0.6])).toEqual([]);
  });
  it('no zones and no violations when sigma is 0', () => {
    expect(evaluateRules([5, 5, 5, 9], fixedLimits(5, 0), 'nelson')).toEqual([]);
    expect(zScore(9, fixedLimits(5, 0))).toBeNull();
    expect(zScore(7, fixedLimits(5, 2))).toBe(1);
  });
});

describe('Westgard rules', () => {
  it('1-2s is a warning, 1-3s a violation (and not also a warning)', () => {
    const w = evaluateRules([0, 2.5, 0, 3.5], L, 'westgard');
    expect(w.map(x => [x.index, x.rule, x.severity])).toEqual([[1, '1-2s', 'warning'], [3, '1-3s', 'violation']]);
  });
  it('2-2s: two in a row beyond 2 s on the same side', () => {
    expect(rules([2.1, 2.2], 'westgard')).toEqual(['0:1-2s:above', '1:1-2s:above', '1:2-2s:above']);
    expect(rules([2.1, -2.2], 'westgard')).toContain('1:R-4s:both');
    expect(rules([2.1, -2.2], 'westgard')).not.toContain('1:2-2s:above');
  });
  it('R-4s: consecutive values more than 4 s apart across the mean', () => {
    expect(rules([-2.1, 2.1], 'westgard')).toContain('1:R-4s:both');
    expect(rules([-1.9, 2.1], 'westgard')).not.toContain('1:R-4s:both');
  });
  it('4-1s and 10x', () => {
    expect(rules([1.1, 1.2, 1.3, 1.4], 'westgard')).toEqual(['3:4-1s:above']);
    expect(rules([-0.1, -0.2, -0.1, -0.3, -0.1, -0.2, -0.1, -0.4, -0.2, -0.1], 'westgard')).toEqual(['9:10x:below']);
    expect(rules([-0.1, -0.2, -0.1, -0.3, -0.1, -0.2, -0.1, -0.4, -0.2], 'westgard')).toEqual([]);
  });
});

describe('Student t quantiles (published table values)', () => {
  const table: Array<[number, number, number]> = [
    [0.95, 1, 6.313751515], [0.95, 2, 2.919985581], [0.95, 3, 2.353363435], [0.95, 4, 2.131846786], [0.95, 5, 2.015048373],
    [0.95, 10, 1.812461123], [0.95, 30, 1.697260887], [0.975, 10, 2.228138852], [0.975, 30, 2.042272456], [0.995, 5, 4.032142984],
  ];
  it.each(table)('p=%s df=%s', (p, df, expected) => { expect(Math.abs(tQuantile(p, df) - expected)).toBeLessThan(1e-6); });
});

describe('regression and shelf life (one batch, assay falling from 100.1)', () => {
  const x = [0, 3, 6, 9, 12];
  const y = [100.1, 99.6, 98.7, 98.4, 97.5];
  it('OLS matches the exact calculation', () => {
    const f = ols(x, y);
    expect(Math.abs(f.slope - -0.21333333333333335)).toBeLessThan(1e-9);
    expect(Math.abs(f.intercept - 100.14)).toBeLessThan(1e-9);
    expect(Math.abs(f.s - 0.1591644851508443)).toBeLessThan(1e-9);
    expect(Math.abs(f.r2 - 0.9817833173537871)).toBeLessThan(1e-9);
    expect(f.df).toBe(3);
  });
  it('the one-sided 95 % bounds match the reference to 3 decimals', () => {
    const f = ols(x, y);
    const lowCi = (t: number) => predict(f, t) - boundHalfWidth(f, t, 'confidence');
    const lowPi = (t: number) => predict(f, t) - boundHalfWidth(f, t, 'prediction');
    expect(lowCi(12)).toBeCloseTo(97.28985786974421, 3);
    expect(lowCi(18)).toBeCloseTo(95.79745908898072, 3);
    expect(lowCi(24)).toBeCloseTo(94.28982498462402, 3);
    expect(lowPi(12)).toBeCloseTo(97.10619988532613, 3);
    expect(lowPi(18)).toBeCloseTo(95.67322136270953, 3);
  });
  it('the shelf life where the lower confidence bound meets LSL 95 is 21.177 months; the prediction bound gives 20.754', () => {
    const r = shelfLife(x, y, { lsl: 95 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.estimateMonths!).toBeCloseTo(21.17711120504538, 3);
    expect(r.value.predictionMonths!).toBeCloseTo(20.753752007436812, 3);
    expect(r.value.limiting).toBe('lower');
    expect(r.value.extrapolationCapMonths).toBe(24); // min(2 x 12, 12 + 12)
    expect(r.value.supportedMonths).toBe(21); // rounded down
    expect(r.value.cappedByExtrapolation).toBe(false);
  });
  it('the extrapolation cap limits the supported figure', () => {
    const r = shelfLife(x, y, { lsl: 90 });
    expect(r.ok && r.value.estimateMonths!).toBeGreaterThan(24);
    expect(r.ok && r.value.supportedMonths).toBe(24);
    expect(r.ok && r.value.cappedByExtrapolation).toBe(true);
  });
  it('an increasing attribute is bound from above (USL)', () => {
    const r = shelfLife(x, y.map(v => 100 - v), { usl: 5 });
    expect(r.ok && r.value.limiting).toBe('upper');
    expect(r.ok && r.value.estimateMonths!).toBeCloseTo(21.17711120504538, 2);
  });
  it('refuses what it cannot estimate, and says why', () => {
    expect(shelfLife([0, 3, 6], [1, 2, 3], { lsl: 0 })).toMatchObject({ ok: false, reason: 'TOO_FEW_POINTS' });
    expect(shelfLife([0, 0, 6, 6], [1, 2, 3, 4], { lsl: 0 })).toMatchObject({ ok: false, reason: 'NO_TIME_SPREAD' });
    expect(shelfLife(x, y, {})).toMatchObject({ ok: false, reason: 'NO_LIMITS' });
  });
  it('a result already below the limit at time zero is a zero shelf life', () => {
    const r = shelfLife(x, y, { lsl: 100.5 });
    expect(r.ok && r.value.estimateMonths).toBe(0);
    expect(r.ok && r.value.failsAtStart).toBe(true);
    expect(r.ok && r.value.supportedMonths).toBe(0);
  });
});
