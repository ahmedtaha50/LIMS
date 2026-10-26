/**
 * Roadmap M32 (r2-em), the screen: the heat grid shows the worst status per point and week, the result list shows the server's status,
 * limits and the excursion with its deviation, only QA is offered the correction, only a Draft profile is offered for approval, and the
 * approval goes through the e-signature dialog with the catalog meaning. Rendered on the server with react-dom (no browser), like
 * tests/api/qms-ui.test.ts; the data flow is covered by tests/api/em.test.ts.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeatGrid, ProfileTable, ResultTable, type EmProfile, type EmResultRow } from '../../src/components/Environmental';

const noop = () => {};
const result = (over: Partial<EmResultRow>): EmResultRow => ({
  id: 'EMR-2026-00001', pointId: 'EMP-1', pointCode: 'B104-01', room: 'Suite 104', grade: 'Grade B', method: 'Settle plate', occupancy: 'In operation',
  sampledOn: '2026-10-20', count: 0, unit: 'CFU/4 hours', mediaLot: 'TSA-1', organism: null, status: 'Pass', limitAlert: null, limitAction: 5, version: 1,
  excursionId: null, deviationId: null, deviationState: null, ...over,
});
const profile = (over: Partial<EmProfile>): EmProfile => ({
  id: 'EML-1', grade: 'Grade B', method: 'Air', occupancy: 'In operation', isoClass: null, unit: 'CFU/m3', alertLimit: null, actionLimit: 10,
  source: 'SOP-EM-001', status: 'Draft', origin: 'entry', createdBy: 'usr-admin', approvedBy: null, version: 1, ...over,
});

describe('the heat grid', () => {
  it('colours each week by its worst status and leaves a week without results empty', () => {
    const html = renderToStaticMarkup(React.createElement(HeatGrid, { data: {
      columns: ['2026-10-12', '2026-10-19'],
      rows: [{ pointId: 'EMP-1', code: 'B104-01', room: 'Suite 104', grade: 'Grade B', cells: [null, { worst: 'Action', n: 3 }] }],
    } }));
    expect(html).toContain('B104-01');
    expect(html).toContain('3 result(s), worst Action');
    expect(html).toContain('bg-red-100');
    expect(html).toContain('No result');
    expect(renderToStaticMarkup(React.createElement(HeatGrid, { data: { columns: [], rows: [] } }))).toContain('No sampling points yet.');
  });
});

describe('the result list', () => {
  it('shows the server\'s status, limits, unit and the excursion with its deviation', () => {
    const html = renderToStaticMarkup(React.createElement(ResultTable, {
      results: [result({ status: 'Action', count: 9, excursionId: 'EMX-1', deviationId: 'DEV-2026-0003', deviationState: 'QA Triage' })], canCorrect: false, onCorrect: noop, onIdentify: noop,
    }));
    expect(html).toContain('Action');
    expect(html).toContain('9 <span class="text-slate-500">CFU/4 hours</span>');
    expect(html).toContain('— / 5');
    expect(html).toContain('Excursion EMX-1, deviation DEV-2026-0003 (QA Triage)');
    expect(html).toContain('Identify'); // growth, no organism yet
    expect(html).not.toContain('Correct<');
  });
  it('offers the correction only to a role holding env.correct, and no identification without growth', () => {
    const html = renderToStaticMarkup(React.createElement(ResultTable, { results: [result({})], canCorrect: true, onCorrect: noop, onIdentify: noop }));
    expect(html).toContain('Correct');
    expect(html).not.toContain('Identify');
  });
});

describe('the limit profiles', () => {
  it('offers approval only of a Draft and only to env.manage', () => {
    const rows = [profile({}), profile({ id: 'EML-2', status: 'Approved' }), profile({ id: 'EML-3', status: 'Retired' })];
    expect(renderToStaticMarkup(React.createElement(ProfileTable, { profiles: rows, canManage: true, onApprove: noop })).match(/Approve</g)).toHaveLength(1);
    expect(renderToStaticMarkup(React.createElement(ProfileTable, { profiles: rows, canManage: false, onApprove: noop }))).not.toContain('Approve<');
  });
});

describe('the screen source', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/components/Environmental.tsx'), 'utf8');
  it('uses the programme API and signs the approval with the catalog meaning; no alert(), no prompt(), no status sent', () => {
    for (const route of ['/em/points', '/em/limit-profiles', '/em/results', '/em/trends', '/em/heatmap', '/em/batch-rooms']) expect(src).toContain(route);
    expect(src).toContain('meaningCode={EM_LIMIT_APPROVAL}');
    expect(src).not.toMatch(/\balert\(|window\.prompt|prompt\(/);
    expect(src).not.toMatch(/status:\s*form/);
  });
});
