/**
 * Roadmap M18 (r2-methods-calc), the screens: methods and formulas are shown by revision and status, the author is not offered the
 * approval, Effective records are not offered for editing, the formula editor shows the inputs, the test cases and the functions the
 * server allows, and a specification parameter shows its method, formula, replicates and stage. Rendered on the server with
 * react-dom (no browser), like tests/api/spec-ui.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormulaEditor, type FormulaDraft } from '../../src/components/FormulaEditor';
import { ConfigCard, type ConfigView } from '../../src/components/Methods';
import { SpecificationCard, type SpecView } from '../../src/components/Specifications';
import { ALLOWED_FUNCTIONS } from '../../src/server/lib/calc';

const record = (over: Partial<ConfigView> = {}): ConfigView => ({
  id: 'MTH-1', code: 'HPLC-ASSAY-01', title: 'Assay by HPLC', revision: 2, status: 'Effective', version: 5,
  createdBy: 'usr-a', approvedBy: 'usr-q', createdByName: 'Ann Analyst', approvedByName: 'Quinn QA', approvedAt: '2026-10-01T10:00:00.000Z', ...over,
});
const card = (props: Partial<React.ComponentProps<typeof ConfigCard>> = {}) =>
  renderToStaticMarkup(React.createElement(ConfigCard, { record: record(), kind: 'Method', canEdit: true, canApprove: true, onEdit() {}, onRevise() {}, onApprove() {}, ...props }));

describe('a method or formula card', () => {
  it('shows the revision, not the concurrency counter, and who wrote and approved it', () => {
    const html = card();
    expect(html).toContain('Rev 2');
    expect(html).not.toContain('Rev 5');
    expect(html).toContain('Ann Analyst');
    expect(html).toContain('Quinn QA');
    expect(html).toContain('Effective');
  });

  it('offers a new revision of an Effective record and no editing of it', () => {
    const html = card();
    expect(html).toContain('New revision');
    expect(html).not.toContain('Edit</button>');
    expect(html).not.toContain('Approve</button>');
  });

  it('offers editing and approval of a Draft, but not the approval to its author', () => {
    const draft = record({ status: 'Draft', approvedBy: null, approvedByName: null, approvedAt: null });
    const other = card({ record: draft, userId: 'usr-q' });
    expect(other).toContain('Edit</button>');
    expect(other).toContain('Approve</button>');
    const author = card({ record: draft, userId: 'usr-a' });
    expect(author).not.toContain('Approve</button>');
    expect(author).toContain('another person must approve it');
    expect(card({ record: draft, userId: 'usr-q', canEdit: false, canApprove: false })).not.toMatch(/(Edit|Approve)<\/button>/);
  });
});

describe('the formula editor', () => {
  const draft: FormulaDraft = {
    code: 'RSD-AREA', name: '%RSD of peak areas', expression: 'rsd(x)', unit: '%',
    inputs: [{ name: 'x', label: 'Peak areas', unit: '', replicates: true }],
    testCases: [{ name: 'Six injections', inputs: { x: [1000, 1010, 990, 1005, 995, 1000] }, decimals: 2, expected: '0.71' }],
  };
  it('shows the expression, the declared inputs, the test cases and the allowed functions', () => {
    const html = renderToStaticMarkup(React.createElement(FormulaEditor, { value: draft, onChange() {} }));
    expect(html).toContain('rsd(x)');
    expect(html).toContain('Peak areas');
    expect(html).toContain('Six injections');
    expect(html).toContain('0.71');
    for (const fn of ALLOWED_FUNCTIONS) expect(html).toContain(fn);
  });
});

describe('a specification parameter bound to a method', () => {
  it('shows the method, the formula, the replicates and the stage', () => {
    const spec: SpecView = {
      id: 'SPEC-1', material: 'Paracetamol 500 mg', revisionLabel: 1, version: 3, effectiveDate: '2026-11-01', status: 'Active',
      parameters: [{ name: 'Assay', unit: '%', limit_kind: 'RANGE', lower: 98, upper: 102, decimals: 1, text: null, method_code: 'HPLC-ASSAY-01', formula_code: 'ASSAY-EXT-STD', replicates: 2, stage: 'Release' }],
      createdBy: 'usr-a', approvedBy: 'usr-q', effectiveness: 'Effective',
    };
    const html = renderToStaticMarkup(React.createElement(SpecificationCard, { spec, canEdit: true, canCreate: true, canApprove: true }));
    expect(html).toContain('HPLC-ASSAY-01');
    expect(html).toContain('ASSAY-EXT-STD');
    expect(html).toContain('n = 2');
    expect(html).toContain('Release');
  });
});
