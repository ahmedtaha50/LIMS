/**
 * Roadmap M28 (r2-docs-training), the screens. Rendered on the server with react-dom (no browser), like tests/api/qms-ui.test.ts;
 * the data flow is covered by docs-lifecycle.test.ts and training-qualification.test.ts.
 *
 *   * the document register shows each document's Effective revision and the open one, and flags an overdue periodic review;
 *   * the steps offered for a version are the ones its state allows to this user (the server checks again);
 *   * the training matrix flags Overdue assignments, offers "read and understood" only to the trainee and on-the-job certification
 *     only to a trainer who is not the trainee;
 *   * the screen no longer offers "Certify" as a way to switch on signing for any module: the LIMS curriculum is named.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentTable, availableSteps, type DocumentRow, type VersionRow } from '../../src/components/Documents';
import { AssignmentTable, QualificationTable, type AssignmentRow } from '../../src/components/Training';

const noop = () => {};
const ver = (over: Partial<VersionRow>): VersionRow => ({
  id: 'DV-1', documentId: 'DOC-1', revision: 1, title: 'Balance SOP', changeSummary: '', status: 'Draft', fileName: 'sop.pdf', mediaType: 'application/pdf',
  bytes: 10, fileSha256: 'a'.repeat(64), authorId: 'usr-analyst1', reviewerId: null, approverId: null, effectiveBy: null, effectiveAt: null, version: 1, ...over,
});
const doc = (over: Partial<DocumentRow>): DocumentRow => ({
  id: 'DOC-1', code: 'SOP-QC-001', title: 'Balance SOP', docType: 'SOP', reviewPeriodMonths: 24, version: 1,
  effective: ver({ status: 'Effective' }), open: null, reviewDue: '2027-01-01', reviewOverdue: false, ...over,
});
const asg = (over: Partial<AssignmentRow>): AssignmentRow => ({
  id: 'TA-1', userId: 'usr-analyst1', userName: 'Analyst One', curriculumId: 'CUR-1', curriculumTitle: 'HPLC analyst', documentId: 'DOC-1',
  documentVersionId: 'DV-1', documentTitle: 'Balance SOP', revision: 1, trainingMethod: 'READ_AND_UNDERSTOOD', dueDate: '2026-10-01',
  status: 'Assigned', overdue: false, completedAt: null, completedBy: null, trainerId: null, version: 1, ...over,
});

describe('the document register', () => {
  it('shows the Effective revision, the open one and an overdue periodic review', () => {
    const html = renderToStaticMarkup(React.createElement(DocumentTable, {
      documents: [doc({ reviewOverdue: true }), doc({ id: 'DOC-2', code: 'SOP-QC-002', effective: null, open: ver({ id: 'DV-9', revision: 1, status: 'InReview' }) })],
      onSelect: noop,
    }));
    expect(html).toContain('SOP-QC-001');
    expect(html).toContain('Rev 1');
    expect(html).toContain('In review');
    expect(html.match(/Review overdue/g)).toHaveLength(1);
    expect(html).toContain('none effective');
    expect(renderToStaticMarkup(React.createElement(DocumentTable, { documents: [], onSelect: noop }))).toContain('No controlled documents');
  });
});

describe('the steps offered for a version', () => {
  const perms = { author: true, review: true, approve: true };
  it('offers submission to the author only, review and approval to independent people, effectivity to QA only', () => {
    expect(availableSteps(ver({}), { id: 'usr-analyst1', role: 'Analyst' }, { ...perms, review: false, approve: false })).toEqual(['edit', 'upload', 'submit']);
    expect(availableSteps(ver({}), { id: 'usr-analyst2', role: 'Analyst' }, { ...perms, review: false, approve: false })).toEqual([]); // only the author edits a Draft
    expect(availableSteps(ver({ status: 'InReview' }), { id: 'usr-analyst1', role: 'QA' }, perms)).toEqual([]);
    expect(availableSteps(ver({ status: 'InReview' }), { id: 'usr-reviewer', role: 'Reviewer' }, { ...perms, approve: false })).toEqual(['review', 'return']);
    expect(availableSteps(ver({ status: 'InReview', reviewerId: 'usr-reviewer' }), { id: 'usr-admin', role: 'Admin' }, perms)).toEqual(['approve', 'return']);
    expect(availableSteps(ver({ status: 'InReview', reviewerId: 'usr-qa' }), { id: 'usr-qa', role: 'QA' }, perms)).toEqual(['return']);
    expect(availableSteps(ver({ status: 'Approved', reviewerId: 'usr-reviewer', approverId: 'usr-admin' }), { id: 'usr-qa', role: 'QA' }, perms)).toEqual(['effective', 'return']);
    expect(availableSteps(ver({ status: 'Approved', reviewerId: 'usr-reviewer', approverId: 'usr-admin' }), { id: 'usr-admin', role: 'Admin' }, perms)).toEqual(['return']);
    expect(availableSteps(ver({ status: 'Effective' }), { id: 'usr-qa', role: 'QA' }, perms)).toEqual(['print', 'obsolete']);
    expect(availableSteps(ver({ status: 'Superseded' }), { id: 'usr-qa', role: 'QA' }, perms)).toEqual([]);
  });
});

describe('the training matrix', () => {
  it('flags Overdue and offers read-and-understood to the trainee, OJT certification to another trainer', () => {
    const rows = [
      asg({ overdue: true, status: 'Overdue' }),
      asg({ id: 'TA-2', userId: 'usr-analyst2', userName: 'Analyst Two' }),
      asg({ id: 'TA-3', trainingMethod: 'OJT' }),
      asg({ id: 'TA-4', status: 'Completed', completedAt: '2026-10-02T10:00:00.000Z', completedBy: 'usr-analyst1' }),
    ];
    const mine = renderToStaticMarkup(React.createElement(AssignmentTable, { assignments: rows, me: 'usr-analyst1', canCertify: false, onAcknowledge: noop, onCertify: noop }));
    expect(mine.match(/>Overdue</g)).toHaveLength(1);
    expect(mine.match(/Read and understood/g)?.length).toBeGreaterThanOrEqual(1);
    expect(mine.match(/<button[^>]*>Sign read and understood<\/button>/g)).toHaveLength(1);
    expect(mine).not.toContain('Certify OJT');

    const trainer = renderToStaticMarkup(React.createElement(AssignmentTable, { assignments: rows, me: 'usr-qa', canCertify: true, onAcknowledge: noop, onCertify: noop }));
    expect(trainer.match(/<button[^>]*>Certify OJT<\/button>/g)).toHaveLength(1);
    expect(trainer).not.toContain('Sign read and understood');
    const self = renderToStaticMarkup(React.createElement(AssignmentTable, { assignments: [asg({ trainingMethod: 'OJT', userId: 'usr-qa' })], me: 'usr-qa', canCertify: true, onAcknowledge: noop, onCertify: noop }));
    expect(self).not.toContain('Certify OJT');
  });

  it('shows each method qualification, an override flagged with its end date', () => {
    const html = renderToStaticMarkup(React.createElement(QualificationTable, {
      rows: [
        { methodCode: 'HPLC-ASSAY', status: 'Qualified', overdue: [], overrideId: null, overrideUntil: null },
        { methodCode: 'KF-WATER', status: 'NotQualified', overdue: ['TA-9'], overrideId: null, overrideUntil: null },
        { methodCode: 'DISSO', status: 'Override', overdue: ['TA-7'], overrideId: 'AQ-1', overrideUntil: '2026-10-25' },
      ],
    }));
    expect(html).toContain('HPLC-ASSAY');
    expect(html).toContain('Not qualified');
    expect(html).toContain('QA override until 2026-10-25');
  });
});
