/**
 * Legal states and moves of the records that are signed or closed (roadmap M09). One definition, used by the guards in front of
 * the routes (src/server/authz/stateGuard.ts) and by any code that changes a status: call assertTransition(entity, from, to)
 * inside the transaction that writes it.
 *
 * A TERMINAL state is final: the record is frozen, and any attempt to change it answers 423 (Locked). Any other move that is not
 * listed is 409 (Conflict): the record is not where the caller thought it was. A status is never edited directly; it moves when
 * the route that signs for it runs (closing an OOS, approving a specification, signing a worksheet, releasing a batch).
 *
 * The sample lifecycle has its own table (src/server/workflow/transitions.ts); its owner (r1-results-oos) may fold it in here.
 * `oos` lists both 'Approved' (the word the code uses today for a closed investigation) and 'Closed' (the word the roadmap moves
 * to), so the rename needs no change to this file.
 */
import { AppError } from '../http/errors';

export type EntityType = 'oos' | 'specification' | 'batchRelease' | 'eln' | 'instrument';

export interface StateMachine {
  states: readonly string[];
  /** The state of a new record (for a batch: of one that has no release record yet). */
  initial: string;
  /** Final. No move out, no edit. */
  terminal: readonly string[];
  transitions: Readonly<Record<string, readonly string[]>>;
  /** The states in which the record's fields may still be edited or the record may be acted on (calibrated, signed). */
  editable: readonly string[];
}

export const ENTITY_STATES: Readonly<Record<EntityType, StateMachine>> = {
  oos: {
    states: ['Open', 'Approved', 'Closed'],
    initial: 'Open',
    terminal: ['Approved', 'Closed'],
    transitions: { Open: ['Approved', 'Closed'] },
    editable: ['Open'],
  },
  specification: {
    states: ['Draft', 'Active', 'Obsolete'],
    initial: 'Draft',
    terminal: ['Obsolete'],
    transitions: { Draft: ['Active'], Active: ['Obsolete'] },
    editable: ['Draft'], // an Active specification is approved and effective: it is replaced by a new version, not edited
  },
  batchRelease: {
    states: ['Quarantine Hold', 'Released', 'Rejected'],
    initial: 'Quarantine Hold',
    terminal: ['Released', 'Rejected'],
    transitions: { 'Quarantine Hold': ['Released', 'Rejected'] },
    editable: [],
  },
  eln: {
    states: ['Draft', 'Signed'],
    initial: 'Draft',
    terminal: ['Signed'],
    transitions: { Draft: ['Signed'] },
    editable: ['Draft'],
  },
  instrument: {
    states: ['Active', 'In Calibration', 'Out of Service', 'Retired'],
    initial: 'Active',
    terminal: ['Retired'],
    transitions: {
      'Active': ['In Calibration', 'Out of Service', 'Retired'],
      'In Calibration': ['Active', 'Out of Service', 'Retired'],
      'Out of Service': ['Active', 'In Calibration', 'Retired'],
    },
    editable: ['Active', 'In Calibration', 'Out of Service'],
  },
};

const LABEL: Record<EntityType, string> = {
  oos: 'The OOS investigation',
  specification: 'The specification',
  batchRelease: 'The batch',
  eln: 'The notebook worksheet',
  instrument: 'The instrument',
};

/** 423: the record is final or not in a state that allows the action. */
export class RecordLockedError extends AppError {
  constructor(message: string) { super(423, 'RECORD_LOCKED', message); }
}
/** 409: the move is not one of the record's legal moves. */
export class IllegalTransitionError extends AppError {
  constructor(message: string) { super(409, 'ILLEGAL_TRANSITION', message); }
}

export const isTerminal = (entity: EntityType, state: string): boolean => ENTITY_STATES[entity].terminal.includes(state);

export const canTransition = (entity: EntityType, from: string, to: string): boolean => (ENTITY_STATES[entity].transitions[from] ?? []).includes(to);

/** Throws 423 when `from` is final, 409 when the move is not a legal one. */
export function assertTransition(entity: EntityType, from: string, to: string): void {
  if (isTerminal(entity, from)) {
    throw new RecordLockedError(`${LABEL[entity]} is ${from} and final: it cannot be changed to ${to}.`);
  }
  if (!canTransition(entity, from, to)) {
    throw new IllegalTransitionError(`${LABEL[entity]} is ${from}; it cannot go to ${to}.`);
  }
}

/** Throws 423 unless the record is in a state that still allows editing or acting on it. */
export function assertEditable(entity: EntityType, state: string): void {
  if (!ENTITY_STATES[entity].editable.includes(state)) {
    throw new RecordLockedError(`${LABEL[entity]} is ${state} and locked: it can no longer be edited.`);
  }
}
