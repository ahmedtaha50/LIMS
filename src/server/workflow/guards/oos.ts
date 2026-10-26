// A sample is approved only when every OOS investigation of it speaks the OOS vocabulary (roadmap M26): a status, phase or decision
// outside it cannot be interpreted, so it blocks (fail closed). Listed under 'Approved' in ./index.ts by the wave gate.
import { findOosVocabularyProblems } from '../../oos/vocabulary';
import type { TransitionGuard } from './types';

export const oosVocabulary: TransitionGuard = {
  name: 'oos-vocabulary',
  async check(ex, sample) {
    const problems = await findOosVocabularyProblems(ex, [sample.id]);
    return problems.length ? `Approval blocked: ${problems.join(' ')}` : null;
  },
};
