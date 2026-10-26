/**
 * Roadmap M27 (r2-qms), the screen: the record list flags overdue records, the steps offered are exactly the server's `nextMoves`
 * (signed steps marked, quality-unit steps hidden from other roles), and an Open action past its due date shows Overdue. Rendered on
 * the server with react-dom (no browser), like tests/api/master-ui.test.ts; the data flow is covered by tests/api/qms.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionTable, NextMoves, PayloadFields, RecordTable, type NextMove, type QmsActionRow, type QmsRecordRow } from '../../src/components/Qms';

const noop = () => {};
const rec = (over: Partial<QmsRecordRow>): QmsRecordRow => ({
  id: 'DEV-2026-0001', type: 'Deviation', title: 'Balance used out of calibration', description: '', classification: 'Major', state: 'Investigation',
  ownerId: 'usr-analyst1', dueDate: '2026-10-01', payload: {}, origin: 'manual', createdBy: 'usr-analyst1', version: 3,
  overdue: false, editable: true, final: false, nextMoves: [], ...over,
});
const act = (over: Partial<QmsActionRow>): QmsActionRow => ({
  id: 'CAPA-2026-0001-A1', recordId: 'CAPA-2026-0001', title: 'Retrain', description: '', ownerId: 'usr-analyst1', dueDate: '2026-10-01',
  status: 'Open', evidenceRef: null, completedBy: null, version: 1, overdue: false, ...over,
});

describe('the record list', () => {
  it('shows number, type, classification and state, and flags an overdue record', () => {
    const html = renderToStaticMarkup(React.createElement(RecordTable, {
      records: [rec({ overdue: true }), rec({ id: 'CC-2026-0001', type: 'ChangeControl', classification: null, state: 'Approved' })], onSelect: noop,
    }));
    expect(html).toContain('DEV-2026-0001');
    expect(html).toContain('Change control');
    expect(html).toContain('not classified');
    expect(html.match(/Overdue/g)).toHaveLength(1);
    expect(renderToStaticMarkup(React.createElement(RecordTable, { records: [], onSelect: noop }))).toContain('No quality records match.');
  });
});

describe('the next steps', () => {
  const moves: NextMove[] = [
    { to: 'CAPA Proposed', signed: false, meaningCode: null, qa: false, reasonRequired: false },
    { to: 'QA Approved', signed: true, meaningCode: 'QMS_APPROVAL', qa: false, reasonRequired: false },
    { to: 'Draft', signed: false, meaningCode: null, qa: true, reasonRequired: true },
  ];
  it('offers the quality unit every step the server allows, signed ones marked', () => {
    const html = renderToStaticMarkup(React.createElement(NextMoves, { moves, canApprove: true, onMove: noop }));
    expect(html).toContain('CAPA Proposed');
    expect(html).toContain('QA Approved (sign)');
    expect(html).toContain('>Draft<');
  });
  it('hides signed and quality-unit steps from other roles', () => {
    const html = renderToStaticMarkup(React.createElement(NextMoves, { moves, canApprove: false, onMove: noop }));
    expect(html).toContain('CAPA Proposed');
    expect(html).not.toContain('QA Approved');
    expect(html).not.toContain('>Draft<');
    expect(renderToStaticMarkup(React.createElement(NextMoves, { moves: [moves[1]], canApprove: false, onMove: noop }))).toContain('No step available to you');
  });
});

describe('the actions', () => {
  it('flags an Open action past its due date, and offers completion only to its owner or the quality unit', () => {
    const actions = [act({ overdue: true }), act({ id: 'A2', ownerId: 'usr-analyst2' }), act({ id: 'A3', status: 'Done', evidenceRef: 'TR-77' })];
    const owner = renderToStaticMarkup(React.createElement(ActionTable, { actions, me: 'usr-analyst1', canApprove: false, onComplete: noop, onCancel: noop }));
    expect(owner.match(/Overdue/g)).toHaveLength(1);
    expect(owner.match(/>Complete</g)).toHaveLength(1);
    expect(owner).not.toContain('>Cancel<');
    expect(owner).toContain('TR-77');
    const qa = renderToStaticMarkup(React.createElement(ActionTable, { actions, me: 'usr-qa', canApprove: true, onComplete: noop, onCancel: noop }));
    expect(qa.match(/>Complete</g)).toHaveLength(2);
    expect(qa.match(/>Cancel</g)).toHaveLength(2);
  });
});

describe('the payload editor', () => {
  it('offers every field of the type: choices as selects and the emergency flag of a change control as a checkbox', () => {
    const cc = renderToStaticMarkup(React.createElement(PayloadFields, { type: 'ChangeControl', value: { emergency: true, changeType: 'Specification' }, disabled: false, onChange: noop }));
    expect(cc).toMatch(/<select[^>]*>.*Specification.*Role.*Document/s);
    expect(cc).toMatch(/type="checkbox"[^>]*checked/);
    expect(cc).toContain('Emergency change');
    const capa = renderToStaticMarkup(React.createElement(PayloadFields, { type: 'CAPA', value: {}, disabled: false, onChange: noop }));
    expect(capa).toMatch(/<select[^>]*>.*Corrective.*Preventive/s);
    expect(capa).toContain('Effectiveness criteria');
  });
});
