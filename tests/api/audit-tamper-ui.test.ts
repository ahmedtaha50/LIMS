/**
 * Roadmap M35 (r2-audit-tamper), the screen (src/components/AuditReview.tsx): the exceptions a reviewer must look at, whether a batch
 * is covered by a signed review, the anchor check, and an open clock anomaly with its acknowledgement offered to Administrators only.
 * Rendered on the server with react-dom (no browser), like tests/api/qms-ui.test.ts; the data flow is covered by
 * tests/api/audit-tamper-review.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnchorStatus, AnomalyTable, CoverageBadge, ExceptionTable, reviewScopeBody, type AuditException, type ClockAnomalyRow, type ScopeSummary } from '../../src/components/AuditReview';

const noop = () => {};
const exc = (over: Partial<AuditException>): AuditException => ({
  kind: 'EDIT_AFTER_SUBMIT', sequence: 41, entity: 'Result', entityId: 'RES-1', userId: 'usr-analyst1', actorName: 'Test Analyst One',
  action: 'Update', field: 'value', oldValue: '99.0', newValue: '99.4', reason: 'Transcription error', timestamp: '2026-10-01T10:00:00.000Z',
  detail: 'Changed after the sample was submitted for review (sequence 40).', ...over,
});
const anomaly = (over: Partial<ClockAnomalyRow>): ClockAnomalyRow => ({
  id: 'CLK-1', detectedAt: '2026-10-01T10:00:00.000Z', watermark: '2026-10-01T10:10:00.000Z', behindMs: 600000, source: 'signature',
  acknowledgedBy: null, acknowledgedAt: null, ackReason: null, version: 1, ...over,
});

describe('the exceptions', () => {
  it('names each kind in words, with the sequence, the actor, the change and the reason', () => {
    const html = renderToStaticMarkup(React.createElement(ExceptionTable, {
      exceptions: [exc({}), exc({ kind: 'SIGNATURE_FAILED', sequence: 42, entity: 'Sample', entityId: 'S-1', action: 'SignatureFailed' }), exc({ kind: 'SAME_USER_CREATED_AND_APPROVED', sequence: 43 }), exc({ kind: 'ROLE_OR_SETTING_CHANGE', sequence: 44 })],
    }));
    expect(html).toContain('Edited after submission');
    expect(html).toContain('Failed signature');
    expect(html).toContain('Created and approved by the same person');
    expect(html).toContain('Role or setting change');
    expect(html).toContain('#41');
    expect(html).toContain('Test Analyst One');
    expect(html).toContain('Transcription error');
    expect(renderToStaticMarkup(React.createElement(ExceptionTable, { exceptions: [] }))).toContain('No exceptions');
  });
});

describe('the coverage of a batch', () => {
  it('says whether release needs a review and whether the batch is covered', () => {
    expect(renderToStaticMarkup(React.createElement(CoverageBadge, { coverage: { covered: true, uncoveredRows: 0 }, required: true }))).toContain('Covered by a signed review');
    const open = renderToStaticMarkup(React.createElement(CoverageBadge, { coverage: { covered: false, uncoveredRows: 3 }, required: true }));
    expect(open).toContain('3 entries not reviewed');
    expect(open).toContain('blocks release');
    expect(renderToStaticMarkup(React.createElement(CoverageBadge, { coverage: { covered: false, uncoveredRows: 3 }, required: false }))).not.toContain('blocks release');
  });
});

describe('the anchors', () => {
  it('shows a mismatch as a failure with the file and the reason, never as a green banner', () => {
    const bad = renderToStaticMarkup(React.createElement(AnchorStatus, { verification: { isValid: false, anchorsChecked: 2, latest: null, headSequence: 9, failures: [{ file: 'audit-anchor-2026-10-01-000041.json', sequence: 41, reason: 'HASH_MISMATCH' }] } }));
    expect(bad).toContain('HASH_MISMATCH');
    expect(bad).toContain('audit-anchor-2026-10-01-000041.json');
    expect(bad).not.toContain('All anchors match');
    const good = renderToStaticMarkup(React.createElement(AnchorStatus, { verification: { isValid: true, anchorsChecked: 2, latest: { sequence: 41, anchoredAt: '2026-10-01T00:15:00.000Z', file: 'f.json' }, headSequence: 50, failures: [] } }));
    expect(good).toContain('All anchors match');
    expect(renderToStaticMarkup(React.createElement(AnchorStatus, { verification: null }))).toContain('Not verified yet');
  });
});

describe('the clock anomalies', () => {
  it('offers the acknowledgement of an open anomaly to an Administrator only', () => {
    const rows = [anomaly({}), anomaly({ id: 'CLK-0', acknowledgedBy: 'usr-admin', acknowledgedAt: '2026-10-01T11:00:00.000Z', ackReason: 'NTP fixed' })];
    const admin = renderToStaticMarkup(React.createElement(AnomalyTable, { anomalies: rows, canAcknowledge: true, onAcknowledge: noop }));
    expect(admin).toContain('10 min behind');
    expect(admin.match(/>Acknowledge</g)).toHaveLength(1);
    expect(admin).toContain('NTP fixed');
    const other = renderToStaticMarkup(React.createElement(AnomalyTable, { anomalies: rows, canAcknowledge: false, onAcknowledge: noop }));
    expect(other).not.toContain('>Acknowledge<');
    expect(other).toContain('Signing is blocked');
  });
});

describe('what the signed review names', () => {
  const summary = (over: Partial<ScopeSummary>): ScopeSummary => ({
    scope: { kind: 'batch', batch: 'B-SHOWN' }, fromSequence: 3, toSequence: 41, rowCount: 7, authors: ['usr-analyst1'], exceptionCount: 0,
    exceptions: [], truncated: false, ...over,
  });
  it('is the scope on the screen and its last entry, not what the inputs hold now', () => {
    expect(reviewScopeBody(summary({}))).toEqual({ scope: 'batch', batch: 'B-SHOWN', throughSequence: 41 });
    expect(reviewScopeBody(summary({ scope: { kind: 'range' }, fromSequence: 10, toSequence: 20 }))).toEqual({ scope: 'range', fromSequence: 10, toSequence: 20 });
    expect(reviewScopeBody(summary({ rowCount: 0, fromSequence: null, toSequence: null }))).toBeNull();
  });
});
