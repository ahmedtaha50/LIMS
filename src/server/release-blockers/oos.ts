/**
 * Release blocker of the OOS workflow (roadmap M26): a batch is not released while an OOS investigation of one of its samples has a
 * status, phase or decision outside the OOS vocabulary (src/server/oos/vocabulary.ts). Owned by r2-oos-workflow; listed in
 * RELEASE_BLOCKERS (./index.ts) by the wave gate.
 */
import { findOosVocabularyProblems } from '../oos/vocabulary';
import type { ReleaseBlocker } from './index';

export const oosVocabularyReleaseBlocker: ReleaseBlocker = {
  name: 'oos-vocabulary',
  async check(ex, _batch, batchSamples) {
    return findOosVocabularyProblems(ex, batchSamples.map(s => s.id));
  },
};
