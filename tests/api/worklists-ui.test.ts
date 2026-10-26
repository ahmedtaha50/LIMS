/**
 * Roadmap M33 (r2-worklists), the screen: the list is grouped by method and instrument, the grid offers a value cell only to the assigned
 * analyst, a cell that already holds a value asks for its reason and is held back without one, a refused cell shows the server's reason, and
 * the workload view prints what the server counted. Rendered on the server with react-dom (no browser), like tests/api/em-ui.test.ts; the
 * data flow is covered by tests/api/worklists.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildCells, groupWorklists, ItemsTable, WorkloadTables, WorklistGroups, type WorklistItem, type WorklistRow } from '../../src/components/Worklists';

const noop = () => {};
const row = (over: Partial<WorklistRow>): WorklistRow => ({
  id: 'WL-2026-0001', title: 'Assay run', methodCode: 'HPLC-ASSAY', instrumentId: 'INST-1', instrumentName: 'HPLC 1', plannedDate: '2026-10-26', status: 'Draft',
  itemCount: 3, sampleItems: 2, pending: 2, version: 1, ...over,
});
const item = (over: Partial<WorklistItem>): WorklistItem => ({
  id: 'wli-1', position: 1, kind: 'Sample', sampleId: 'SMP-2026-00001', resultId: 'res-1', label: null, assigneeId: 'usr-analyst1', assigneeName: 'Test Analyst One',
  status: 'Active', version: 1, material: 'Paracetamol', batch: 'B1', parameter: 'Assay', value: null, unit: '%', resultVersion: 1, isOos: false, removedReason: null, ...over,
});
const table = (items: WorklistItem[], over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ItemsTable, {
  items, status: 'Released', canManage: true, canEnter: true, userId: 'usr-analyst1', edits: {}, failures: {}, onEdit: noop, onMove: noop, onReassign: noop, onRemove: noop, ...over,
}));

describe('the list', () => {
  it('groups by method, then instrument, then planned date, with a stable order that does not depend on the locale', () => {
    const groups = groupWorklists([
      row({ id: 'WL-2026-0003', methodCode: 'KF-WATER', instrumentId: null, instrumentName: null }),
      row({ id: 'WL-2026-0002', plannedDate: '2026-10-27' }),
      row({ id: 'WL-2026-0001' }),
      row({ id: 'WL-2026-0004', instrumentId: 'INST-2', instrumentName: 'HPLC 2', plannedDate: '2026-10-20' }),
    ]);
    expect(groups.map(g => g.methodCode)).toEqual(['HPLC-ASSAY', 'KF-WATER']);
    expect(groups[0].instruments.map(i => i.instrument)).toEqual(['HPLC 1 (INST-1)', 'HPLC 2 (INST-2)']);
    expect(groups[0].instruments[0].worklists.map(w => w.id)).toEqual(['WL-2026-0001', 'WL-2026-0002']);
    expect(groups[1].instruments[0].instrument).toBe('No instrument named');
  });

  it('prints the groups with a link to each worklist, the status in words and the pending count of a Released one only', () => {
    const html = renderToStaticMarkup(React.createElement(WorklistGroups, { rows: [row({}), row({ id: 'WL-2026-0002', status: 'Released', pending: 5 })] }));
    expect(html).toContain('Method HPLC-ASSAY');
    expect(html).toContain('href="#/worklists/WL-2026-0001"');
    expect(html).toContain('Draft');
    expect(html).toContain('Released');
    expect(html).toContain('<td>5</td>');
    expect(renderToStaticMarkup(React.createElement(WorklistGroups, { rows: [] }))).toContain('No worklist matches');
  });
});

describe('the run and the grid', () => {
  it('offers a value cell only to the assigned analyst; another analyst is told who enters the result', () => {
    const mine = table([item({})]);
    expect(mine).toContain('aria-label="Result for Assay of SMP-2026-00001"');
    expect(mine).toContain('(you)');
    const theirs = table([item({ assigneeId: 'usr-analyst2', assigneeName: 'Test Analyst Two' })]);
    expect(theirs).not.toContain('aria-label="Result for Assay');
    expect(theirs).toContain('Only Test Analyst Two enters this result.');
  });

  it('offers no cell on a Draft or to a role that does not enter results; the actions follow worklist.manage and the status', () => {
    expect(table([item({})], { status: 'Draft' })).not.toContain('aria-label="Result for');
    expect(table([item({})], { canEnter: false })).not.toContain('aria-label="Result for');
    expect(table([item({})], { canManage: false })).not.toContain('Reassign');
    expect(table([item({})], { status: 'Completed' })).not.toContain('Reassign');
    expect(table([item({})])).toContain('Reassign');
    expect(table([item({ kind: 'SST', sampleId: null, resultId: null, label: 'SST 1', assigneeId: null, assigneeName: null, parameter: null })])).toContain('Relabel');
  });

  it('asks for a reason when an entered value is changed, shows the server\'s reason for a refused cell, and numbers only the Active items', () => {
    const entered = item({ value: '99.0', resultVersion: 2 });
    const html = table([entered, item({ id: 'wli-2', position: 2, resultId: 'res-2', status: 'Removed', removedReason: 'Withdrawn' })], {
      edits: { 'res-1': { value: '99.5', reason: '' } }, failures: { 'res-1': '409: Assay was changed by someone else since you loaded it.' },
    });
    expect(html).toContain('aria-label="Reason for changing Assay"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('409: Assay was changed by someone else');
    expect(html).toContain('Removed: Withdrawn');
    expect(html).toContain('data-status="Removed"');
    expect(table([entered])).not.toContain('Reason for changing'); // not edited: no reason box
  });

  it('flags an OOS value in words, not by colour alone', () => {
    expect(table([item({ value: '90.0', isOos: true, resultVersion: 2 })])).toContain('90.0 % (OOS)');
  });
});

describe('what a grid save sends', () => {
  const items = [item({ id: 'a', resultId: 'r-a' }), item({ id: 'b', resultId: 'r-b', parameter: 'Water', value: '0.4', resultVersion: 3 }), item({ id: 'c', resultId: 'r-c', parameter: 'Impurity' }),
    item({ id: 'd', resultId: null, kind: 'Blank', sampleId: null, label: 'B', parameter: null }), item({ id: 'e', resultId: 'r-e', status: 'Removed' })];

  it('sends only the cells whose value changed, with the version it was loaded at and the worklist instrument', () => {
    const { cells, held } = buildCells(items, { 'r-a': { value: ' 99.5 ', reason: '' }, 'r-c': { value: '', reason: '' }, 'r-e': { value: '1', reason: '' } }, 'INST-1');
    expect(cells).toEqual([{ resultId: 'r-a', value: '99.5', expectedVersion: 1, instrumentId: 'INST-1' }]);
    expect(held).toEqual([]);
  });

  it('holds back a cell that overwrites a value until it has its own reason, and does not send the unchanged one', () => {
    const edits = { 'r-b': { value: '0.5', reason: 'abc' }, 'r-a': { value: '99.5', reason: '' } };
    let out = buildCells(items, edits);
    expect(out.cells.map(c => c.resultId)).toEqual(['r-a']);
    expect(out.held).toEqual([{ resultId: 'r-b', message: 'Water: changing a value already entered needs a reason of at least 5 characters.' }]);
    out = buildCells(items, { ...edits, 'r-b': { value: '0.5', reason: 'Re-weighed after drying' } });
    expect(out.cells).toContainEqual({ resultId: 'r-b', value: '0.5', expectedVersion: 3, reason: 'Re-weighed after drying' });
    expect(buildCells(items, { 'r-b': { value: '0.4', reason: 'same' } }).cells).toEqual([]);
  });
});

describe('the workload', () => {
  it('prints the figures per analyst and instrument and says so when there are none', () => {
    const html = renderToStaticMarkup(React.createElement(WorkloadTables, { data: {
      today: '2026-10-25',
      analysts: [{ userId: 'u1', name: 'Test Analyst One', releasedWorklists: 2, releasedItems: 9, pending: 4, overdue: 3, draftWorklists: 1, draftItems: 2, nextPlannedDate: '2026-10-24' }],
      instruments: [{ instrumentId: 'INST-1', name: 'HPLC 1', releasedWorklists: 2, draftWorklists: 1, items: 11, nextPlannedDate: '2026-10-24' }],
    } }));
    expect(html).toContain('Test Analyst One');
    expect(html).toContain('3 overdue');
    expect(html).toContain('1 worklist(s), 2 item(s)');
    expect(html).toContain('HPLC 1');
    const none = renderToStaticMarkup(React.createElement(WorkloadTables, { data: { today: '2026-10-25', analysts: [], instruments: [] } }));
    expect(none).toContain('No analyst has work assigned');
    expect(none).toContain('No instrument is planned');
  });
});
