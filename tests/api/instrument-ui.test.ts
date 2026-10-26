/**
 * Roadmap M21 (r2-instrument-integration), the screens: a value waiting for acceptance shows the result it would update and why it
 * cannot be accepted when there is none; a file that could not be read shows the reason in words; a profile that is a Draft says it is
 * not watched, and its author is not offered the approval; the usage log of an instrument lists captures and accepted values.
 * Rendered with react-dom on the server, like tests/api/qms-ui.test.ts; the data flow is covered by instrument-integration.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesTable, ImportValuesTable, ProfilesTable, type CapturedFile, type ImportValue, type Profile } from '../../src/components/ImportsReview';
import { UsageLog } from '../../src/components/Instruments';

const noop = () => {};
const SHA = 'ab'.repeat(32);
const h = (el: React.ReactElement) => renderToStaticMarkup(el);
const values = (rows: ImportValue[], over: Record<string, unknown> = {}) => React.createElement(ImportValuesTable, { rows, canDecide: true, busy: null, onAccept: noop, onReject: noop, ...over });
const profiles = (rows: Profile[], over: Record<string, unknown> = {}) => React.createElement(ProfilesTable, { profiles: rows, canManage: true, canApprove: true, me: 'usr-admin', onEdit: noop, onApprove: noop, onRetire: noop, ...over });
const files = (rows: CapturedFile[]) => React.createElement(FilesTable, { files: rows });
const usage = (entries: any[]) => React.createElement(UsageLog, { entries });

const value = (over: Partial<ImportValue> = {}): ImportValue => ({
  id: 'IMR-1', fileId: 'IMF-1', fileName: 'weigh-001.txt', sha256: SHA, instrumentId: 'INST-1', lineNo: 4, sampleRef: 'SMP-1', parameter: 'Weight', value: '12.3456', unit: 'g',
  state: 'Pending', version: 1, match: { resultId: 'res-1', sampleId: 'SMP-1', value: null, version: 1, unit: 'g', sampleState: 'Testing' }, ...over,
});

describe('values waiting', () => {
  it('shows the captured value, its file and the result it would update, with Accept and Reject for an analyst', () => {
    const html = h(values([value()]));
    expect(html).toContain('12.3456 g');
    expect(html).toContain('weigh-001.txt, line 4');
    expect(html).toContain('abababababab');
    expect(html).toContain('not entered');
    expect(html).toContain('>Accept<');
    expect(html).toContain('>Reject<');
  });
  it('says why a value without a matching result cannot be accepted here, and who decides', () => {
    const html = h(values([value({ match: null, sampleRef: null })], { canDecide: false }));
    expect(html).toContain('no sample named');
    expect(html).toContain('No result named');
    expect(html).toContain('Analysts decide');
    expect(html).not.toContain('>Accept<');
  });
  it('does not offer Accept for a sample that is not in Testing, and says so', () => {
    const v = value({ match: { resultId: 'res-1', sampleId: 'SMP-1', value: '99.0', version: 2, unit: 'g', sampleState: 'Pending Review' } });
    const html = h(values([v]));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Accept<\/button>/);
    expect(html).toContain('results are entered while it is in Testing');
    expect(h(values([]))).toContain('No captured value is waiting for acceptance.');
  });
});

describe('files', () => {
  const file = (over: Partial<CapturedFile> = {}): CapturedFile => ({
    id: 'IMF-1', fileName: 'ph.csv', sha256: SHA, bytes: 90, parseStatus: 'Parsed', parseError: null, rowCount: 2, disposition: 'Processed', dispositionNote: 'Moved to processed/.',
    receivedAt: '2026-10-20T08:00:00.000Z', source: 'watch', profileName: 'pH meter', instrumentName: 'pH 1', instrumentId: 'INST-2', pendingRows: 1, ...over,
  });
  it('shows the full sha256 and how many values wait', () => {
    const html = h(files([file()]));
    expect(html).toContain(SHA);
    expect(html).toContain('2 value(s), 1 waiting');
    expect(html).toContain('watch folder');
  });
  it('shows the reason in words when a file could not be read', () => {
    const html = h(files([file({ parseStatus: 'Failed', parseError: 'Line 2: the pH "seven" is not a number.', rowCount: 0, disposition: 'Error' })]));
    expect(html).toContain('Failed');
    expect(html).toContain('Line 2: the pH &quot;seven&quot; is not a number.');
    expect(h(files([]))).toContain('No instrument file has been captured yet.');
  });
});

describe('profiles', () => {
  const profile = (over: Partial<Profile> = {}): Profile => ({
    id: 'IPR-1', name: 'Balance 1', instrumentId: 'INST-1', instrumentName: 'Balance 1', parser: 'balance-text', watchDir: '/data/balance', glob: '*.txt', mapping: { parameter: 'Weight' },
    status: 'Draft', version: 1, createdBy: 'usr-qa', approvedBy: null, ...over,
  });
  it('a Draft is not watched, and its author is not offered the approval', () => {
    const own = h(profiles([profile()], { me: 'usr-qa' }));
    expect(own).toContain('Not watched until approved.');
    expect(own).toContain('Another person approves what you wrote.');
    expect(own).not.toContain('Approve…');
    const other = h(profiles([profile()], { canManage: false }));
    expect(other).toContain('Approve…');
    expect(other).not.toContain('>Edit<');
  });
  it('an approved profile can be edited (which withdraws the approval) but not approved again', () => {
    const html = h(profiles([profile({ status: 'Approved', approvedBy: 'usr-admin', version: 2 })]));
    expect(html).toContain('>Edit<');
    expect(html).not.toContain('Approve…');
    expect(html).toContain('/data/balance');
  });
});

describe('the usage log', () => {
  it('lists captures and accepted values with the person, and says when there are none', () => {
    const html = h(usage([
      { id: 'u2', event: 'ResultAccepted', at: '2026-10-20T08:05:00.000Z', fileName: 'weigh-001.txt', sampleId: 'SMP-1', userName: 'Test Analyst One' },
      { id: 'u1', event: 'DataCaptured', at: '2026-10-20T08:00:00.000Z', fileName: 'weigh-001.txt', sampleId: null, userName: 'Scheduler (service principal)' },
    ]));
    expect(html).toContain('value accepted (weigh-001.txt), sample SMP-1, Test Analyst One');
    expect(html).toContain('file captured (weigh-001.txt), Scheduler (service principal)');
    expect(h(usage([]))).toContain('No data has been captured from this instrument yet.');
  });
});
