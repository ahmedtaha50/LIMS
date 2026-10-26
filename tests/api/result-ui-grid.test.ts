/**
 * Roadmap M19 (r2-result-ui), the screen: the result grid of a sample (src/components/ResultGrid.tsx). Rendered on the server with
 * react-dom (no browser), like tests/api/results-ui.test.ts; the keyboard and save logic is tested through its pure functions.
 *
 *   - Enter walks the parameters (Shift+Enter back), skipping rows that cannot be typed; Ctrl+S (or Cmd+S) saves;
 *   - the live PASS/OOS chip is advisory only, and says so; the server evaluates on save;
 *   - an instrument past its calibration due date is disabled in the dropdown, with the due date;
 *   - only dirty rows are sent; an overwrite needs its reason and its coded reason before anything is sent (never autosave);
 *   - a stale row, or a row the server refused, is highlighted with the server's reason;
 *   - an OOS row offers its investigation; the unit is shown beside the value;
 *   - the sample screen mounts the CoA panel of r2-coa-reports (the server issues the certificate, with the unit beside the value)
 *     and no longer composes a certificate in the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  advisoryChip, buildBatchItems, gridKeyAction, instrumentOption, nextRowIndex, ResultGridTable, rowErrorsFromApiError,
} from '../../src/components/ResultGrid';
import { ApiError } from '../../src/lib/api';

const NOW = new Date('2026-10-20T10:00:00Z');
const assay = { id: 'r-assay', parameter: 'Assay', value: null, isOos: false, version: 1, limitKind: 'RANGE', lowerText: '98.0', upperText: '102.0', decimals: 1, unit: '%' };
const water = { id: 'r-water', parameter: 'Water', value: '0.4', isOos: false, version: 2, limitKind: 'NMT', lowerText: null, upperText: '1.0', decimals: 1, unit: '% w/w' };
const impurity = { id: 'r-imp', parameter: 'Impurity A', value: '0.9', isOos: true, version: 2, limitKind: 'NMT', lowerText: null, upperText: '0.5', decimals: 2, unit: '%' };
const looks = { id: 'r-app', parameter: 'Appearance', value: null, isOos: false, version: 1, limitKind: 'TEXT', lowerText: null, upperText: null, decimals: null, unit: null, acceptanceText: 'White powder' };

const instOk = { id: 'INST-1', name: 'HPLC 1', status: 'Active', calibrationDueDate: '2026-11-30' };
const instOverdue = { id: 'INST-2', name: 'HPLC 2', status: 'Active', calibrationDueDate: '2026-10-17' }; // 3 days overdue
const instOff = { id: 'INST-3', name: 'Balance', status: 'Out of Service', calibrationDueDate: '2027-01-01' };

describe('keyboard', () => {
  it('Enter and Shift+Enter walk the rows, ArrowDown/ArrowUp too, Ctrl+S and Cmd+S save, other keys do nothing', () => {
    expect(gridKeyAction({ key: 'Enter' })).toBe('next');
    expect(gridKeyAction({ key: 'Enter', shiftKey: true })).toBe('prev');
    expect(gridKeyAction({ key: 'ArrowDown' })).toBe('next');
    expect(gridKeyAction({ key: 'ArrowUp' })).toBe('prev');
    expect(gridKeyAction({ key: 's', ctrlKey: true })).toBe('save');
    expect(gridKeyAction({ key: 'S', metaKey: true })).toBe('save');
    expect(gridKeyAction({ key: 's' })).toBeNull();
    expect(gridKeyAction({ key: 'Tab' })).toBeNull(); // Tab keeps the browser's order: value, instrument, next row's value
  });

  it('the next row skips rows that cannot be typed and stops at the ends', () => {
    const typeable = [true, false, true, true];
    expect(nextRowIndex(typeable, 0, 'next')).toBe(2);
    expect(nextRowIndex(typeable, 2, 'next')).toBe(3);
    expect(nextRowIndex(typeable, 3, 'next')).toBe(3);
    expect(nextRowIndex(typeable, 2, 'prev')).toBe(0);
    expect(nextRowIndex(typeable, 0, 'prev')).toBe(0);
  });
});

describe('the advisory chip', () => {
  it('is PASS, OOS, or not acceptable as typed, by the rule the server uses (rounded to the declared decimals)', () => {
    expect(advisoryChip(assay, '97.96').kind).toBe('PASS'); // rounds to 98.0
    expect(advisoryChip(assay, '97.94').kind).toBe('OOS');
    expect(advisoryChip(assay, '1,2').kind).toBe('INVALID');
    expect(advisoryChip(assay, '').kind).toBe('EMPTY');
    expect(advisoryChip(looks, 'complies').kind).toBe('PASS');
    expect(advisoryChip(looks, 'Does not comply').kind).toBe('OOS');
  });

  it('is marked advisory in the grid: the server evaluates on save', () => {
    const html = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [assay], drafts: { [assay.id]: { value: '97.94' } }, instruments: [], rowErrors: {}, editable: true, now: NOW,
    }));
    expect(html).toMatch(/advisory/i);
    expect(html).toContain('OOS');
  });
});

describe('instruments', () => {
  it('an instrument 3 days past its due date is disabled and shows the due date; an Active calibrated one is selectable', () => {
    expect(instrumentOption(instOverdue, NOW)).toMatchObject({ value: 'INST-2', disabled: true });
    expect(instrumentOption(instOverdue, NOW).label).toContain('2026-10-17');
    expect(instrumentOption(instOverdue, NOW).label).toMatch(/overdue/i);
    expect(instrumentOption(instOff, NOW)).toMatchObject({ disabled: true });
    expect(instrumentOption(instOk, NOW)).toMatchObject({ value: 'INST-1', disabled: false });
  });

  it('renders the overdue instrument as a disabled option', () => {
    const html = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [assay], drafts: {}, instruments: [instOk, instOverdue], rowErrors: {}, editable: true, now: NOW,
    }));
    expect(html).toMatch(/<option value="INST-2" disabled="">[^<]*2026-10-17/);
    expect(html).toMatch(/<option value="INST-1">/);
  });
});

describe('what a save sends', () => {
  it('only dirty rows, with their versions; a first entry needs no reason', () => {
    const out = buildBatchItems([assay, water, looks], { [assay.id]: { value: '99.8' }, [looks.id]: { value: '' } });
    expect(out.problems).toEqual([]);
    expect(out.items).toEqual([{ resultId: assay.id, value: '99.8', expectedVersion: 1 }]);
  });

  it('an overwrite without its reason or coded reason is held back on the screen, naming the parameter', () => {
    const missing = buildBatchItems([water], { [water.id]: { value: '0.5' } });
    expect(missing.items).toEqual([]);
    expect(missing.problems).toEqual([expect.objectContaining({ resultId: water.id, message: expect.stringMatching(/Water.*reason/i) })]);
    const ok = buildBatchItems([water], { [water.id]: { value: '0.5', reason: 'worksheet re-read', reasonCode: 'TRANSCRIPTION_ERROR' } });
    expect(ok.problems).toEqual([]);
    expect(ok.items).toEqual([{ resultId: water.id, value: '0.5', expectedVersion: 2, reason: 'worksheet re-read', reasonCode: 'TRANSCRIPTION_ERROR' }]);
  });

  it('an instrument change alone is a change; replacing an OOS value sends the open investigation', () => {
    const inst = buildBatchItems([water], { [water.id]: { instrumentId: 'INST-1', reason: 'instrument not recorded', reasonCode: 'TRANSCRIPTION_ERROR' } });
    expect(inst.items).toEqual([{ resultId: water.id, value: '0.4', expectedVersion: 2, instrumentId: 'INST-1', reason: 'instrument not recorded', reasonCode: 'TRANSCRIPTION_ERROR' }]);
    const oos = buildBatchItems([impurity], { [impurity.id]: { value: '0.09', reason: 'decimal point misplaced', reasonCode: 'TRANSCRIPTION_ERROR' } },
      [{ id: 'OOS-2026-00001', resultId: impurity.id, status: 'Open' }]);
    expect(oos.items).toEqual([{ resultId: impurity.id, value: '0.09', expectedVersion: 2, reason: 'decimal point misplaced', reasonCode: 'TRANSCRIPTION_ERROR', oosId: 'OOS-2026-00001' }]);
    const noInvestigation = buildBatchItems([impurity], { [impurity.id]: { value: '0.09', reason: 'decimal point misplaced', reasonCode: 'TRANSCRIPTION_ERROR' } }, []);
    expect(noInvestigation.items).toEqual([]);
    expect(noInvestigation.problems[0].message).toMatch(/investigation/i);
  });

  it('shows the reason fields only on a row that overwrites a value', () => {
    const html = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [assay, water], drafts: { [assay.id]: { value: '99.0' }, [water.id]: { value: '0.5' } }, instruments: [], rowErrors: {}, editable: true, now: NOW,
    }));
    expect(html.match(/Reason for change/g)).toHaveLength(1);
    expect(html).toContain(`reason-${water.id}`);
    expect(html).not.toContain(`reason-${assay.id}`);
  });
});

describe('a refused save', () => {
  it('maps the server details of a stale save to the rows, and highlights them', () => {
    const items = [{ resultId: assay.id, value: '99.8', expectedVersion: 1 }, { resultId: water.id, value: '0.5', expectedVersion: 2 }];
    const err = new ApiError(409, 'RESULTS_STALE', 'Conflict', { details: [{ path: 'items.1', resultId: water.id, parameter: 'Water', message: 'Water was changed by someone else.' }] });
    const errors = rowErrorsFromApiError(err, items);
    expect(errors).toEqual({ [water.id]: { stale: true, message: 'Water was changed by someone else.' } });
    const html = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [assay, water], drafts: {}, instruments: [], rowErrors: errors, editable: true, now: NOW,
    }));
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('Water was changed by someone else.');
  });

  it('a refusal without details falls on no row (the toast carries it)', () => {
    expect(rowErrorsFromApiError(new ApiError(403, 'FORBIDDEN', 'Forbidden'), [])).toEqual({});
  });
});

describe('OOS rows and units', () => {
  it('an OOS row offers its open investigation, or to open one when none is open', () => {
    const withOpen = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [impurity], drafts: {}, instruments: [], rowErrors: {}, editable: false, now: NOW,
      investigations: [{ id: 'OOS-2026-00007', resultId: impurity.id, status: 'Open' }],
    }));
    expect(withOpen).toContain('OOS-2026-00007');
    const none = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [impurity], drafts: {}, instruments: [], rowErrors: {}, editable: false, now: NOW, investigations: [],
    }));
    expect(none).toContain('Open investigation');
  });

  it('shows the unit of each parameter', () => {
    const html = renderToStaticMarkup(React.createElement(ResultGridTable, {
      rows: [water], drafts: {}, instruments: [], rowErrors: {}, editable: false, now: NOW,
    }));
    expect(html).toContain('% w/w');
  });
});

describe('the sample screen mounts the panels of other tracks', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/SampleDetail.tsx'), 'utf8');

  it('mounts the CoA panel (r2-coa-reports) for an Approved or Rejected sample, and composes no certificate in the browser', () => {
    expect(source).toMatch(/import \{ CoaPanel \} from '\.\/CoaPanel'/);
    expect(source).toMatch(/\(sample\.state === 'Approved' \|\| sample\.state === 'Rejected'\) && <CoaPanel sampleId=\{sample\.id\}/);
    expect(source).not.toMatch(/jspdf|generatePDF|Download CoA/i);
  });

  it('keeps the history panel (r1-audit) mounted', () => {
    expect(source).toMatch(/<RecordHistory token=\{token\} entity="Sample"/);
  });
});
