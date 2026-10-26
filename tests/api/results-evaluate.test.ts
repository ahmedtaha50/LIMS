/**
 * Roadmap M10 (r1-results-oos): the result evaluator and the strict numeric parser. Pure functions, no database.
 *
 *   src/lib/numeric.ts            what counts as a number a person typed (no thousands separators, no exponent, no garbage;
 *                                 Arabic-Indic digits are read as the digits they are), decimal-string comparison and USP 7.20 rounding
 *   src/server/lib/evaluate.ts    a result against its limit (RANGE, NMT, NLT, TEXT, PRESENCE), rounded to the limit's decimals
 */
import { describe, expect, it } from 'vitest';
import { compareDecimal, parseDecimal, roundHalfUp } from '../../src/lib/numeric';
import { evaluateResult, limitOfResult } from '../../src/server/lib/evaluate';

const nlt98 = { limitKind: 'NLT' as const, lower: '98.0', upper: null, decimals: 1, text: null };
const nmt05 = { limitKind: 'NMT' as const, lower: null, upper: '0.5', decimals: 1, text: null };
const range = { limitKind: 'RANGE' as const, lower: '98.0', upper: '102.0', decimals: 1, text: null };

describe('parseDecimal', () => {
  it('accepts plain decimals and keeps them as written', () => {
    expect(parseDecimal('97.96')).toEqual({ ok: true, value: '97.96' });
    expect(parseDecimal(' 100 ')).toEqual({ ok: true, value: '100' });
    expect(parseDecimal('-0.50')).toEqual({ ok: true, value: '-0.50' });
    expect(parseDecimal('+3.0')).toEqual({ ok: true, value: '3.0' });
  });

  it('refuses thousands separators, exponents, half-written numbers and garbage', () => {
    for (const bad of ['1,234.5', '1 234.5', '1e3', '.5', '5.', '1.2.3', 'garbage', '', '  ', 'NaN', 'Infinity', '0x10', '12abc', '--1', '٬1']) {
      expect(parseDecimal(bad).ok, bad).toBe(false);
    }
  });

  it('reads Arabic-Indic and Extended Arabic-Indic digits and the Arabic decimal separator', () => {
    expect(parseDecimal('٩٧٫٩٦')).toEqual({ ok: true, value: '97.96' });
    expect(parseDecimal('۹۸.۰')).toEqual({ ok: true, value: '98.0' });
  });
});

describe('roundHalfUp (USP general notices 7.20) and compareDecimal', () => {
  it('rounds on the one digit after the last place of the limit', () => {
    expect(roundHalfUp('97.96', 1)).toBe('98.0');
    expect(roundHalfUp('97.94', 1)).toBe('97.9');
    expect(roundHalfUp('97.95', 1)).toBe('98.0');
    expect(roundHalfUp('0.0049', 3)).toBe('0.005');
    expect(roundHalfUp('99.999', 0)).toBe('100');
    expect(roundHalfUp('-1.25', 1)).toBe('-1.3');
    expect(roundHalfUp('5', 2)).toBe('5.00');
  });

  it('compares decimal strings exactly (no binary floating point)', () => {
    expect(compareDecimal('0.005', '0.0050')).toBe(0);
    expect(compareDecimal('0.1', '0.10000001')).toBe(-1);
    expect(compareDecimal('-2', '-10')).toBe(1);
    expect(compareDecimal('98.0', '97.9')).toBe(1);
  });
});

describe('evaluateResult', () => {
  it('97.96 against NLT 98.0 passes and 97.94 fails (rounded to the declared decimals first)', () => {
    expect(evaluateResult('97.96', nlt98)).toMatchObject({ ok: true, isOos: false, reportable: '98.0' });
    expect(evaluateResult('97.94', nlt98)).toMatchObject({ ok: true, isOos: true, reportable: '97.9' });
  });

  it('judges RANGE and NMT limits at both edges', () => {
    expect(evaluateResult('102.04', range)).toMatchObject({ ok: true, isOos: false });
    expect(evaluateResult('102.05', range)).toMatchObject({ ok: true, isOos: true });
    expect(evaluateResult('0.54', nmt05)).toMatchObject({ ok: true, isOos: false });
    expect(evaluateResult('0.55', nmt05)).toMatchObject({ ok: true, isOos: true });
  });

  it('accepts a declared censored result (<x, ND, <LOQ) where the limit is an upper limit, and judges <x by its bound', () => {
    expect(evaluateResult('<0.05', nmt05)).toMatchObject({ ok: true, isOos: false, value: '<0.05' });
    expect(evaluateResult('ND', nmt05)).toMatchObject({ ok: true, isOos: false, value: 'ND' });
    expect(evaluateResult('<loq', nmt05)).toMatchObject({ ok: true, isOos: false, value: '<LOQ' });
    // a bound above the limit does not show the result is within it: fail closed
    expect(evaluateResult('<0.6', nmt05)).toMatchObject({ ok: true, isOos: true });
    // a lower limit cannot be shown to be met by "less than"
    expect(evaluateResult('<0.05', nlt98).ok).toBe(false);
    expect(evaluateResult('ND', range).ok).toBe(false);
  });

  it('refuses garbage and thousands separators with a reason', () => {
    for (const bad of ['garbage', '1,234.5', '']) {
      const r = evaluateResult(bad, range);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/number/i);
    }
  });

  it('judges TEXT and PRESENCE limits by a fixed verdict vocabulary', () => {
    const text = { limitKind: 'TEXT' as const, lower: null, upper: null, decimals: null, text: 'White powder' };
    const presence = { limitKind: 'PRESENCE' as const, lower: null, upper: null, decimals: null, text: 'Absent in 10 g' };
    expect(evaluateResult('complies', text)).toMatchObject({ ok: true, isOos: false, value: 'Complies' });
    expect(evaluateResult('Does not comply', text)).toMatchObject({ ok: true, isOos: true });
    expect(evaluateResult('Absent', presence)).toMatchObject({ ok: true, isOos: false });
    expect(evaluateResult('present', presence)).toMatchObject({ ok: true, isOos: true, value: 'Present' });
    expect(evaluateResult('looks fine', text).ok).toBe(false);
  });

  it('a limit without declared decimals (written by v0.1.0) is compared without rounding', () => {
    const legacy = limitOfResult({ limitKind: null, lowerText: null, upperText: null, decimals: null, acceptanceText: null, specMin: 98, specMax: 102 });
    expect(legacy).toMatchObject({ limitKind: 'RANGE', lower: '98', upper: '102', decimals: null });
    expect(evaluateResult('97.96', legacy)).toMatchObject({ ok: true, isOos: true });
    expect(evaluateResult('102', legacy)).toMatchObject({ ok: true, isOos: false });
  });
});
