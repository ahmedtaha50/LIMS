/**
 * Roadmap M39 (r3-spc), the control chart component: straight lines (no smoothing), centre line and control limits drawn, the
 * specification limits apart from them, a violation shown by shape AND rule id (not colour alone), an unapproved point as a hollow ring
 * that does not join the line, and each point a link to its sample. Rendered on the server with react-dom, like tests/api/em-ui.test.ts;
 * the data flow is covered by tests/api/spc-trending.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ControlChart, kindOf, type ChartPointData } from '../../src/components/ControlChart';

const point = (i: number, value: number, over: Partial<ChartPointData> = {}): ChartPointData => ({
  resultId: `R${i}`, sampleId: `SMP-${i}`, batch: `B${i}`, value, enteredAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), sampleState: 'Approved', approved: true, z: 0, violations: [], ...over,
});
const limits = { cl: 100, sigma: 1, ucl: 103, lcl: 97 };

describe('the control chart', () => {
  const pts = [
    point(0, 100), point(1, 101), point(2, 103.4, { z: 3.4, violations: [{ rule: 'N1', label: 'One point beyond 3 sigma', severity: 'violation', side: 'above' }] }),
    point(3, 99, { approved: false, sampleState: 'Pending Review' }), point(4, 102.2, { violations: [{ rule: '1-2s', label: 'warning', severity: 'warning', side: 'above' }] }),
  ];
  const html = renderToStaticMarkup(React.createElement(ControlChart, { points: pts, limits, spec: { lower: 95, upper: 105 }, unit: '%', title: 'Assay' }));

  it('draws the centre line, both control limits and both specification limits with their values', () => {
    for (const label of ['UCL 103.00', 'CL 100.00', 'LCL 97.00', 'USL 105.00', 'LSL 95.00']) expect(html).toContain(label);
  });
  it('joins the approved points with straight segments only (no curve commands), skipping the unapproved one', () => {
    const d = /<path d="([^"]+)"/.exec(html)![1];
    expect(d).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){3}$/); // 4 approved points: M + 3 L
    expect(d).not.toMatch(/[CcQqSsTtAa]/);
  });
  it('marks a violation by shape and rule id, a warning by another shape, and an unapproved point as a hollow ring', () => {
    expect(html).toContain('<polygon'); // diamond
    expect(html).toMatch(/>N1<\/text>/);
    expect(html).toMatch(/>1-2s<\/text>/);
    expect(html).toContain('fill="white" stroke="#475569"'); // hollow ring
    expect(kindOf(pts[2])).toBe('violation'); expect(kindOf(pts[4])).toBe('warning'); expect(kindOf(pts[3])).toBe('unapproved'); expect(kindOf(pts[0])).toBe('ok');
  });
  it('makes every point a link to its sample with a text alternative; says when a point is not approved', () => {
    expect(html).toContain('href="#/samples/SMP-2"');
    expect(html).toContain('aria-label="Sample SMP-2, batch B2, 103.4 %, rule N1"');
    expect(html).toContain('aria-label="Sample SMP-3, batch B3, 99 %, not approved"');
    expect(html).toContain('not approved, not used for the limits');
  });
  it('explains the markers in words and says an empty window is empty', () => {
    expect(html).toContain('rule violation (rule id beside it)');
    expect(html).toContain('not approved (not used for limits or rules)');
    expect(renderToStaticMarkup(React.createElement(ControlChart, { points: [], limits: null, spec: { lower: null, upper: null }, title: 'x' }))).toContain('no approved results');
  });
  it('draws without limits (a series too short for any) and with a flat series', () => {
    expect(() => renderToStaticMarkup(React.createElement(ControlChart, { points: [point(0, 5)], limits: null, spec: { lower: null, upper: null }, title: 'x' }))).not.toThrow();
    expect(() => renderToStaticMarkup(React.createElement(ControlChart, { points: [point(0, 5), point(1, 5)], limits: null, spec: { lower: null, upper: null }, title: 'x' }))).not.toThrow();
  });
});
