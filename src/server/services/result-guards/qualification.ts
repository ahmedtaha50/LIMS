/**
 * Result guard QUALIFICATION_REQUIRED (roadmap M28). Owned by r2-docs-training; registered in ./index.ts (RESULT_GUARDS).
 *
 * A result of a parameter bound to a method (the specification parameter's method_code, ./method.ts) is entered only by a user who is
 * qualified for that method: no overdue assignment of a mandatory curriculum of the method (src/server/training/status.ts). An
 * unqualified user is refused with 403 QUALIFICATION_REQUIRED, naming the method and the overdue training; nothing is written.
 * While an Active QA override (signed QUALIFICATION_OVERRIDE, time-limited) covers today, the entry is allowed and flagged: an audit
 * entry QualificationOverrideUsed on the result, written in the result's transaction, names the override.
 * Unbound parameters, and methods no curriculum names, pass as before.
 */
import { writeAudit } from '../../../db/utils';
import { AppError } from '../../http/errors';
import { todayIso } from '../../lib/specs';
import { qualificationFor } from '../../training/status';
import type { ResultGuard, ResultGuardInput } from './index';
import { bindingOfResult } from './method';

export const qualificationRequired: ResultGuard = {
  name: 'qualification',
  // `userId` is in ResultGuardInput once the gate patch adds it; spelled out here so this file type-checks on its own as well.
  async check(ex, input: ResultGuardInput & { userId?: string }) {
    const b = await bindingOfResult(ex, input.resultId);
    if (!b?.methodCode) return null;
    // saveResult passes the person entering the value; without it the rule cannot be checked, so the entry is refused.
    if (!input.userId) return `${b.parameter}: the qualification for method ${b.methodCode} cannot be checked without the analyst.`;
    const q = await qualificationFor(ex, input.userId, b.methodCode, todayIso(input.now));
    if (q.status === 'Qualified') return null;
    if (q.status === 'Override') {
      await writeAudit(ex, input.userId, 'QualificationOverrideUsed', 'Result', input.resultId, 'qualification', '', q.overrideId!,
        `${b.parameter} entered under QA qualification override ${q.overrideId} for method ${b.methodCode} (valid until ${q.overrideUntil}); overdue training: ${q.overdue.join(', ')}`);
      return null;
    }
    throw new AppError(403, 'QUALIFICATION_REQUIRED',
      `QUALIFICATION_REQUIRED: you are not qualified for method ${b.methodCode} (${b.parameter}): training assignment(s) ${q.overdue.join(', ')} are overdue. Complete the training, or ask QA for a signed qualification override.`,
      { methodCode: b.methodCode, overdue: q.overdue });
  },
};
