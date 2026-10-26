// A sample is approved only when every OOS result has a closed investigation and no investigation of the sample is still open
// (21 CFR 211.192: an unexplained discrepancy is investigated before the batch is released; FDA OOS guidance, 2022).
import { findOosBlockers } from '../../release-blockers';
import type { TransitionGuard } from './types';

export const noOpenOos: TransitionGuard = {
  name: 'no-open-oos',
  async check(ex, sample) {
    const problems = await findOosBlockers(ex, [sample.id]);
    return problems.length ? `Approval blocked: ${problems.join(' ')}` : null;
  },
};
