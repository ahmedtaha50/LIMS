/**
 * The lifecycles of the four quality record types (roadmap M27). One table per type: the states, which are final, in which states
 * the record's content (title, description, classification, payload) may still be edited, and every legal move with what it needs.
 *
 *   sign    the move is an e-signature with this meaning (POST /qms/records/:id/sign); without it the move is a plain step
 *           (POST /qms/records/:id/transition) that needs a reason only when `reason` is set
 *   qa      only a holder of qms.approve may make the move (triage, sending back)
 *   rule    what the record must satisfy before the move (src/server/qms/rules.ts); checked again inside the transaction
 *
 * A final state answers 423 (Locked) to every change, any other illegal move 409, like src/server/workflow/entityStates.ts.
 * The content is frozen once a record leaves its editable states, because the approval signature covers it (src/server/qms/entities.ts).
 */
import { AppError } from '../http/errors';

export type QmsType = 'Deviation' | 'CAPA' | 'ChangeControl' | 'AuditFinding';

export type QmsMeaning = 'QMS_APPROVAL' | 'QMS_CLOSURE' | 'QMS_REJECTION' | 'QMS_EMERGENCY_CHANGE';

export type RuleName =
  | 'classified'            // a classification is set
  | 'rootCause'             // payload.rootCause is filled in
  | 'minorOnly'             // Major and Critical need the CAPA path
  | 'linkedCapa'            // at least one linked CAPA that is not cancelled
  | 'linkedCapaIfSerious'   // Major / Critical: at least one linked CAPA that is not cancelled
  | 'capasClosed'           // every linked CAPA that is not cancelled is Closed (each was closed on an effective check)
  | 'actionsFinished'       // no action of the record is still Open
  | 'hasDoneAction'         // at least one action was completed
  | 'capaPlan'              // payload.plan and payload.effectivenessCriteria are filled in, and there is at least one action
  | 'effective'             // the latest effectiveness check found the CAPA effective
  | 'impactAssessed'        // payload.impactAssessment is filled in
  | 'emergency'             // payload.emergency is true
  | 'response';             // payload.response is filled in

export interface Move {
  from: string;
  to: string;
  sign?: QmsMeaning;
  qa?: boolean;
  reason?: boolean;
  rules?: RuleName[];
}

export interface Lifecycle {
  prefix: string;
  initial: string;
  terminal: readonly string[];
  /** States in which title, description, classification and payload may still change. */
  editable: readonly string[];
  moves: readonly Move[];
}

