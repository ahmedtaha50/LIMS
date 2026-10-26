/**
 * saveResult: the one way a result value is written (roadmap M10). Owned by r1-results-oos.
 *
 * Inside ONE transaction, in this order:
 *   1. the sample row is locked (a concurrent review or approval waits), the result must belong to it;
 *   2. the person must hold an entry role (Analyst, Admin: 403) and the sample must be in Testing (409; 423 once Approved/Rejected);
 *   3. the value is evaluated against the limit the result was registered with (src/server/lib/evaluate.ts): 400 if not acceptable;
 *   4. replacing an OOS value needs the open investigation of that result and a coded reason (400);
 *   5. the result guards run (src/server/services/result-guards: instrument and calibration, method, SST, the analyst's qualification);
 *   6. the result is written with the version predicate (409 for a stale version), and audited;
 *   7. an OOS value without an open investigation opens one (status Open, phase Phase I), audited;
 *   8. the value is kept as a result version with its coded reason (src/server/services/result-hooks/versions.ts, roadmap M20):
 *      the first entry is INITIAL_ENTRY, a correction needs a reasonCode, an OOS value one of the OOS codes;
 *   9. the reagent lots and prepared solutions listed in `lotIds` are linked to the result version just written (roadmap M30,
 *      src/server/services/result-guards/reagent.ts): each must be usable now, else 400 naming it and its date.
 * Any failure rolls back all of it. An OOS that opens an investigation also writes the event result.oos_detected to the outbox in the
 * same transaction (src/server/events, roadmap M23): rolled back with the rest, delivered to its audience after COMMIT, without the value.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { oosInvestigations, results, samples } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { OOS_INITIAL_PHASE, OOS_STATUS, OOS_TERMINAL_STATUSES } from '../../lib/constants/oos';
import { RESULT_ENTRY_ROLES, RESULT_ENTRY_STATE } from '../../lib/constants/results';
import type { IoLike } from '../core/context';
import { lockRow, nextSequence, updateVersioned, type AfterCommit, type Executor, type Tx } from '../core/tx';
import { emitEvent } from '../events/emit';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { evaluateResult, limitOfResult } from '../lib/evaluate';
import { todayIso } from '../lib/specs';
import { assertResultGuards } from './result-guards';
import { linkResultMaterials } from './result-guards/reagent';
import type { ResultChangeCode } from './result-hooks/codes';
import { codeTheChange, recordResultVersion } from './result-hooks/versions';

export interface SaveResultInput {
  value: string;
  reason: string;
  expectedVersion: number;
  instrumentId?: string;
  attachmentName?: string;
  attachmentData?: string;
  oosId?: string;
  reasonCode?: ResultChangeCode;
  /** Reagent lots (RL-) and prepared solutions (PS-) the value was measured with (r2-reagents). */
  lotIds?: string[];
}

export interface SaveResultArgs {
  tx: Tx;
  afterCommit: AfterCommit;
  /** Not used any more: the OOS notification goes through the event outbox (r2-events). Kept so the callers need no change. */
  io?: IoLike;
  user: { id: string; role: string };
  sampleId: string;
  resultId: string;
  input: SaveResultInput;
  now?: Date;
}

const pad = (n: number) => String(n).padStart(5, '0');

/** OOS-<year>-<n>: a per-year counter, like the sample id. */
export async function nextOosId(ex: Executor, now = new Date()): Promise<string> {
  const year = now.getFullYear();
  return `OOS-${year}-${pad(await nextSequence(ex, `oos:${year}`))}`;
}

/** The investigation of `resultId` that is not final, if any. */
export async function openInvestigationOf(ex: Executor, resultId: string) {
  const [row] = await ex.select().from(oosInvestigations)
    .where(and(eq(oosInvestigations.resultId, resultId), notInArray(oosInvestigations.status, [...OOS_TERMINAL_STATUSES]))).limit(1);
  return row ?? null;
}

