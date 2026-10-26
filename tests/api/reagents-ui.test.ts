/**
 * Roadmap M30 (r2-reagents), the screens. Rendered on the server with react-dom (no browser), like tests/api/docs-training-ui.test.ts;
 * the data flow is covered by tests/api/reagents.test.ts.
 *
 *   * the lot register shows the status, the last day of use (in-use expiry or expiry), the balance and the server's verdict for results;
 *   * the steps offered for a lot follow its status, and release or rejection is never offered to the person who received it;
 *   * the material picker of result entry offers expired, quarantined and retest-overdue material DISABLED, with the server's reason;
 *   * the sample screen's panel lists each result's lots, with withdrawn links struck through;
 *   * the receipt screen no longer posts to the legacy register (it receives lots).
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LotTable, MaterialLinkList, MaterialSelect, lotActions, type LotRow, type MaterialLink, type MaterialOption } from '../../src/components/Reagents';

const noop = () => {};
const lot = (over: Partial<LotRow>): LotRow => ({
  id: 'RL-000001', itemId: 'RI-1', itemCode: 'MEOH', itemName: 'Methanol HPLC', category: 'Solvent', lotNumber: 'M-4471', supplier: 'Merck',
  coaReference: null, receivedQuantity: 1000, unit: 'mL', expiryDate: '2027-06-30', retestDate: null, potency: null, potencyBasis: null,
  storageLocation: null, status: 'InUse', receivedBy: 'usr-analyst1', receivedAt: '2026-10-01T08:00:00Z', releasedBy: 'usr-qa', openedAt: '2026-10-02T08:00:00Z',
  inUseExpiry: '2026-11-01', balance: 940, useUntil: '2026-11-01', usable: true, blockedReason: null, version: 3, ...over,
});
const material = (over: Partial<MaterialOption>): MaterialOption => ({
  id: 'RL-000001', kind: 'lot', label: 'Reagent lot RL-000001 (Methanol HPLC, supplier lot M-4471)', name: 'Methanol HPLC', lotNumber: 'M-4471',
  status: 'InUse', unit: 'mL', useUntil: '2026-11-01', usable: true, blockedReason: null, balance: 940, ...over,
});

describe('the lot register', () => {
  it('shows status, use limit, balance and why a lot may not be used', () => {
    const html = renderToStaticMarkup(React.createElement(LotTable, {
      lots: [lot({}), lot({ id: 'RL-000002', status: 'Quarantine', usable: false, inUseExpiry: null, useUntil: '2027-06-30', blockedReason: 'Reagent lot RL-000002 (Methanol HPLC, supplier lot M-9) is in Quarantine (received 2026-10-20): it has not been released for use.' })],
      onSelect: noop,
    }));
    expect(html).toContain('RL-000001');
    expect(html).toContain('In use');
    expect(html).toContain('2026-11-01');
    expect(html).toContain('in-use expiry (expiry 2027-06-30)');
    expect(html).toContain('940 mL');
    expect(html).toContain('Usable');
    expect(html).toContain('Quarantine (received 2026-10-20)');
    expect(renderToStaticMarkup(React.createElement(LotTable, { lots: [], onSelect: noop }))).toContain('No reagent lots');
  });
});

describe('the steps offered for a lot', () => {
  const all = { approve: true, use: true };
  it('release and rejection only to an approver who did not receive it; opening a released lot; consumption of an open one', () => {
    expect(lotActions(lot({ status: 'Quarantine' }), { id: 'usr-qa' }, all)).toEqual(['release', 'reject', 'retest', 'traceback']);
    expect(lotActions(lot({ status: 'Quarantine' }), { id: 'usr-analyst1' }, all)).toEqual(['retest', 'traceback']); // the receiver
    expect(lotActions(lot({ status: 'Quarantine' }), { id: 'usr-analyst2' }, { approve: false, use: true })).toEqual(['traceback']);
    expect(lotActions(lot({ status: 'Approved' }), { id: 'usr-analyst2' }, { approve: false, use: true })).toEqual(['open', 'dispose', 'traceback']);
    expect(lotActions(lot({ status: 'InUse' }), { id: 'usr-analyst2' }, { approve: false, use: true })).toEqual(['consume', 'dispose', 'traceback']);
    for (const status of ['Expired', 'Rejected', 'Consumed', 'Disposed']) expect(lotActions(lot({ status }), { id: 'usr-qa' }, all)).toEqual(['traceback']);
  });
});

describe('the material picker of result entry', () => {
  it('offers expired and quarantined material disabled, with the server\'s reason; usable material shows its limit and balance', () => {
    const html = renderToStaticMarkup(React.createElement(MaterialSelect, {
      value: '', onChange: noop,
      materials: [
        material({}),
        material({ id: 'RL-000007', usable: false, status: 'Expired', blockedReason: 'Reagent lot RL-000007 (Buffer salt, supplier lot B-1) expired on 2026-10-01.' }),
        material({ id: 'RL-000008', usable: false, status: 'Quarantine', blockedReason: 'Reagent lot RL-000008 (Acetonitrile, supplier lot A-2) is in Quarantine (received 2026-10-20): it has not been released for use.' }),
        material({ id: 'PS-000003', kind: 'solution', name: '0.1 M HCl', lotNumber: null, useUntil: '2026-10-30', balance: 250 }),
      ],
    }));
    const options = [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(m => ({ attrs: m[1], text: m[2] }));
    const of = (id: string) => options.find(o => o.attrs.includes(`value="${id}"`))!;
    expect(of('RL-000001').attrs).not.toContain('disabled');
    expect(of('RL-000001').text).toContain('until 2026-11-01, 940 mL left');
    expect(of('RL-000007').attrs).toContain('disabled');
    expect(of('RL-000007').text).toContain('expired on 2026-10-01');
    expect(of('RL-000008').attrs).toContain('disabled');
    expect(of('RL-000008').text).toContain('Quarantine (received 2026-10-20)');
    expect(of('PS-000003').attrs).not.toContain('disabled');
  });
});

describe('the materials panel of the sample screen', () => {
  const l = (over: Partial<MaterialLink>): MaterialLink => ({
    id: 'RM-1', resultId: 'R-1', materialId: 'RL-000001', label: 'Reagent lot RL-000001 (Methanol HPLC, supplier lot M-4471)', quantity: 5,
    linkedAt: '2026-10-20T08:00:00Z', linkedBy: 'usr-analyst1', withdrawnAt: null, withdrawReason: null, usable: true, blockedReason: null, useUntil: '2026-11-01', ...over,
  });
  it('lists each result with its lots, strikes withdrawn links through and shows a lot that is blocked now', () => {
    const html = renderToStaticMarkup(React.createElement(MaterialLinkList, {
      links: [l({}), l({ id: 'RM-2', withdrawnAt: '2026-10-21T08:00:00Z', withdrawReason: 'wrong bottle' }), l({ id: 'RM-3', usable: false, blockedReason: 'Reagent lot RL-000001 was Rejected on 2026-10-22: it must not be used.' })],
      parameters: { 'R-1': 'Assay (%)' }, canWithdraw: true, onWithdraw: noop,
    }));
    expect(html).toContain('Assay (%)');
    expect(html).toContain('usable until 2026-11-01');
    expect(html).toContain('line-through');
    expect(html).toContain('withdrawn: wrong bottle');
    expect(html).toContain('Rejected on 2026-10-22');
    expect(html.match(/>Withdraw</g)).toHaveLength(2); // not for the link already withdrawn
  });

  it('the receipt screen receives lots (POST /reagent-lots), not entries of the legacy register', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/components/Reagents.tsx'), 'utf8');
    expect(src).toContain("apiFetch('/reagent-lots', { body })");
    expect(src).not.toMatch(/fetch\('\/api\/reagents', \{\s*method: 'POST'/);
    expect(src).not.toMatch(/window\.(alert|prompt)\(/);
  });
});
