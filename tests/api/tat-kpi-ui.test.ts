/**
 * Roadmap M34 (r2-tat-kpi), the screen: key-figure tiles come from the server per role and open the list they count, the turnaround panel
 * shows what the server computed (and says so when there is nothing), the facts are dated and are not scores, and the widget no longer
 * carries a composite score or static compliance claims. Rendered on the server with react-dom (no browser), like tests/api/em-ui.test.ts;
 * the data flow is covered by tests/api/tat-kpi.test.ts.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DrillPanel, FactsPanel, KpiTiles, TatPanel, formatHours, type KpiResponse, type TatResponse } from '../../src/components/Dashboard';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
const kpi = (over: Partial<KpiResponse> = {}): KpiResponse => ({
  role: 'Analyst', generatedAt: '2026-10-25T10:00:00.000Z', facts: null,
  tiles: [
    { key: 'tat.overdue', label: 'Past their due date', hint: 'h', severity: 'bad', view: 'samples', count: 3 },
    { key: 'samples.testing', label: 'In testing', hint: 'h', severity: 'info', view: 'samples', count: 0 },
  ], ...over,
});
const tat = (over: Partial<TatResponse> = {}): TatResponse => ({
  window: { from: '2026-07-27T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' }, completed: 10, approved: 10, withDueDate: 10, onTime: 7, onTimePct: 70,
  medianHours: 11, p90Hours: 20.2, open: { total: 4, overdue: 1, withoutDueDate: 2 },
  aging: [{ bucket: '0-1 days', n: 1 }, { bucket: '2-3 days', n: 1 }, { bucket: '4-7 days', n: 0 }, { bucket: '8-14 days', n: 0 }, { bucket: '15+ days', n: 2 }],
  oosRate: [{ parameter: 'Assay (%)', results: 10, oos: 2, ratePct: 20 }], rightFirstTime: { approved: 10, firstTime: 9, pct: 90 }, ...over,
});

describe('the key-figure tiles', () => {
  it('show the server\'s counts, mark a tile that is open in red and one at zero in green, and are buttons that open their list', () => {
    const html = renderToStaticMarkup(React.createElement(KpiTiles, { data: kpi(), selected: 'tat.overdue', onSelect: () => {} }));
    expect(html).toContain('Past their due date');
    expect(html).toContain('>3<');
    expect(html).toContain('border-red-300');
    expect(html).toContain('border-emerald-200');
    expect(html).toContain('Nothing open');
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('Key figures for Analyst');
  });
  it('say so when the role has no tiles', () => {
    expect(renderToStaticMarkup(React.createElement(KpiTiles, { data: kpi({ tiles: [], role: 'Service' }), selected: null, onSelect: () => {} }))).toContain('No key figures are defined for the role Service');
  });
});

describe('the list behind a tile', () => {
  it('shows the total, the rows, and how many are shown when the list is cut', () => {
    const html = renderToStaticMarkup(React.createElement(DrillPanel, {
      drill: { key: 'tat.overdue', label: 'Past their due date', view: 'samples', total: 205, shown: 2, rows: [
        { id: 'SMP-2026-00001', label: 'Aspirin', detail: 'Batch B1, Testing', at: '2026-10-24T16:00:00Z' },
        { id: 'SMP-2026-00002', label: 'Ibuprofen', detail: 'Batch B2, Logged', at: null },
      ] },
      onClose: () => {}, onOpen: () => {},
    }));
    expect(html).toContain('(205)');
    expect(html).toContain('SMP-2026-00001');
    expect(html).toContain('2026-10-24 16:00 UTC');
    expect(html).toContain('Showing the first 2 of 205');
    expect(html).toContain('Open the screen');
  });
  it('says that nothing is listed when the figure is 0', () => {
    const html = renderToStaticMarkup(React.createElement(DrillPanel, { drill: { key: 'k', label: 'L', view: 'samples', total: 0, shown: 0, rows: [] }, onClose: () => {} }));
    expect(html).toContain('this figure is 0');
    expect(html).not.toContain('Open the screen');
  });
});

describe('the turnaround panel', () => {
  it('shows on-time %, median, P90, right-first-time, the aging buckets and the OOS rate exactly as the server sent them', () => {
    const html = renderToStaticMarkup(React.createElement(TatPanel, { data: tat() }));
    expect(html).toContain('70%');
    expect(html).toContain('7 of 10 with a due date');
    expect(html).toContain('11.0 h');
    expect(html).toContain('20.2 h');
    expect(html).toContain('90%');
    expect(html).toContain('last 90 days');
    expect(html).toContain('4, 1 past due, 2 without a due date');
    expect(html).toContain('15+ days');
    expect(html).toContain('2 of 10');
  });
  it('does not invent a figure when nothing finished', () => {
    const html = renderToStaticMarkup(React.createElement(TatPanel, { data: tat({ completed: 0, approved: 0, withDueDate: 0, onTime: 0, onTimePct: null, medianHours: null, p90Hours: null, oosRate: [], rightFirstTime: { approved: 0, firstTime: 0, pct: null } }) }));
    expect(html).toContain('No sample finished in this period');
    expect(html).toContain('No results were recorded');
    expect(html).not.toContain('n/a%');
  });
  it('formats long cycle times in days', () => {
    expect(formatHours(11)).toBe('11.0 h');
    expect(formatHours(72)).toBe('3.0 d');
    expect(formatHours(null)).toBe('n/a');
  });
});

describe('the recorded facts', () => {
  it('are dated, with the outcome, and say when nothing has been recorded', () => {
    const html = renderToStaticMarkup(React.createElement(FactsPanel, { facts: {
      lastChainVerification: { at: '2026-10-18T04:00:00.000Z', outcome: 'success' }, lastBackup: { at: '2026-10-25T02:01:00.000Z', outcome: 'ok', verified: true },
    } }));
    expect(html).toContain('2026-10-18 04:00 UTC, result: success');
    expect(html).toContain('2026-10-25 02:01 UTC, result: ok, verified');
    expect(renderToStaticMarkup(React.createElement(FactsPanel, { facts: { lastChainVerification: null, lastBackup: null } }))).toContain('None recorded yet.');
  });
});

describe('what the screens no longer claim', () => {
  const widget = read('src/components/ComplianceOverviewWidget.tsx');
  const screen = read('src/components/Dashboard.tsx');
  const heatmap = read('src/components/ActivityHeatmap.tsx');
  it('the widget has no composite score, no regulation banner and no qualification label; it shows when the figures were computed', () => {
    expect(widget).not.toMatch(/compositeScore|compositeStatus|getScoreColor/);
    expect(widget).not.toMatch(/GxP Compliance Standard|21 CFR|AIQ|USP/);
    expect(widget).toContain('As of ');
  });
  it('the dashboard loads the key figures and turnaround through apiFetch and shows a failure', () => {
    expect(screen).toMatch(/apiFetch<KpiResponse>\('\/metrics\/kpi'\)/);
    expect(screen).toMatch(/apiFetch<TatResponse>\('\/metrics\/tat'\)/);
    // r3-i18n: the message comes from the catalogue (English text unchanged: 'dash.kpiFailed'); the failure is still a visible error toast.
    expect(screen).toMatch(/toast\(localizedError\(err, 'dash\.kpiFailed'\), 'error'\)/);
  });
  it('the activity heatmap no longer swallows a failed load', () => {
    expect(heatmap).toMatch(/apiFetch<HeatmapData\[\]>/);
    expect(heatmap).not.toMatch(/console\.error/);
    expect(heatmap).toContain('role="alert"');
  });
});
