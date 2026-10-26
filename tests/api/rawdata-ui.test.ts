/**
 * Roadmap M20 (r2-raw-data), the screens: the attachment list shows each file's sha256 and size, the review checklist shows every
 * server item with its state and why it failed, and the result history shows each version's coded reason, with the QA signature a
 * reintegration needs (offered only to someone who may sign it and did not make it). Rendered with react-dom on the server, like
 * tests/api/qms-ui.test.ts; the data flow is covered by the rawdata-* API tests.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentList, formatBytes, type AttachmentRow } from '../../src/components/AttachmentPanel';
import { ChecklistItems, VersionTable, type ChecklistItem, type ResultVersionRow } from '../../src/components/ReviewChecklist';

const noop = () => {};
const SHA = 'ab'.repeat(32);

describe('the attachment list', () => {
  const row: AttachmentRow = {
    id: 'att-1', sampleId: 'SMP-1', resultId: 'res-1', fileName: 'HPLC run 42.pdf', mediaType: 'application/pdf', kind: 'pdf',
    bytes: 20 * 1024 * 1024, sha256: SHA, uploadedBy: 'usr-analyst1', uploadedAt: '2026-10-20T08:00:00.000Z', description: null,
  };
  it('shows the name, the size, the full sha256 and the result it belongs to', () => {
    const html = renderToStaticMarkup(React.createElement(AttachmentList, { attachments: [row], parameters: { 'res-1': 'Assay' }, onDownload: noop }));
    expect(html).toContain('HPLC run 42.pdf');
    expect(html).toContain('20.0 MB');
    expect(html).toContain(SHA);
    expect(html).toContain('Assay');
    expect(renderToStaticMarkup(React.createElement(AttachmentList, { attachments: [], parameters: {}, onDownload: noop }))).toContain('No raw data files attached.');
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('the checklist', () => {
  const items: ChecklistItem[] = [
    { code: 'RESULTS_ENTERED', label: 'All results entered', status: 'pass', detail: '1 of 1 entered.' },
    { code: 'RAW_DATA_ATTACHED', label: 'Raw data attached for every instrument result', status: 'fail', detail: 'No raw data file for: Assay.' },
    { code: 'REINTEGRATIONS_APPROVED', label: 'Every reintegration signed by QA', status: 'na', detail: 'No reintegration.' },
  ];
  it('marks each item and says why a failed one failed', () => {
    const html = renderToStaticMarkup(React.createElement(ChecklistItems, { items }));
    expect(html).toContain('All results entered');
    expect(html).toContain('No raw data file for: Assay.');
    expect(html.match(/data-status="fail"/g)).toHaveLength(1);
    expect(html.match(/data-status="na"/g)).toHaveLength(1);
    expect(html).toContain('Not applicable');
  });
});

describe('the result history', () => {
  const v = (over: Partial<ResultVersionRow>): ResultVersionRow => ({
    id: 'rv-1', resultId: 'res-1', parameter: 'Assay', resultVersion: 2, value: '99.1', previousValue: null, isOos: false,
    changeCode: 'INITIAL_ENTRY', reason: 'routine entry', enteredBy: 'usr-analyst1', enteredAt: '2026-10-20T08:00:00.000Z', reintegrationSignature: null, ...over,
  });
  const rows = [v({}), v({ id: 'rv-2', resultVersion: 3, value: '99.6', previousValue: '99.1', changeCode: 'REINTEGRATION', reason: 'baseline corrected' })];
  it('shows the coded reason of each version and flags an unsigned reintegration', () => {
    const html = renderToStaticMarkup(React.createElement(VersionTable, { versions: rows, canSign: false, me: 'usr-reviewer', onSign: noop }));
    expect(html).toContain('First entry');
    expect(html).toContain('Reintegration');
    expect(html).toContain('99.1 → 99.6');
    expect(html).toContain('QA signature required');
    expect(html).not.toContain('Sign reintegration');
  });
  it('offers the signature to the quality unit, except to the person who reintegrated', () => {
    expect(renderToStaticMarkup(React.createElement(VersionTable, { versions: rows, canSign: true, me: 'usr-qa', onSign: noop }))).toContain('Sign reintegration');
    expect(renderToStaticMarkup(React.createElement(VersionTable, { versions: rows, canSign: true, me: 'usr-analyst1', onSign: noop }))).not.toContain('Sign reintegration');
    const signed = [rows[0], { ...rows[1], reintegrationSignature: { id: 'sig-1', signerId: 'usr-qa', signerName: 'Test QA Officer', timestamp: '2026-10-20T09:00:00.000Z' } }];
    const html = renderToStaticMarkup(React.createElement(VersionTable, { versions: signed, canSign: true, me: 'usr-qa', onSign: noop }));
    expect(html).toContain('Signed by Test QA Officer');
    expect(html).not.toContain('Sign reintegration');
  });
});
