// Testing starts only on a sample that has been received (roadmap M29; 21 CFR 211.122-211.194, EU GMP Chapter 6): its receipt is
// recorded, and a receipt deviation (temperature out of range, broken seal, damaged container, expired) is acknowledged by QA with a
// signature. A sample received out of temperature must not silently yield reportable data. Listed under 'Testing' in ./index.ts by
// the wave gate.
import { readReceipt, receiptBlocker } from '../../custody/status';
import type { TransitionGuard } from './types';

export const custodyReceived: TransitionGuard = {
  name: 'custody-received',
  async check(ex, sample) {
    return receiptBlocker(sample.id, await readReceipt(ex, sample.id));
  },
};
