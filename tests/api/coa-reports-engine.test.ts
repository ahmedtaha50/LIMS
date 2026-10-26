/**
 * Roadmap M25 (r2-coa-reports): the one document engine (src/server/reports), without the database.
 *
 *   specText        the limit as the certificate prints it (NLT 98.0 %), never "null - null"
 *   conclusionOf    Complies / Does not comply, computed from the evaluation flags; never ALL TESTS PASSED while a flag is true
 *   watermarkFor    derived from the document's state, never chosen by a caller
 *   renderCoaPdf    the PDF from a frozen snapshot: what it prints for each state
 */
import { describe, expect, it } from 'vitest';
import { conclusionOf, renderCoaPdf, specText, watermarkFor, type CoaSnapshot } from '../../src/server/reports';

describe('specText', () => {
  it('prints each limit kind with its decimals and unit as the specification wrote them', () => {
    expect(specText({ limitKind: 'NLT', lower: '98.0', upper: null, unit: '%', text: null })).toBe('NLT 98.0 %');
    expect(specText({ limitKind: 'NMT', lower: null, upper: '0.50', unit: '%', text: null })).toBe('NMT 0.50 %');
    expect(specText({ limitKind: 'RANGE', lower: '98.0', upper: '102.0', unit: '%', text: null })).toBe('98.0 - 102.0 %');
    expect(specText({ limitKind: 'RANGE', lower: '6.5', upper: '7.5', unit: '', text: null })).toBe('6.5 - 7.5');
    expect(specText({ limitKind: 'TEXT', lower: null, upper: null, unit: '', text: 'White crystalline powder' })).toBe('White crystalline powder');
    expect(specText({ limitKind: 'PRESENCE', lower: null, upper: null, unit: '', text: 'Absent in 1 g' })).toBe('Absent in 1 g');
  });
  it('never prints null: a text limit without its text, or a row with no limit at all, says so', () => {
    expect(specText({ limitKind: 'TEXT', lower: null, upper: null, unit: '', text: null })).toBe('As per specification (no text recorded)');
    expect(specText({ limitKind: null, lower: null, upper: null, unit: null, text: null })).toBe('No limit recorded');
    for (const k of ['NLT', 'NMT', 'RANGE'] as const) expect(specText({ limitKind: k, lower: null, upper: null, unit: '%', text: null })).not.toMatch(/null|undefined/);
  });
});

describe('conclusionOf', () => {
  const row = (over: Record<string, unknown>) => ({ parameter: 'Assay', value: '99.0', isOos: false, reported: true, ...over }) as any;
  it('complies only when every reported result is entered and none is out of specification', () => {
    expect(conclusionOf([row({}), row({ parameter: 'Water' })])).toMatchObject({ complies: true, text: expect.stringMatching(/complies with the specification/i) });
  });
  it('does not comply when any reported flag is true, whatever its investigation decided', () => {
    const c = conclusionOf([row({}), row({ parameter: 'Water', isOos: true })]);
    expect(c.complies).toBe(false);
    expect(c.text).toMatch(/does not comply/i);
    expect(c.text).toContain('Water');
    expect(c.text).not.toMatch(/ALL TESTS PASSED/);
  });
  it('an invalidated original row does not decide the conclusion; its reported retest does', () => {
    expect(conclusionOf([row({ value: '95.0', isOos: true, reported: false, kind: 'Original' }), row({ kind: 'Retest' })]).complies).toBe(true);
  });
  it('a missing value is not a pass', () => {
    expect(conclusionOf([row({ value: null })]).complies).toBe(false);
    expect(conclusionOf([]).complies).toBe(false);
  });
});

describe('watermarkFor', () => {
  it('derives the mark from the state of the document', () => {
    expect(watermarkFor('Issued')).toBeNull();
    expect(watermarkFor('Superseded')).toBe('SUPERSEDED');
    expect(watermarkFor('Voided')).toBe('VOID');
    expect(watermarkFor('Preview')).toBe('PREVIEW - NOT ISSUED');
    expect(watermarkFor('Anything else')).toBe('NOT VALID');
  });
});

