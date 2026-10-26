/**
 * Roadmap M26 (r2-oos-workflow), the screen: due date and overdue, the checklist tasks, the retest plan and its count, the closure
 * decisions and what still stands in their way, and the AI checklist shown as an optional, labelled suggestion that is never merged
 * into the record by itself. Rendered with react-dom on the server (no browser); the data flow is covered by oos-workflow.test.ts.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiSuggestionPanel, DueBadge, RetestSummary, TaskList, closureProblems, type OosDetail } from '../../src/components/OOSInvestigations';
import { OOS_CLOSURE_DECISIONS } from '../../src/lib/validations/oos';

const noop = () => {};
const base = (over: Partial<OosDetail> = {}): OosDetail => ({
  id: 'OOS-2026-00001', sampleId: 'SMP-1', resultId: 'res-1', parameter: 'Assay (%)', dateRaised: '2026-10-01', status: 'Open', phase: 'Phase I',
  stage: 'Phase I', assignedTo: 'usr-analyst2', rootCause: null, conclusion: null, version: 3, decision: null,
  dueDate: '2026-10-11', overdue: false, phase2StartedAt: null, assignableCauseCategory: null, assignableCause: null, assignableCauseBy: null,
  invalidatedBy: null, invalidatedAt: null, originalAnalystIds: ['usr-analyst1'], investigatorIds: ['usr-analyst2'], tasks: [], retestPlan: null, retests: [], deviations: [], ...over,
});

describe('due date', () => {
  it('shows the due date, and Overdue only when the server says so', () => {
    expect(renderToStaticMarkup(React.createElement(DueBadge, { dueDate: '2026-10-11', overdue: false }))).toContain('Due 2026-10-11');
    const late = renderToStaticMarkup(React.createElement(DueBadge, { dueDate: '2026-10-11', overdue: true }));
    expect(late).toContain('Overdue');
    expect(late).toContain('2026-10-11');
  });
});

describe('tasks', () => {
  it('lists each task with its status and finding, and offers completion only on open tasks', () => {
    const html = renderToStaticMarkup(React.createElement(TaskList, {
      tasks: [
        { id: 'T1', phase: 'Phase I', title: 'Calculations verified', status: 'Done', finding: 'Recalculated: no error', ownerId: null, dueDate: null, version: 2, completedBy: 'usr-analyst2' },
        { id: 'T2', phase: 'Phase I', title: 'Instrument calibration checked', status: 'Open', finding: null, ownerId: 'usr-analyst2', dueDate: '2026-10-05', version: 1, completedBy: null },
      ],
      canEdit: true, onComplete: noop,
    }));
    expect(html).toContain('Calculations verified');
    expect(html).toContain('Recalculated: no error');
    expect(html.match(/Complete/g)).toHaveLength(1);
    expect(renderToStaticMarkup(React.createElement(TaskList, { tasks: [], canEdit: true, onComplete: noop }))).toContain('No tasks yet');
  });
});

describe('retests', () => {
  it('shows the plan, its basis and how many of the allowed retests are used', () => {
    const html = renderToStaticMarkup(React.createElement(RetestSummary, {
      plan: { id: 'P1', basis: 'Assignable cause', justification: 'Second analyst, same solution', maxRetests: 2, approvedBy: 'usr-qa', approvedAt: '2026-10-02T10:00:00Z' },
      retests: [{ id: 'X1', seq: 1, value: '99.5', isOos: false, analystId: 'usr-analyst2', recordedAt: '2026-10-03T10:00:00Z', reason: 'r' }],
    }));
    expect(html).toContain('1 of 2 retests');
    expect(html).toContain('Assignable cause');
    expect(html).toContain('99.5');
    expect(renderToStaticMarkup(React.createElement(RetestSummary, { plan: null, retests: [] }))).toContain('No retest is authorised');
  });
});

describe('closure', () => {
  it('offers the three decisions of the vocabulary', () => {
    expect([...OOS_CLOSURE_DECISIONS]).toEqual(['Confirmed OOS', 'Inconclusive', 'Invalidated']);
  });
  it('explains what an Invalidated closure still needs, and that Confirmed OOS needs Phase II', () => {
    expect(closureProblems(base(), 'Invalidated', 'usr-qa').join(' ')).toMatch(/assignable cause/i);
    const confirmed = base({ invalidatedBy: 'usr-qa', invalidatedAt: '2026-10-02T10:00:00Z', assignableCause: 'Wrong flask' });
    expect(closureProblems(confirmed, 'Invalidated', 'usr-qa').join(' ')).toMatch(/retest/i);
    expect(closureProblems({ ...confirmed, retests: [{ id: 'X1', seq: 1, value: '99.5', isOos: false, analystId: 'usr-analyst2', recordedAt: '', reason: '' }] }, 'Invalidated', 'usr-qa')).toEqual([]);
    const oosRetest = { id: 'X0', seq: 1, value: '97.0', isOos: true, analystId: 'usr-analyst2', recordedAt: '', reason: '' };
    expect(closureProblems({ ...confirmed, retests: [oosRetest, { ...oosRetest, id: 'X1', seq: 2, value: '99.5', isOos: false }] }, 'Invalidated', 'usr-qa').join(' ')).toMatch(/retest 1 .*OOS/i);
    expect(closureProblems(base(), 'Confirmed OOS', 'usr-qa').join(' ')).toMatch(/Phase II/);
    expect(closureProblems(base({ phase2StartedAt: '2026-10-02T10:00:00Z', assignedTo: 'usr-qa' }), 'Confirmed OOS', 'usr-qa').join(' ')).toMatch(/investigator/i);
    expect(closureProblems(base({ phase2StartedAt: '2026-10-02T10:00:00Z', tasks: [{ id: 'T', phase: 'Phase II', title: 't', status: 'Open', finding: null, ownerId: null, dueDate: null, version: 1, completedBy: null }] }), 'Inconclusive', 'usr-qa').join(' ')).toMatch(/task/i);
  });
});

describe('the AI checklist', () => {
  it('is an optional suggestion, labelled as such, that the person chooses to copy into the draft', () => {
    const html = renderToStaticMarkup(React.createElement(AiSuggestionPanel, {
      result: { rootCauseConclusion: 'Possible dilution error', correctiveActions: ['Retrain'], preventativeActions: ['Two-person check'] }, onUse: noop, onDismiss: noop,
    }));
    expect(html).toContain('AI suggestion');
    expect(html).toMatch(/not part of the record/i);
    expect(html).toContain('Possible dilution error');
  });
  it('is never merged into the root cause or opened for closure without the person choosing to', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/components/OOSInvestigations.tsx'), 'utf8');
    expect(src).not.toMatch(/setClosingOOS\(selectedOOSForAI\)/);
    expect(src).not.toContain("toast('Applied AI Findings to Investigation'");
  });
});
