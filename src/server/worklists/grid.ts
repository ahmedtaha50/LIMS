/**
 * Grid entry on a worklist (roadmap M33): the cells of a run, one result each, possibly of different samples. Each cell goes through
 * saveResult (src/server/services/saveResult.ts), the one validated write path, in a transaction of its own, so every cell has its own
 * version predicate, its own result guards (including the assignee), its own audit entry and its own outcome:
 *
 *   a cell that saves        -> in `saved`
 *   a cell that is refused   -> in `failed` with its status (409 for a stale version, 403 for a non-assignee, 400 for a rule) and why
 *
 * The answer is 200 when every cell saved and 207 when at least one did not; nothing is ever silent. A cell that was refused changes
 * nothing; a cell that saved stays saved (cells of different samples are independent records).
 */
import { eq } from 'drizzle-orm';
import { results } from '../../db/schema';
import { worklistItems, worklists } from '../../db/schema/worklists';
import type { ResultsBatchItem } from '../../lib/validations/results-batch';
import type { Db } from '../core/context';
import { withTransaction } from '../core/tx';
import { AppError, BadRequestError, NotFoundError } from '../http/errors';
import { evaluateResult, limitOfResult } from '../lib/evaluate';
import { saveResult } from '../services/saveResult';
import type { Actor } from './service';

/** The audit reason of a first entry the analyst gave no reason for (the same text as the sample's results-batch save). */
const INITIAL_ENTRY_REASON = 'Initial entry';
const isBlank = (v: string | null | undefined) => v === null || v === undefined || v === '';

export interface GridFailure { index: number; resultId: string; parameter: string | null; status: number; code: string; error: string }

export async function saveGrid(db: Db, actor: Actor, worklistId: string, cells: ResultsBatchItem[]) {
  const [w] = await db.select().from(worklists).where(eq(worklists.id, worklistId)).limit(1);
  if (!w) throw new NotFoundError(`Worklist ${worklistId} was not found.`);
  if (w.status !== 'Released') {
    throw new AppError(409, 'WORKLIST_NOT_RELEASED', `Worklist ${worklistId} is ${w.status}; results are entered on a Released worklist.`);
  }
  const items = await db.select().from(worklistItems).where(eq(worklistItems.worklistId, worklistId));
  const sampleOf = new Map(items.filter(i => i.status === 'Active' && i.resultId).map(i => [i.resultId!, i.sampleId!]));

  const saved: unknown[] = [];
  const failed: GridFailure[] = [];
  for (const [index, cell] of cells.entries()) {
    let parameter: string | null = null;
    try {
      const sampleId = sampleOf.get(cell.resultId);
      if (!sampleId) throw new NotFoundError(`Result ${cell.resultId} is not an Active item of worklist ${worklistId}.`);
      const [row] = await db.select().from(results).where(eq(results.id, cell.resultId)).limit(1);
      if (!row) throw new NotFoundError(`Result ${cell.resultId} was not found.`);
      parameter = row.parameter;
      if (!isBlank(row.value) && !cell.reason) {
        throw new BadRequestError(`${row.parameter}: changing a value already entered needs a reason (ALCOA+).`);
      }
      const evaluation = evaluateResult(cell.value, limitOfResult(row));
      const sameInstrument = cell.instrumentId === undefined || cell.instrumentId === (row.instrumentId ?? undefined);
      if (evaluation.ok && evaluation.value === row.value && sameInstrument) {
        throw new BadRequestError(`${row.parameter}: no change, the value and the instrument are what is already recorded.`);
      }
      saved.push(await withTransaction(db, (tx, afterCommit) => saveResult({
        tx, afterCommit, user: actor, sampleId, resultId: cell.resultId,
        input: {
          value: cell.value, reason: cell.reason ?? INITIAL_ENTRY_REASON, expectedVersion: cell.expectedVersion,
          instrumentId: cell.instrumentId ?? w.instrumentId ?? undefined, oosId: cell.oosId, reasonCode: cell.reasonCode, lotIds: cell.lotIds,
        },
      })));
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      failed.push({ index, resultId: cell.resultId, parameter, status: e.status, code: e.code, error: parameter && e.status === 409 && e.code === 'CONFLICT'
        ? `${parameter} was changed by someone else since you loaded it. Refresh and review it before saving.` : e.message });
    }
  }
  return { worklistId, saved, failed };
}
