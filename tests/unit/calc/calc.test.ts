/**
 * Roadmap M18 (r2-methods-calc): the calculation engine, src/server/lib/calc.ts. Pure: no database, no clock.
 *
 * The expected values are hand calculations made outside the engine: each was computed with Python's decimal module at 50
 * significant digits (the oracle script is quoted in docs/changes/r2-methods-calc.md) and rounded half-up (USP General Notices
 * 7.20) to the decimals shown. `raw` is the oracle's unrounded value; the engine's raw result must agree with it to 12 significant
 * digits, and its reported value must be exactly `reported`.
 *
 * The parser is hand-written (no eval, no Function, no property access): only numbers, declared input names, the operators and an
 * allow-list of functions are accepted.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_FUNCTIONS, calculate, compileFormula, evaluateFormula, FormulaError, toDecimalString } from '../../../src/server/lib/calc';

type Inputs = Record<string, number | number[]>;
interface Example { name: string; expression: string; inputs: Inputs; decimals: number; raw: string; reported: string }

const ASSAY = '(mean(A_spl) / mean(A_std)) * (W_std * P_std / 100 / V_std) * (V_spl / W_spl) * Avg_wt / LC * 100';
const AV = 'abs(max(98.5, min(101.5, mean(x))) - mean(x)) + if(count(x) == 10, 2.4, 2.0) * sd(x)';
const DISS_UNIT = '(A_u / mean(A_std)) * (W_std * P_std / 100 / V_std) * V_med / LC * 100';
const X30 = Array.from({ length: 30 }, (_, i) => Number((99.0 + 0.1 * i).toFixed(1)));

const EXAMPLES: Example[] = [
  { name: 'precedence: * before +', expression: 'a + b * c', inputs: { a: 2, b: 3, c: 4 }, decimals: 0, raw: '14', reported: '14' },
  { name: 'parentheses', expression: '(a + b) * c', inputs: { a: 2, b: 3, c: 4 }, decimals: 0, raw: '20', reported: '20' },
  { name: 'power is right-associative', expression: '2 ^ 3 ^ 2', inputs: {}, decimals: 0, raw: '512', reported: '512' },
  { name: 'unary minus binds looser than power', expression: '-x ^ 2', inputs: { x: 3 }, decimals: 0, raw: '-9', reported: '-9' },
  { name: 'mean of replicates', expression: 'mean(x)', inputs: { x: [99.1, 99.5, 100.2] }, decimals: 1, raw: '99.6', reported: '99.6' },
  { name: 'sample standard deviation (n-1)', expression: 'sd(x)', inputs: { x: [2, 4, 4, 4, 5, 5, 7, 9] }, decimals: 3, raw: '2.13808993529940', reported: '2.138' },
  { name: '%RSD of six injections', expression: 'rsd(x)', inputs: { x: [1000, 1010, 990, 1005, 995, 1000] }, decimals: 2, raw: '0.707106781186548', reported: '0.71' },
  { name: '%RSD that fails NMT 2.0 (SST)', expression: 'rsd(x)', inputs: { x: [103, 97, 103, 97, 100, 100] }, decimals: 1, raw: '2.68328157299975', reported: '2.7' },
  { name: '%RSD that passes (SST)', expression: 'rsd(x)', inputs: { x: [100.2, 100.4, 99.9, 100.1, 100.3, 100.0] }, decimals: 1, raw: '0.186802665340686', reported: '0.2' },
  {
    name: 'HPLC assay, % of label claim (external standard)', expression: ASSAY, decimals: 1, raw: '100.222911478454', reported: '100.2',
    inputs: { A_spl: [1523456, 1525012], A_std: [1519870, 1521034, 1520455, 1518999, 1522001], W_std: 50.12, P_std: 99.8, V_std: 50, W_spl: 625.4, V_spl: 500, Avg_wt: 625.0, LC: 500 },
  },
  { name: 'Karl Fischer water content, % w/w', expression: 'V * F / W * 100', inputs: { V: 1.25, F: 5.02, W: 250.3 }, decimals: 2, raw: '2.50699161006792', reported: '2.51' },
  {
    name: 'dissolution, % dissolved of one unit', expression: DISS_UNIT, decimals: 1, raw: '98.5249523382267', reported: '98.5',
    inputs: { A_u: 487650, A_std: [493210, 492876, 494010], W_std: 27.8, P_std: 99.6, V_std: 50, V_med: 900, LC: 500 },
  },
  { name: 'dissolution Q, stage S1: lowest of six units', expression: 'min(units)', inputs: { units: [92.4, 95.1, 90.8, 93.3, 96.0, 91.7] }, decimals: 0, raw: '90.8', reported: '91' },
  {
    name: 'USP <905> acceptance value, n=10, mean within 98.5-101.5 (M = mean)', expression: AV, decimals: 1, raw: '2.22566843891897', reported: '2.2',
    inputs: { x: [99.2, 100.4, 98.7, 101.1, 99.8, 100.9, 98.9, 100.2, 99.5, 101.3] },
  },
  {
    name: 'USP <905> acceptance value, n=10, mean below 98.5 (M = 98.5)', expression: AV, decimals: 1, raw: '3.50751037957112', reported: '3.5',
    inputs: { x: [96.2, 97.8, 95.9, 98.1, 97.0, 96.6, 97.4, 98.4, 96.1, 97.5] },
  },
  {
    name: 'USP <905> acceptance value, n=10, mean above 101.5 (M = 101.5)', expression: AV, decimals: 1, raw: '2.33095313625244', reported: '2.3',
    inputs: { x: [102.1, 103.0, 101.8, 102.6, 103.4, 101.9, 102.2, 102.8, 103.1, 102.5] },
  },
  { name: 'USP <905> acceptance value, n=30 (k = 2.0)', expression: AV, inputs: { x: X30 }, decimals: 1, raw: '1.76068168616590', reported: '1.8' },
  { name: 'sqrt and pow', expression: 'sqrt(pow(a, 2) + pow(b, 2))', inputs: { a: 3, b: 4 }, decimals: 0, raw: '5', reported: '5' },
  { name: 'ln and exp', expression: 'exp(ln(a) + ln(b))', inputs: { a: 2, b: 8 }, decimals: 0, raw: '16', reported: '16' },
  { name: 'log10', expression: 'log10(a)', inputs: { a: 1000 }, decimals: 0, raw: '3', reported: '3' },
  // 1.005 is 1.00499999999999989... in binary: the raw value is written to 15 significant digits before the one rounding, so it rounds up.
  { name: 'rounding is half-up on the decimal value, once', expression: 'a / b', inputs: { a: 1.005, b: 1 }, decimals: 2, raw: '1.005', reported: '1.01' },
  { name: 'half-up rounds away from zero for a negative value', expression: 'a - b', inputs: { a: 1, b: 1.125 }, decimals: 2, raw: '-0.125', reported: '-0.13' },
  { name: 'sum and count', expression: 'sum(x) / count(x)', inputs: { x: [99.1, 99.5, 100.2] }, decimals: 1, raw: '99.6', reported: '99.6' },
  { name: 'spike recovery, %', expression: '(spiked - unspiked) / added * 100', inputs: { spiked: 15.62, unspiked: 5.48, added: 10.0 }, decimals: 1, raw: '101.4', reported: '101.4' },
  { name: 'relative difference of duplicates, %', expression: 'abs(a - b) / b * 100', inputs: { a: 101.7, b: 99.85 }, decimals: 2, raw: '1.85277916875313', reported: '1.85' },
  { name: 'comparisons and logic inside if', expression: 'if(a > b && b > 0 || a == 0, a - b, 0)', inputs: { a: 5, b: 2 }, decimals: 0, raw: '3', reported: '3' },
];

/** Agreement to 12 significant digits with the oracle's raw value. */
function closeTo(actual: string, expected: string) {
  const a = Number(actual);
  const e = Number(expected);
  if (e === 0) return Math.abs(a) < 1e-12;
  return Math.abs(a - e) / Math.abs(e) < 1e-12;
}

