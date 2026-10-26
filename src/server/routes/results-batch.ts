// Domain: results, the bench-side workbench (roadmap M19). Owned by r2-result-ui.
//
// PUT /samples/:id/results-batch saves every changed row of one sample in ONE transaction, all or nothing. Each value goes through
// saveResult (src/server/services/saveResult.ts), so the rules of a single save hold for every row: entry role, Testing state,
// version predicate, evaluation by the server, OOS replacement rule, coded correction reason, result guards (instrument calibration,
// method, SST), one audit entry per value, the result version, and the OOS investigation opened in the same transaction.
//
// Before anything is written, the whole request is checked:
//   * the person may enter results and the sample is in Testing (403 / 423 / 409, as for one row);
//   * every row belongs to the sample (404 naming the row);
//   * no row is stale: a row whose expectedVersion is behind the database refuses the WHOLE save with 409 RESULTS_STALE, and
//     `details` lists every stale row (path items.<n>, resultId, parameter) so the grid can highlight them;
//   * overwriting a value needs the row's own reason (400 naming the parameter); a first entry is recorded as "Initial entry"
//     unless the analyst wrote a reason; a row that changes nothing is refused (no audit entry without a change).
// A refusal raised by saveResult for one row is answered with that row in `details`. Nothing is ever saved automatically: the grid
// sends this request only when the analyst saves.
import { and, eq, inArray } from 'drizzle-orm';
import { results, samples } from '../../db/schema';
import { RESULT_ENTRY_ROLES, RESULT_ENTRY_STATE } from '../../lib/constants/results';
import { resultsBatchSchema, type ResultsBatchItem } from '../../lib/validations/results-batch';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, withTransaction } from '../core/tx';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { evaluateResult, limitOfResult } from '../lib/evaluate';
import { saveResult } from '../services/saveResult';

/** The audit reason of a first entry the analyst gave no reason for. */
export const INITIAL_ENTRY_REASON = 'Initial entry';

const isBlank = (v: string | null | undefined) => v === null || v === undefined || v === '';

interface RowDetail { path: string; resultId: string; parameter: string; message: string }
const rowDetail = (i: number, item: ResultsBatchItem, parameter: string, message: string): RowDetail =>
  ({ path: `items.${i}`, resultId: item.resultId, parameter, message });

export const resultsBatchRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.put('/samples/:id/results-batch', requireAuth, validate(resultsBatchSchema), async (req, res) => {
    const user = (req as any).user as { id: string; role: string };
    const sampleId = String(req.params.id);
    const items = (req.body as { items: ResultsBatchItem[] }).items;

    const saved = await withTransaction(db, async (tx, afterCommit) => {
      // The same order as saveResult: the sample is locked first, so a concurrent save, review or approval waits for this one.
      const sample = await lockRow(tx, samples, sampleId);
      if (!RESULT_ENTRY_ROLES.includes(user.role)) {
        throw new ForbiddenError(`Forbidden: results are entered by ${RESULT_ENTRY_ROLES.join(' or ')}; a ${user.role} reviews them.`);
      }
      if (sample.state === 'Approved' || sample.state === 'Rejected') {
        throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: Sample ${sampleId} is ${sample.state}; its results can no longer be changed.`);
      }
      if (sample.state !== RESULT_ENTRY_STATE) {
        throw new AppError(409, 'SAMPLE_NOT_IN_TESTING', `Results are entered while the sample is in ${RESULT_ENTRY_STATE}; sample ${sampleId} is ${sample.state}.`);
      }

      const rows = await tx.select().from(results)
        .where(and(eq(results.sampleId, sampleId), inArray(results.id, items.map(i => i.resultId))));
      const byId = new Map(rows.map(r => [r.id, r]));

      const missing = items.findIndex(i => !byId.has(i.resultId));
      if (missing >= 0) {
        throw new NotFoundError(`Result ${items[missing].resultId} is not a result of sample ${sampleId}. Nothing was saved.`);
      }

      const stale = items.flatMap((item, i) => {
        const row = byId.get(item.resultId)!;
        return row.version === item.expectedVersion ? [] : [rowDetail(i, item, row.parameter,
          `${row.parameter} was changed by someone else since you loaded it (version ${row.version}, you had ${item.expectedVersion}). Refresh and review it before saving.`)];
      });
      if (stale.length > 0) {
        throw new AppError(409, 'RESULTS_STALE',
          `Conflict: ${stale.map(s => s.parameter).join(', ')} changed since you loaded the sample. Nothing was saved; refresh and review before saving again.`, stale);
      }

      items.forEach((item, i) => {
        const row = byId.get(item.resultId)!;
        if (!isBlank(row.value) && !item.reason) {
          const message = `${row.parameter}: changing a value already entered needs a reason (ALCOA+). Nothing was saved.`;
          throw new BadRequestError(message, [rowDetail(i, item, row.parameter, message)]);
        }
        const evaluation = evaluateResult(item.value, limitOfResult(row));
        const sameInstrument = item.instrumentId === undefined || item.instrumentId === (row.instrumentId ?? undefined);
        if (evaluation.ok && evaluation.value === row.value && sameInstrument) {
          const message = `${row.parameter}: no change, the value and the instrument are what is already recorded. Nothing was saved.`;
          throw new BadRequestError(message, [rowDetail(i, item, row.parameter, message)]);
        }
      });

      const out: Array<Awaited<ReturnType<typeof saveResult>>> = [];
      for (const [i, item] of items.entries()) {
        const row = byId.get(item.resultId)!;
        try {
          out.push(await saveResult({
            tx, afterCommit, user, sampleId, resultId: item.resultId,
            input: {
              value: item.value, reason: item.reason ?? INITIAL_ENTRY_REASON, expectedVersion: item.expectedVersion,
              instrumentId: item.instrumentId, oosId: item.oosId, reasonCode: item.reasonCode, lotIds: item.lotIds,
            },
          }));
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          throw new AppError(e.status, e.code, e.message, [rowDetail(i, item, row.parameter, e.message)]);
        }
      }
      return out;
    });

    res.json({ sampleId, saved });
  });

  return router;
};
