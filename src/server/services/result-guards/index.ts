/**
 * The result-guard registry (roadmap M10). Owned by r1-results-oos.
 *
 * Rules a result must satisfy before it is saved, beyond its value: they run inside the result's transaction, after the value has
 * been evaluated, and a failed guard is a 400 with its reason. To add a rule: one entry in RESULT_GUARDS.
 */
import { eq } from 'drizzle-orm';
import { instruments } from '../../../db/schema';
import { calibrationState } from '../../../lib/validations/instruments';
import type { Executor } from '../../core/tx';
import { BadRequestError } from '../../http/errors';
import { assignedAnalyst } from './assignment';
import { calculatedInput, methodEffective } from './method';
import { qualificationRequired } from './qualification';
import { reagentLotsUsable } from './reagent';
import { sstNotFailed } from './sst';

export interface ResultGuardInput {
  sampleId: string;
  resultId: string;
  instrumentId?: string;
  /** The person entering the value (req.user): the qualification guard checks their training (r2-docs-training). */
  userId?: string;
  now: Date;
}

export interface ResultGuard {
  name: string;
  /** Returns null when the rule is met, or the reason it is not. */
  check(ex: Executor, input: ResultGuardInput): Promise<string | null>;
}

/** The instrument a result was measured on must exist, be Active and be within its calibration (calibrationState: the shared rule). */
const calibratedInstrument: ResultGuard = {
  name: 'calibrated-instrument',
  async check(ex, { instrumentId, now }) {
    if (!instrumentId) return null;
    const [inst] = await ex.select().from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
    if (!inst) return `Invalid Instrument ID: ${instrumentId} does not exist.`;
    if (inst.status !== 'Active') return `GxP Violation: Instrument ${inst.id} is currently ${inst.status}. Only Active instruments can be used.`;
    if (calibrationState(inst.calibrationDueDate, now).expired) {
      return `GxP Violation: Instrument ${inst.id} (${inst.name}) is past its calibration due date (${inst.calibrationDueDate}). Testing is blocked.`;
    }
    return null;
  },
};

// assignment: r2-worklists (M33): only the analyst assigned on a Released worklist enters the result (403 NOT_ASSIGNED).
// method-effective, calculated-input and sst-not-failed: r2-methods-calc (roadmap M18). qualification: r2-docs-training (M28); it
// refuses with its own 403 QUALIFICATION_REQUIRED instead of a reason. reagent-lots: r2-reagents (M30).
export const RESULT_GUARDS: readonly ResultGuard[] = [assignedAnalyst, calibratedInstrument, methodEffective, calculatedInput, sstNotFailed, qualificationRequired, reagentLotsUsable];

export async function assertResultGuards(ex: Executor, input: ResultGuardInput): Promise<void> {
  for (const guard of RESULT_GUARDS) {
    const reason = await guard.check(ex, input);
    if (reason) throw new BadRequestError(reason, [{ path: guard.name, message: reason }]);
  }
}