describe('worked examples (hand-calculated)', () => {
  it('has at least 25 of them', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(25);
  });

  it.each(EXAMPLES)('$name', ({ expression, inputs, decimals, raw, reported }) => {
    const out = calculate(expression, inputs, decimals);
    expect(closeTo(out.raw, raw), `raw ${out.raw} vs hand ${raw}`).toBe(true);
    expect(out.reported).toBe(reported);
  });

  it('gives the same answer every time (deterministic)', () => {
    for (const ex of EXAMPLES) {
      const first = calculate(ex.expression, ex.inputs, ex.decimals);
      for (let i = 0; i < 3; i++) expect(calculate(ex.expression, ex.inputs, ex.decimals)).toEqual(first);
    }
  });

  it('reports a value without rounding when no decimals are declared', () => {
    expect(calculate('a / b', { a: 2, b: 3 }, null)).toEqual({ raw: '0.666666666666667', reported: '0.666666666666667' });
  });
});

describe('what the parser accepts and refuses', () => {
  const refuse = (expression: string, pattern: RegExp) => {
    expect(() => compileFormula(expression), expression).toThrow(FormulaError);
    expect(() => compileFormula(expression), expression).toThrow(pattern);
  };

  it('lists the variables and functions a formula uses', () => {
    const c = compileFormula(AV);
    expect(c.variables).toEqual(['x']);
    expect(c.functions).toEqual(['abs', 'count', 'if', 'max', 'mean', 'min', 'sd']);
    expect(compileFormula(ASSAY).variables).toEqual(['A_spl', 'A_std', 'Avg_wt', 'LC', 'P_std', 'V_spl', 'V_std', 'W_spl', 'W_std']);
  });

  it("refuses '__proto__' and the other object-machinery names as variables", () => {
    refuse('__proto__', /__proto__/);
    refuse('a + __proto__', /__proto__/);
    refuse('constructor', /constructor/);
    refuse('prototype * 2', /prototype/);
    refuse('__x + 1', /__x/);
  });

  it("refuses ';', property access, strings, brackets, assignment and anything that is not part of the language", () => {
    refuse('a; b', /;/);
    refuse('a + 1;', /;/);
    refuse('a.b', /\./);
    refuse("'x'", /'/);
    refuse('"x"', /"/);
    refuse('[1, 2]', /\[/);
    refuse('a = 1', /=/);
    refuse('a => a', /=/);
    refuse('`x`', /`/);
    refuse('a ? b : c', /\?/);
    refuse('{}', /\{/);
    refuse('1e3', /e3|exponent|unexpected/i);
  });

  it('refuses a call to anything that is not on the allow-list', () => {
    for (const fn of ['eval', 'Function', 'require', 'process', 'constructor', 'toString', 'valueOf', 'alert', 'round', 'x']) {
      refuse(`${fn}(1)`, new RegExp(`${fn}.*not allowed|not allowed.*${fn}`));
    }
    expect(ALLOWED_FUNCTIONS).toEqual(['abs', 'count', 'exp', 'if', 'ln', 'log10', 'max', 'mean', 'min', 'pow', 'rsd', 'sd', 'sqrt', 'sum']);
  });

  it('refuses malformed expressions with a message', () => {
    refuse('', /empty/i);
    refuse('   ', /empty/i);
    refuse('(a + b', /\)/);
    refuse('a + b)', /\)/);
    refuse('a +', /end/i);
    refuse('a b', /unexpected/i);
    refuse('pow(1)', /pow.*2/);
    refuse('mean()', /mean/);
    refuse('if(1, 2)', /if.*3/);
    refuse('1..2', /unexpected|\./);
  });

  it('refuses expressions that are too long or nested too deeply', () => {
    refuse('a + '.repeat(600) + 'a', /long/i);
    refuse('('.repeat(60) + 'a' + ')'.repeat(60), /deep/i);
  });
});

describe('evaluation errors are errors, never a wrong number', () => {
  const fails = (expression: string, inputs: Inputs, pattern: RegExp) => {
    const c = compileFormula(expression);
    expect(() => evaluateFormula(c, inputs), expression).toThrow(FormulaError);
    expect(() => evaluateFormula(c, inputs), expression).toThrow(pattern);
  };

  it('a missing input, an input that is not a finite number, and an input object that hides names in its prototype', () => {
    fails('a + b', { a: 1 }, /b/);
    fails('a', { a: Number.NaN }, /finite/);
    fails('a', { a: Number.POSITIVE_INFINITY }, /finite/);
    fails('mean(x)', { x: [1, Number.NaN] }, /finite/);
    const inherited = Object.create({ a: 5 }) as Inputs;
    fails('a', inherited, /a/);
  });

  it('division by zero, the square root or logarithm of a negative number, and an overflow', () => {
    fails('a / b', { a: 1, b: 0 }, /zero/i);
    fails('sqrt(a)', { a: -1 }, /sqrt/);
    fails('ln(a)', { a: 0 }, /ln/);
    fails('log10(a)', { a: -5 }, /log10/);
    fails('pow(a, b)', { a: 10, b: 400 }, /finite/);
    fails('rsd(x)', { x: [-1, 1] }, /mean.*zero|zero/i);
  });

  it('replicates are used through an aggregate, and sd needs at least two values', () => {
    fails('x + 1', { x: [1, 2] }, /replicates|mean/);
    fails('sqrt(x)', { x: [4, 9] }, /replicates|mean/);
    fails('sd(x)', { x: [5] }, /two/);
    fails('mean(x)', { x: [] }, /no values|empty/i);
  });

  it('if() evaluates only the branch it takes', () => {
    expect(evaluateFormula(compileFormula('if(b == 0, 0, a / b)'), { a: 1, b: 0 })).toBe(0);
  });
});

describe('toDecimalString', () => {
  it('writes 15 significant digits, without an exponent, trailing zeros or negative zero', () => {
    expect(toDecimalString(0.1 + 0.2)).toBe('0.3');
    expect(toDecimalString(1e-7)).toBe('0.0000001');
    expect(toDecimalString(1234567890123456789)).toBe('1234567890123460000');
    expect(toDecimalString(-0)).toBe('0');
    expect(toDecimalString(2 / 3)).toBe('0.666666666666667');
    expect(() => toDecimalString(Number.NaN)).toThrow(FormulaError);
  });
});