const snapshot: CoaSnapshot = {
  schema: 1,
  certificate: { number: 'COA-2026-0042', issueVersion: 2, label: 'COA-2026-0042-v2' },
  sample: { id: 'SMP-2026-0100', material: 'Paracetamol 500 mg tablets', batch: 'B-2026-07', state: 'Approved', version: 6, registeredAt: '2026-10-01T08:00:00.000Z' },
  product: { code: 'PCM500', name: 'Paracetamol 500 mg tablets' },
  batch: { batchNo: 'B-2026-07', manufacturedOn: '2026-09-01', expiresOn: '2028-08-31', batchSize: '200 000 tablets' },
  customer: null,
  specification: { id: 'SPEC-1', material: 'Paracetamol 500 mg tablets', revision: 3, effectiveDate: '2026-01-01' },
  results: [
    { resultId: 'r1', parameter: 'Assay', kind: 'Original', reported: false, value: '95.1', unit: '%', specText: 'NLT 98.0 %', isOos: true, conclusion: 'Does not comply', method: { code: 'HPLC-01', revision: 2, title: 'HPLC assay' }, amended: 0, amendments: [], oos: { id: 'OOS-2026-0007', status: 'Closed', decision: 'Invalidated' }, enteredAt: null },
    { resultId: 'r1', parameter: 'Assay', kind: 'Retest', reported: true, value: '99.2', unit: '%', specText: 'NLT 98.0 %', isOos: false, conclusion: 'Complies', method: { code: 'HPLC-01', revision: 2, title: 'HPLC assay' }, amended: 1, amendments: [{ version: 2, code: 'SAMPLE_PREPARATION_ERROR', label: 'Sample preparation error', reason: 'Dilution error; retested', previousValue: '95.1', value: '99.2', at: '2026-10-02T09:00:00.000Z' }], oos: { id: 'OOS-2026-0007', status: 'Closed', decision: 'Invalidated' }, enteredAt: null },
    { resultId: 'r2', parameter: 'Appearance', kind: 'Result', reported: true, value: 'Complies', unit: '', specText: 'White tablet', isOos: false, conclusion: 'Complies', method: null, amended: 0, amendments: [], oos: null, enteredAt: null },
  ],
  conclusion: { complies: true, text: 'The sample complies with the specification (revision 3).' },
  approvals: [{ meaning: 'Approval of results', signerName: 'Rita Reviewer', signerRole: 'Reviewer', timestamp: '2026-10-03T10:00:00.000Z' }],
  supersedes: { id: 'coa-1', label: 'COA-2026-0042-v1', reason: 'Customer order number corrected' },
  issuedAt: '2026-10-04T12:00:00.000Z',
};
const signature = { meaning: 'Authorisation of Certificate of Analysis: I authorise this certificate.', signerName: 'Quinn QA', signerRole: 'QA', timestamp: '2026-10-04T12:00:00.000Z', reason: 'Customer order number corrected' };
/** The text of a PDF as written in its (uncompressed) content streams; PDF string syntax escapes parentheses and backslashes. */
const text = (b: Buffer) => b.toString('latin1').replace(/\\([()\\])/g, '$1');

describe('renderCoaPdf', () => {
  it('prints the certificate from the snapshot: number, spec revision, methods, rows, AMENDED marker, conclusion, signature block in UTC', () => {
    const pdf = renderCoaPdf({ snapshot, signatures: [signature], copy: { copyNo: 1, purpose: 'Original', status: 'Issued', generatedAt: new Date('2026-10-04T12:00:01Z'), generatedByName: 'Quinn QA' } });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const t = text(pdf);
    for (const s of ['COA-2026-0042-v2', 'Revision 3', 'HPLC-01', 'NLT 98.0 %', '95.1', '99.2', 'Retest', 'Original', 'OOS-2026-0007', 'AMENDED(1)',
      'Dilution error; retested', 'Does not comply', 'Complies', '2026-09-01', '2028-08-31', 'Quinn QA', 'Authorisation of Certificate of Analysis',
      '2026-10-04 12:00:00 UTC', 'Supersedes COA-2026-0042-v1', 'Customer order number corrected', 'Copy 1 (Original)']) expect(t, s).toContain(s);
    expect(t).not.toMatch(/SUPERSEDED|VOID|PREVIEW|ALL TESTS PASSED|\(null\)|null - null|undefined/);
  });
  it('a superseded or voided document is marked on every copy; a preview says it is not a certificate', () => {
    expect(text(renderCoaPdf({ snapshot, signatures: [signature], copy: { copyNo: 3, purpose: 'Copy', status: 'Superseded', generatedAt: new Date(), generatedByName: 'A' } }))).toContain('SUPERSEDED');
    expect(text(renderCoaPdf({ snapshot, signatures: [signature], copy: { copyNo: 4, purpose: 'Copy', status: 'Voided', generatedAt: new Date(), generatedByName: 'A' } }))).toContain('VOID');
    const preview = text(renderCoaPdf({ snapshot: { ...snapshot, certificate: null }, signatures: [], copy: null }));
    expect(preview).toContain('PREVIEW - NOT ISSUED');
    expect(preview).toContain('not a Certificate of Analysis');
    expect(preview).not.toContain('COA-2026-0042');
  });
  it('a failing result makes the whole certificate say so', () => {
    const failing: CoaSnapshot = { ...snapshot, results: [{ ...snapshot.results[2], isOos: true, conclusion: 'Does not comply' }], conclusion: { complies: false, text: 'The sample does not comply with the specification: Appearance.' } };
    const t = text(renderCoaPdf({ snapshot: failing, signatures: [signature], copy: { copyNo: 1, purpose: 'Original', status: 'Issued', generatedAt: new Date(), generatedByName: 'Q' } }));
    expect(t).toContain('does not comply');
    expect(t).not.toMatch(/complies with the specification|ALL TESTS PASSED/);
  });
});
