/**
 * Roadmap M25 (r2-coa-reports), the screens. Rendered on the server with react-dom (no browser), like tests/api/qms-ui.test.ts.
 *
 *   CoaPanel     what a sample's certificate panel offers: issue only when the server says the sample is eligible and the user holds
 *                coa.issue, re-issue and void of the current document, the register of versions with their state, copies and verify;
 *   Reports.tsx  no client-side certificate generator, and no document status a user can pick: the watermark of a client export is
 *                fixed (Uncontrolled Copy), a certificate comes only from the server.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoaActions, CoaDocumentTable, type CoaDocumentRow, type CoaEligibility } from '../../src/components/CoaPanel';

const noop = () => {};
const doc = (over: Partial<CoaDocumentRow>): CoaDocumentRow => ({
  id: 'coa-1', sampleId: 'SMP-2026-0001', number: 'COA-2026-0007', issueVersion: 1, label: 'COA-2026-0007-v1', status: 'Issued', version: 2,
  issuedBy: 'usr-qa', issuedAt: '2026-10-04T12:00:00.000Z', supersedesId: null, supersededById: null, supersededReason: null, voidReason: null,
  pdfSha256: 'a'.repeat(64), originalRunId: 'run-1', specRevision: 3, signatures: [{ id: 'sig-1', meaningCode: 'COA_AUTHORISATION', meaning: 'Authorisation of Certificate of Analysis', signerName: 'Quinn QA', signerRole: 'QA', timestamp: '2026-10-04T12:00:00.000Z', reason: '' }],
  ...over,
});
const eligibility = (over: Partial<CoaEligibility>): CoaEligibility => ({ sampleId: 'SMP-2026-0001', state: 'Approved', eligible: true, problems: [], current: null, documents: [], ...over });

describe('the actions of the certificate panel', () => {
  it('offers issue to the quality unit when the server says the sample is eligible', () => {
    const html = renderToStaticMarkup(React.createElement(CoaActions, { info: eligibility({}), canIssue: true, busy: false, onIssue: noop, onReissue: noop, onVoid: noop }));
    expect(html).toContain('Issue certificate (sign)');
    expect(html).not.toContain('Re-issue');
  });
  it('shows what blocks the issue and offers nothing to sign', () => {
    const html = renderToStaticMarkup(React.createElement(CoaActions, {
      info: eligibility({ eligible: false, state: 'Testing', problems: [{ check: 'state', message: 'The sample is Testing; a certificate is issued only for an Approved sample.' }] }),
      canIssue: true, busy: false, onIssue: noop, onReissue: noop, onVoid: noop,
    }));
    expect(html).toContain('The sample is Testing');
    expect(html).not.toContain('(sign)');
  });
  it('without coa.issue there is nothing to sign, only an explanation', () => {
    const html = renderToStaticMarkup(React.createElement(CoaActions, { info: eligibility({}), canIssue: false, busy: false, onIssue: noop, onReissue: noop, onVoid: noop }));
    expect(html).not.toContain('(sign)');
    expect(html).toMatch(/quality unit/i);
  });
  it('with a current certificate offers re-issue and void instead of issue', () => {
    const current = doc({});
    const html = renderToStaticMarkup(React.createElement(CoaActions, { info: eligibility({ current, documents: [current] }), canIssue: true, busy: false, onIssue: noop, onReissue: noop, onVoid: noop }));
    expect(html).toContain('Re-issue (sign)');
    expect(html).toContain('Void (sign)');
    expect(html).not.toContain('Issue certificate (sign)');
  });
});

describe('the register of versions', () => {
  it('lists each version with its state, the supersede reason, and the signature block', () => {
    const html = renderToStaticMarkup(React.createElement(CoaDocumentTable, {
      documents: [doc({ id: 'coa-2', issueVersion: 2, label: 'COA-2026-0007-v2', supersedesId: 'coa-1' }),
        doc({ status: 'Superseded', supersededById: 'coa-2', supersededReason: 'Customer name corrected' })],
      onCopy: noop, onVerify: noop,
    }));
    expect(html).toContain('COA-2026-0007-v2');
    expect(html).toContain('Superseded');
    expect(html).toContain('Customer name corrected');
    expect(html).toContain('Quinn QA');
    expect(html).toContain('2026-10-04 12:00:00 UTC');
    expect(html.match(/Controlled copy/g)).toHaveLength(2);
  });
  it('says so when there is no certificate', () => {
    expect(renderToStaticMarkup(React.createElement(CoaDocumentTable, { documents: [], onCopy: noop, onVerify: noop }))).toContain('No certificate has been issued');
  });
});

describe('src/components/Reports.tsx', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/Reports.tsx'), 'utf8');
  it('has no client-side certificate generator and no Approved stamp computed in the browser', () => {
    expect(source).not.toMatch(/generateBatchReport|Batch Certification Report|coaCertification/);
    expect(source).not.toMatch(/'Approved' : 'Draft/);
  });
  it('lets nobody pick the status a document is stamped with', () => {
    expect(source).not.toMatch(/setReportStatus|reportStatus/);
    expect(source).not.toMatch(/Document Status/);
  });
  it('draws its tables with the autoTable function (doc.autoTable does not exist in a bundled application)', () => {
    expect(source).not.toMatch(/\(doc as any\)\.autoTable\(/);
  });
  it('lists issued certificates from the server register instead', () => {
    expect(source).toContain('/coa/documents');
  });
});
