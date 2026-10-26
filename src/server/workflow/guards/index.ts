/**
 * The guard registry of the sample lifecycle (roadmap M10). Owned by r1-results-oos.
 *
 * The rules that must hold before a sample enters a state, keyed by the state it moves to. They run twice: before the signature is
 * asked for (a refused move costs the signer no attempt), and again inside the transaction that writes the move (nothing changed in
 * between). A failed guard is a 400 that says what is missing.
 *
 * To add a rule: a file in this directory exporting a TransitionGuard, and its name in the list of the target state below.
 */
import { AppError } from '../../http/errors';
import type { Executor } from '../../core/tx';
import { custodyReceived } from './custody';
import { noOpenOos } from './noOpenOos';
import { oosVocabulary } from './oos';
import { resultsComplete } from './resultsComplete';
import { sstPassed } from './sst';
import { reviewChecklistGuard } from '../../review';
import { unacceptedImports } from '../../connectors/guards';
import type { GuardedSample, TransitionGuard } from './types';

export type { GuardedSample, TransitionGuard } from './types';

export const TRANSITION_GUARDS: Readonly<Record<string, readonly TransitionGuard[]>> = {
  // custody-received: r2-custody-labels (roadmap M29), testing starts only on a received sample whose receipt deviation, if any, QA signed.
  'Testing': [custodyReceived],
  // unaccepted-imports: r2-instrument-integration (roadmap M21), captured instrument values that name the sample must be accepted or rejected first.
  'Pending Review': [resultsComplete, sstPassed, unacceptedImports],
  // review-checklist: r2-raw-data (roadmap M20), the server items of the review checklist (src/server/review.ts).
  // oos-vocabulary: r2-oos-workflow (roadmap M26), a status, phase or decision outside the OOS vocabulary blocks (src/server/oos/vocabulary.ts).
  'Approved': [resultsComplete, sstPassed, noOpenOos, oosVocabulary, reviewChecklistGuard],
};

export class TransitionBlockedError extends AppError {
  constructor(message: string, details: Array<{ guard: string; message: string }>) { super(400, 'TRANSITION_BLOCKED', message, details); }
}

/** Throws 400 TRANSITION_BLOCKED listing every guard of `to` that is not met. */
export async function assertTransitionGuards(ex: Executor, sample: GuardedSample, to: string): Promise<void> {
  const failures: Array<{ guard: string; message: string }> = [];
  for (const guard of TRANSITION_GUARDS[to] ?? []) {
    const message = await guard.check(ex, sample);
    if (message) failures.push({ guard: guard.name, message });
  }
  if (failures.length) throw new TransitionBlockedError(failures.map(f => f.message).join(' '), failures);
}
