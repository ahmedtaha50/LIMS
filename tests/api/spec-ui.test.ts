/**
 * Roadmap M11 (r1-spec), the screen: a specification is shown by its revision ("Rev 2"), never by the concurrency counter; limits are
 * written by kind and to their declared decimals; the author is not offered the approval. Rendered on the server with react-dom
 * (no browser), like tests/api/esign-ui.test.ts; the data flow is covered by spec-lifecycle.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatLimit, SpecificationCard, type SpecView } from '../../src/components/Specifications';

const spec = (over: Partial<SpecView> = {}): SpecView => ({
  id: 'SPEC-1', material: 'Paracetamol 500 mg', revisionLabel: 2, version: 7, effectiveDate: '2026-11-01', status: 'Active',
  parameters: [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null }],
  createdBy: 'usr-a', approvedBy: 'usr-q', createdByName: 'Ann Analyst', approvedByName: 'Quinn QA', effectiveness: 'Effective', ...over,
});
const render = (props: Partial<React.ComponentProps<typeof SpecificationCard>> & { spec: SpecView }) =>
  renderToStaticMarkup(React.createElement(SpecificationCard, { canEdit: true, canCreate: true, canApprove: true, onEdit() {}, onRevise() {}, onApprove() {}, ...props }));

describe('the specification card', () => {
  it('shows the revision, not the concurrency counter', () => {
    const html = render({ spec: spec() });
    expect(html).toContain('Rev 2');
    expect(html).not.toMatch(/v7(\.0)?\b/);
    expect(html).not.toContain('Rev 7');
  });

  it('shows the author and the approver by name, and whether the revision is in force', () => {
    const html = render({ spec: spec() });
    expect(html).toContain('Author Ann Analyst');
    expect(html).toContain('Approved by Quinn QA');
    expect(html).toContain('In force');
    expect(render({ spec: spec({ effectiveness: 'Scheduled' }) })).toContain('Approved, not yet in force');
  });

  it('offers a new revision of an Active one, and editing and approval of a Draft', () => {
    expect(render({ spec: spec() })).toContain('New revision');
    const draft = render({ spec: spec({ status: 'Draft', approvedBy: null, effectiveness: 'Draft' }), userId: 'usr-q' });
    expect(draft).toContain('Edit');
    expect(draft).toContain('Approve');
    expect(draft).not.toContain('New revision');
  });

  it('does not offer the approval to the author of the Draft', () => {
    const html = render({ spec: spec({ status: 'Draft', approvedBy: null }), userId: 'usr-a' });
    expect(html).not.toContain('Approve</button>');
    expect(html).toContain('another person must approve it');
  });

  it('offers nothing the user has no permission for', () => {
    const html = render({ spec: spec({ status: 'Draft', approvedBy: null }), userId: 'usr-q', canEdit: false, canApprove: false, canCreate: false });
    expect(html).not.toContain('Edit</button>');
    expect(html).not.toContain('Approve</button>');
  });

  it('says what the approval of a Draft replaces and that samples in progress need a QA exception', () => {
    const html = render({ spec: spec({ status: 'Draft', approvedBy: null, approval: { supersedes: ['SPEC-0'], samplesInProgress: 3 } }), userId: 'usr-q' });
    expect(html).toContain('Approving replaces SPEC-0');
    expect(html).toContain('3 sample(s)');
  });
});

describe('formatLimit', () => {
  it('writes each kind of limit to its declared decimals', () => {
    expect(formatLimit({ name: 'A', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null })).toBe('98.0 - 102.0 %');
    expect(formatLimit({ name: 'B', unit: '%', limit_kind: 'NMT', lower: null, upper: 0.5, decimals: 2, text: null })).toBe('NMT 0.50 %');
    expect(formatLimit({ name: 'C', unit: '', limit_kind: 'NLT', lower: 95, upper: null, decimals: 0, text: null })).toBe('NLT 95');
    expect(formatLimit({ name: 'D', unit: '', limit_kind: 'TEXT', lower: null, upper: null, decimals: null, text: 'White powder' })).toBe('White powder');
  });
  it('writes a limit whose decimals were never declared (v0.1.0) as stored, and the card says so', () => {
    const p = { name: 'Imp', unit: '%', limit_kind: 'RANGE' as const, lower: 0, upper: 0.005, decimals: null, text: null };
    expect(formatLimit(p)).toBe('0 - 0.005 %');
    expect(render({ spec: spec({ parameters: [p] }) })).toContain('decimals not declared');
  });
});
