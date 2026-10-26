/**
 * Roadmap M21 (r2-instrument-integration), the parser registry: fixture files give the expected rows, and a malformed file gives a
 * ParseError that names the problem and the line, never a half-read import. Pure functions: no database.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { checkMapping, MAX_ROWS, parseInstrumentFile, parserList, ParseError } from '../../src/server/parsers';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'instrument-data', name), 'utf8');
const rowsOf = (rows: ReturnType<typeof parseInstrumentFile>) => rows.map(r => [r.sampleRef, r.parameter, r.value, r.unit]);
const messageOf = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(ParseError); return (e as Error).message; } throw new Error('expected a ParseError'); };

describe('the registry', () => {
  it('lists the four parsers', () => {
    expect(parserList().map(p => p.id).sort()).toEqual(['balance-text', 'generic-csv', 'hplc-summary-csv', 'ph-csv']);
  });
  it('refuses an unknown parser and an unknown mapping key', () => {
    expect(messageOf(() => parseInstrumentFile('nope', {}, 'x'))).toContain('unknown parser');
    const bad = checkMapping('ph-csv', { phcolumn: 'pH' });
    expect(bad.ok).toBe(false);
  });
});

describe('balance-text', () => {
  it('reads labelled and bare readings, takes the net value and ignores tare and gross', () => {
    const rows = parseInstrumentFile('balance-text', {}, fixture('balance.txt'));
    expect(rowsOf(rows)).toEqual([
      ['SMP-FX-1', 'Weight', '12.3456', 'g'],
      ['SMP-FX-2', 'Weight', '-0.0020', 'g'],
      [null, 'Weight', '101.5', 'mg'],
    ]);
    expect(rows[0].line).toBe(4);
  });
  it('uses the parameter name of the mapping', () => {
    expect(parseInstrumentFile('balance-text', { parameter: 'Net weight' }, 'N 1.5000 g')[0].parameter).toBe('Net weight');
  });
  it('says so when no reading is found', () => {
    expect(messageOf(() => parseInstrumentFile('balance-text', {}, fixture('balance-bad.txt')))).toContain('no weight reading found');
  });
});

describe('ph-csv', () => {
  it('reads the sample, the pH and keeps the other cells as exported', () => {
    const rows = parseInstrumentFile('ph-csv', {}, fixture('ph.csv'));
    expect(rowsOf(rows)).toEqual([['SMP-FX-1', 'pH', '7.02', null], ['SMP-FX-2', 'pH', '6.98', null]]);
    expect(rows[0].raw['Temperature (C)']).toBe('24.8');
    expect(rows[1].line).toBe(3);
  });
  it('names the line and the cell of a value that is not a number', () => {
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, fixture('ph-malformed.csv')))).toBe('Line 2: the pH "seven" is not a number.');
  });
  it('refuses a row with more cells than the header, an unclosed quote, a pH outside 0 to 14 and a missing column', () => {
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, fixture('ph-ragged.csv')))).toBe('Line 2: expected 2 cells (as in the header) but found 3.');
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, fixture('ph-unclosed.csv')))).toContain('Line 2: a quoted cell is never closed');
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, fixture('ph-range.csv')))).toBe('Line 2: pH 15.2 is outside 0 to 14.');
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, fixture('ph-nocolumn.csv')))).toContain('no column for the pH');
  });
});

describe('hplc-summary-csv', () => {
  it('reads the amount per component and maps component names to parameters', () => {
    const rows = parseInstrumentFile('hplc-summary-csv', { parameterMap: { Assay: 'Assay (%)' } }, fixture('hplc.csv'));
    expect(rowsOf(rows)).toEqual([['SMP-FX-1', 'Assay (%)', '99.2', null], ['SMP-FX-1', 'Impurity A', '0.15', null]]);
  });
  it('reads the area when the mapping says so', () => {
    expect(rowsOf(parseInstrumentFile('hplc-summary-csv', { valueColumn: 'Area' }, fixture('hplc.csv')))[0]).toEqual(['SMP-FX-1', 'Assay', '123456.7', null]);
  });
  it('reads a semicolon file with a byte-order mark, quoted cells with commas and decimal commas', () => {
    const rows = parseInstrumentFile('hplc-summary-csv', { delimiter: ';', unitColumn: 'Unit', decimalComma: true }, fixture('hplc-semicolon.csv'));
    expect(rowsOf(rows)).toEqual([['SMP-FX-1', 'Active, free base', '99.2', '%'], ['SMP-FX-1', 'Impurity A', '0.15', '%']]);
  });
  it('does not take a decimal comma for a number unless the mapping says so', () => {
    expect(messageOf(() => parseInstrumentFile('hplc-summary-csv', { delimiter: ';' }, fixture('hplc-semicolon.csv')))).toContain('"99,2" is not a number');
  });
});

describe('generic-csv', () => {
  const mapping = { sampleColumn: 'Sample', parameterColumn: 'Analyte', valueColumn: 'Result', unitColumn: 'Units' };
  it('reads the columns the mapping names', () => {
    expect(rowsOf(parseInstrumentFile('generic-csv', mapping, fixture('generic.csv')))).toEqual([
      ['SMP-FX-1', 'Water, by KF', '4.8', '%'], ['SMP-FX-2', 'Water, by KF', '5.1', '%'],
    ]);
  });
  it('takes a fixed parameter and unit, and needs exactly one way to name the parameter', () => {
    const rows = parseInstrumentFile('generic-csv', { sampleColumn: 'Sample', fixedParameter: 'KF', valueColumn: 'Result', fixedUnit: '%' }, fixture('generic.csv'));
    expect(rowsOf(rows)[0]).toEqual(['SMP-FX-1', 'KF', '4.8', '%']);
    expect(checkMapping('generic-csv', { valueColumn: 'Result' }).ok).toBe(false);
    expect(checkMapping('generic-csv', { valueColumn: 'Result', parameterColumn: 'A', fixedParameter: 'B' }).ok).toBe(false);
  });
  it('names a column the file does not have', () => {
    expect(messageOf(() => parseInstrumentFile('generic-csv', { ...mapping, valueColumn: 'Amount' }, fixture('generic.csv')))).toContain('no column for the value (looked for: Amount; the header has: Run, Sample, Analyte, Result, Units)');
  });
});

describe('every parser', () => {
  it('refuses an empty file, a header only, binary content and too many rows', () => {
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, ''))).toContain('empty');
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, 'Sample ID,pH\n'))).toContain('no data row');
    expect(messageOf(() => parseInstrumentFile('balance-text', {}, 'N 1.0 g\u0000\u0001'))).toContain('binary');
    const big = ['Sample ID,pH', ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `S-${i},7.0`)].join('\n');
    expect(messageOf(() => parseInstrumentFile('ph-csv', {}, big))).toContain(`at most ${MAX_ROWS}`);
  });
  it('never changes the digits of a value', () => {
    expect(parseInstrumentFile('ph-csv', {}, 'Sample ID,pH\nS-1,7.100\nS-2,+6.9800\n').map(r => r.value)).toEqual(['7.100', '6.9800']);
  });
});