/** Opens an investigation (status Open, phase Phase I) for a result, with its audit entry, in the caller's transaction. */
export async function openInvestigation(tx: Tx, userId: string, result: { id: string; sampleId: string; parameter: string }, reason: string, now = new Date()) {
  const row = {
    id: await nextOosId(tx, now), sampleId: result.sampleId, resultId: result.id, parameter: result.parameter,
    dateRaised: todayIso(now), status: OOS_STATUS.OPEN, phase: OOS_INITIAL_PHASE, version: 1,
  };
  await tx.insert(oosInvestigations).values(row);
  await writeAudit(tx, userId, 'Create', 'OOS', row.id, 'all', '', JSON.stringify(row), reason);
  return row;
}

export async function saveResult({ tx, afterCommit, user, sampleId, resultId, input, now = new Date() }: SaveResultArgs) {
  const sample = await lockRow(tx, samples, sampleId);
  const [result] = await tx.select().from(results).where(eq(results.id, resultId)).limit(1);
  if (!result || result.sampleId !== sampleId) throw new NotFoundError('Result not found.');

  if (!RESULT_ENTRY_ROLES.includes(user.role)) {
    throw new ForbiddenError(`Forbidden: results are entered by ${RESULT_ENTRY_ROLES.join(' or ')}; a ${user.role} reviews them.`);
  }
  if (sample.state === 'Approved' || sample.state === 'Rejected') {
    throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: Sample ${sampleId} is ${sample.state}; its results can no longer be changed.`);
  }
  if (sample.state !== RESULT_ENTRY_STATE) {
    throw new AppError(409, 'SAMPLE_NOT_IN_TESTING', `Results are entered while the sample is in ${RESULT_ENTRY_STATE}; sample ${sampleId} is ${sample.state}.`);
  }

  // A stale version is reported before anything that depends on the value someone else has just written.
  if (result.version !== input.expectedVersion) throw new ConflictError();

  const evaluation = evaluateResult(input.value, limitOfResult(result));
  if (!evaluation.ok) throw new BadRequestError(`${result.parameter}: ${evaluation.error}`);

  let auditReason = input.reason;
  const open = await openInvestigationOf(tx, resultId);
  if (result.isOos) {
    if (!open || input.oosId !== open.id || !input.reasonCode) {
      throw new BadRequestError(open
        ? `This result is OOS and under investigation ${open.id}: replacing it needs oosId "${open.id}" and a reasonCode.`
        : 'This result is OOS and has no open investigation: it cannot be replaced. Open an investigation first.');
    }
    auditReason = `[${input.reasonCode}] OOS ${open.id}: ${input.reason}`;
  } else if (input.oosId) {
    throw new BadRequestError('oosId is only used to replace a result that is OOS.');
  }
  const coded = codeTheChange(result, input, auditReason);
  auditReason = coded.auditReason;

  await assertResultGuards(tx, { sampleId, resultId, instrumentId: input.instrumentId, userId: user.id, now });

  const updated = await updateVersioned(tx, results, resultId, input.expectedVersion, {
    value: evaluation.value, isOos: evaluation.isOos, enteredBy: user.id, enteredAt: now,
    instrumentId: input.instrumentId, attachmentName: input.attachmentName, attachmentData: input.attachmentData,
  });
  await writeAudit(tx, user.id, 'Update', 'Result', resultId, 'value', result.value ?? '', evaluation.value, auditReason);
  await recordResultVersion(tx, { before: result, after: updated, userId: user.id, changeCode: coded.changeCode, reason: input.reason, oosId: result.isOos ? open?.id : null, now });
  if (input.lotIds?.length) {
    await linkResultMaterials(tx, { sampleId, resultId, materialIds: input.lotIds, userId: user.id, resultVersion: updated.version, now });
  }

  let oosInvestigationId: string | null = open?.id ?? null;
  if (evaluation.isOos && !open) {
    const created = await openInvestigation(tx, user.id, result, `Opened automatically: ${result.parameter} = ${evaluation.value} is out of specification.`, now);
    oosInvestigationId = created.id;
    await emitEvent(tx, {
      type: 'result.oos_detected', payload: { sampleId, resultId, parameter: result.parameter, investigationId: created.id },
      entity: 'Result', entityId: resultId, actorId: user.id,
    }, afterCommit);
  }
  return { ...updated, oosInvestigationId };
}