export const LIFECYCLES: Readonly<Record<QmsType, Lifecycle>> = {
  Deviation: {
    prefix: 'DEV',
    initial: 'Draft',
    terminal: ['Closed', 'Cancelled'],
    editable: ['Draft', 'QA Triage', 'Investigation', 'CAPA Proposed'],
    moves: [
      { from: 'Draft', to: 'QA Triage' },
      { from: 'QA Triage', to: 'Investigation', qa: true, rules: ['classified'] },
      { from: 'QA Triage', to: 'Draft', qa: true, reason: true },
      { from: 'Investigation', to: 'CAPA Proposed', rules: ['classified', 'rootCause', 'linkedCapa'] },
      // A Minor deviation may be approved without a CAPA; a Major or Critical one goes through CAPA Proposed.
      { from: 'Investigation', to: 'QA Approved', sign: 'QMS_APPROVAL', rules: ['classified', 'rootCause', 'minorOnly'] },
      { from: 'CAPA Proposed', to: 'Investigation', qa: true, reason: true },
      { from: 'CAPA Proposed', to: 'QA Approved', sign: 'QMS_APPROVAL', rules: ['classified', 'rootCause', 'linkedCapa'] },
      { from: 'QA Approved', to: 'Implementation' },
      { from: 'QA Approved', to: 'Closed', sign: 'QMS_CLOSURE', rules: ['minorOnly', 'actionsFinished'] },
      { from: 'Implementation', to: 'Effectiveness Check', rules: ['actionsFinished'] },
      { from: 'Effectiveness Check', to: 'Implementation', qa: true, reason: true },
      { from: 'Effectiveness Check', to: 'Closed', sign: 'QMS_CLOSURE', rules: ['actionsFinished', 'linkedCapaIfSerious', 'capasClosed'] },
      { from: 'Draft', to: 'Cancelled', sign: 'QMS_REJECTION' },
      { from: 'QA Triage', to: 'Cancelled', sign: 'QMS_REJECTION' },
    ],
  },
  CAPA: {
    prefix: 'CAPA',
    initial: 'Draft',
    terminal: ['Closed', 'Cancelled'],
    editable: ['Draft'],
    moves: [
      { from: 'Draft', to: 'Approved', sign: 'QMS_APPROVAL', rules: ['capaPlan'] },
      { from: 'Approved', to: 'Implementation' },
      { from: 'Implementation', to: 'Effectiveness Check', rules: ['actionsFinished', 'hasDoneAction'] },
      // A check that finds the CAPA not effective sends it back to Implementation (src/server/qms/engine.ts recordEffectiveness).
      { from: 'Effectiveness Check', to: 'Implementation', qa: true, reason: true },
      { from: 'Effectiveness Check', to: 'Closed', sign: 'QMS_CLOSURE', rules: ['actionsFinished', 'effective'] },
      { from: 'Draft', to: 'Cancelled', sign: 'QMS_REJECTION' },
    ],
  },
  ChangeControl: {
    prefix: 'CC',
    initial: 'Draft',
    terminal: ['Closed', 'Rejected'],
    editable: ['Draft', 'Under Review'],
    moves: [
      { from: 'Draft', to: 'Under Review' },
      { from: 'Under Review', to: 'Draft', qa: true, reason: true },
      { from: 'Under Review', to: 'Approved', sign: 'QMS_APPROVAL', rules: ['classified', 'impactAssessed'] },
      // The emergency path: one QA signature, before the review, with a reason; reviewed retrospectively before closure.
      { from: 'Draft', to: 'Approved', sign: 'QMS_EMERGENCY_CHANGE', rules: ['emergency'] },
      { from: 'Approved', to: 'Implemented', rules: ['actionsFinished'] },
      { from: 'Implemented', to: 'Closed', sign: 'QMS_CLOSURE', rules: ['actionsFinished'] },
      { from: 'Draft', to: 'Rejected', sign: 'QMS_REJECTION' },
      { from: 'Under Review', to: 'Rejected', sign: 'QMS_REJECTION' },
    ],
  },
  AuditFinding: {
    prefix: 'AF',
    initial: 'Draft',
    terminal: ['Closed', 'Cancelled'],
    editable: ['Draft', 'Open'],
    moves: [
      { from: 'Draft', to: 'Open', rules: ['classified'] },
      { from: 'Open', to: 'Response Submitted', rules: ['response'] },
      { from: 'Response Submitted', to: 'Open', qa: true, reason: true },
      { from: 'Response Submitted', to: 'Closed', sign: 'QMS_CLOSURE', rules: ['linkedCapaIfSerious', 'actionsFinished'] },
      { from: 'Draft', to: 'Cancelled', sign: 'QMS_REJECTION' },
      { from: 'Open', to: 'Cancelled', sign: 'QMS_REJECTION' },
    ],
  },
};

export const QMS_TYPE_LIST = Object.keys(LIFECYCLES) as QmsType[];
export const isQmsType = (v: unknown): v is QmsType => typeof v === 'string' && (QMS_TYPE_LIST as string[]).includes(v);

export class RecordLockedError extends AppError {
  constructor(message: string) { super(423, 'RECORD_LOCKED', message); }
}

export const isTerminal = (type: QmsType, state: string) => LIFECYCLES[type].terminal.includes(state);
export const isEditable = (type: QmsType, state: string) => LIFECYCLES[type].editable.includes(state);
export const movesFrom = (type: QmsType, state: string) => LIFECYCLES[type].moves.filter(m => m.from === state);

/** 423 when the record is final. */
export function assertNotTerminal(type: QmsType, id: string, state: string): void {
  if (isTerminal(type, state)) throw new RecordLockedError(`${id} is ${state} and final: it can no longer be changed.`);
}

/** 423 when the record's content is frozen (final, or past its approval). */
export function assertContentEditable(type: QmsType, id: string, state: string): void {
  assertNotTerminal(type, id, state);
  if (!isEditable(type, state)) {
    throw new RecordLockedError(`${id} is ${state}: its content was approved and is frozen. Raise a new record or a change control instead.`);
  }
}

/** The legal move from `from` to `to`, or 423 / 409. `signed` says which route the caller came through. */
export function findMove(type: QmsType, id: string, from: string, to: string, signed: boolean): Move {
  assertNotTerminal(type, id, from);
  const move = LIFECYCLES[type].moves.find(m => m.from === from && m.to === to);
  if (!move) {
    const legal = movesFrom(type, from).map(m => m.to);
    throw new AppError(409, 'ILLEGAL_TRANSITION', `${id} is ${from}; it cannot go to ${to}.${legal.length ? ` Possible next states: ${legal.join(', ')}.` : ''}`, { legal });
  }
  if (!!move.sign !== signed) {
    throw new AppError(400, signed ? 'SIGNATURE_NOT_APPLICABLE' : 'SIGNATURE_REQUIRED', signed
      ? `${from} to ${to} is not a signed step. Use the transition action.`
      : `${from} to ${to} needs an electronic signature.`);
  }
  return move;
}
