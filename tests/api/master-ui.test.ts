/**
 * Roadmap M17 (r2-master-data), the screens: registration picks a product and then one of its batches and shows the specification in
 * force; the batch table offers only the status moves the server allows; the traceability screen offers the batches that exist,
 * never a fixed list, and names no person or product the records do not hold. Rendered on the server with react-dom (no browser),
 * like tests/api/spec-ui.test.ts; the data flow is covered by master-data.test.ts.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RegisterSampleForm, registrableBatches, type RegisterSampleFormProps } from '../../src/components/RegisterSampleDialog';
import { BatchTable, nextBatchStatuses, type BatchRow } from '../../src/components/MasterData';
import { MasterBatchPanel } from '../../src/components/Traceability';

const noop = () => {};
const form = (over: Partial<RegisterSampleFormProps> = {}) => renderToStaticMarkup(React.createElement(RegisterSampleForm, {
  products: [{ id: 'P1', code: 'PARA500', name: 'Paracetamol 500 mg', status: 'Active' }, { id: 'P2', code: 'OLD', name: 'Old product', status: 'Inactive' }],
  customers: [{ id: 'C1', code: 'NILE', name: 'Nile Pharmacies', status: 'Active' }],
  productId: 'P1',
  batches: [
    { id: 'B1', batchNo: 'LOT-001', status: 'Quarantine', manufacturedOn: '2026-09-01', expiresOn: '2028-08-31' },
    { id: 'B2', batchNo: 'LOT-002', status: 'Rejected', manufacturedOn: null, expiresOn: null },
    { id: 'B3', batchNo: 'LOT-003', status: 'Released', manufacturedOn: null, expiresOn: null },
  ],
  batchId: 'B1', customerId: '',
  activeSpec: { id: 'SPEC-1', revision: 2, effectiveDate: '2026-01-01', parameters: ['Assay', 'Dissolution'] },
  onProduct: noop, onBatch: noop, onCustomer: noop, onSubmit: noop, onClose: noop, ...over,
}));

describe('the registration form', () => {
  it('offers active products and only the batches a sample may be registered against', () => {
    const html = form();
    expect(html).toContain('Paracetamol 500 mg (PARA500)');
    expect(html).not.toContain('Old product');
    expect(html).toContain('LOT-001 (Quarantine, expires 2028-08-31)');
    expect(html).toContain('LOT-003 (Released)');
    expect(html).not.toContain('LOT-002');
    expect(registrableBatches([{ id: 'x', batchNo: 'x', status: 'Recalled', manufacturedOn: null, expiresOn: null }])).toEqual([]);
  });

  it('shows the specification revision in force and what the sample will be recorded as; nothing is typed free-hand', () => {
    const html = form();
    expect(html).toContain('specification SPEC-1, Rev 2');
    expect(html).toContain('Assay, Dissolution');
    expect(html).toContain('material “Paracetamol 500 mg”, batch “LOT-001”');
    expect(html).not.toMatch(/<input[^>]*type="text"/);
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled="")/);
  });

  it('says why registration is not possible without a specification in force, and does not offer the button', () => {
    const html = form({ activeSpec: null });
    expect(html).toContain('No Active specification is in force for Paracetamol 500 mg');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });
});

describe('the batch table', () => {
  const row = (status: string): BatchRow => ({
    id: `B-${status}`, productId: 'P1', productName: 'Paracetamol 500 mg', batchNo: `LOT-${status}`, status, manufacturedOn: null, expiresOn: '2028-08-31',
    batchSize: null, origin: 'entry', version: 1,
  });

  it('offers only the moves the server allows, and none without the signing permission', () => {
    expect(nextBatchStatuses('Quarantine')).toEqual(['Released', 'Rejected']);
    expect(nextBatchStatuses('Released')).toEqual(['Recalled']);
    expect(nextBatchStatuses('Rejected')).toEqual([]);
    const html = renderToStaticMarkup(React.createElement(BatchTable, { batches: [row('Quarantine'), row('Recalled')], canSign: true, onStatus: noop }));
    expect(html).toContain('>Released</button>');
    expect(html).toContain('>Rejected</button>');
    expect(html).not.toContain('>Recalled</button>');
    expect(html).toContain('not recorded'); // an unknown date is said to be unknown, not invented
    const readOnly = renderToStaticMarkup(React.createElement(BatchTable, { batches: [row('Quarantine')], canSign: false, onStatus: noop }));
    expect(readOnly).not.toContain('</button>');
  });
});

describe('the traceability screen', () => {
  it('has no fixed batch numbers and no invented person in its source', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/components/Traceability.tsx'), 'utf8');
    expect(src).not.toMatch(/BATCH-2026-00\d/);
    expect(src).not.toContain('Dr. Sarah Jenkins');
  });

  it('shows the master record of the batch, and says so when there is none', () => {
    const html = renderToStaticMarkup(React.createElement(MasterBatchPanel, { master: [
      { id: 'PB-1', productName: 'Paracetamol 500 mg', batchNo: 'LOT-001', status: 'Quarantine', manufacturedOn: '2026-09-01', expiresOn: null, batchSize: '500 kg' },
    ] }));
    expect(html).toContain('Paracetamol 500 mg');
    expect(html).toContain('Batch LOT-001: Quarantine');
    expect(html).toContain('Manufactured 2026-09-01, expires not recorded, size 500 kg');
    expect(renderToStaticMarkup(React.createElement(MasterBatchPanel, { master: [] }))).toContain('No master batch record');
  });
});
