/**
 * System suitability (roadmap M18). Owned by r2-methods-calc; the guard is registered in ./index.ts (RESULT_GUARDS).
 *
 * A system suitability run (sst_runs, POST /calc/samples/:id/sst) is recorded per sample and method. When it fails, every result of
 * that method already entered on the sample becomes Invalid: the run records the result id and the version it invalidated. Nothing
 * is written to the result itself, and no OOS investigation is opened: a run that is not suitable says nothing about the sample.
 *
 *   sst-not-failed       no result of a method is entered while the latest run of that method for the sample failed
 *   invalidResults()     the results whose CURRENT version a failed run invalidated (a result entered again afterwards, under a
 *                        passing run, has a new version and is valid again)
 *   latestRuns()         the latest run of each method for a sample
 * The review guard (src/server/workflow/guards/sst.ts) uses the last two.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { results } from '../../../db/schema';
import { sstRuns } from '../../../db/schema/calc';
import type { Executor } from '../../core/tx';
import type { ResultGuard } from './index';
import { bindingOfResult } from './method';

export type SstRunRow = typeof sstRuns.$inferSelect;

/** The latest run of each method (by lower-case code) recorded for the sample. */
export async function latestRuns(ex: Executor, sampleId: string): Promise<Map<string, SstRunRow>> {
  const rows = await ex.select().from(sstRuns).where(eq(sstRuns.sampleId, sampleId)).orderBy(desc(sstRuns.performedAt), desc(sstRuns.id));
  const out = new Map<string, SstRunRow>();
  for (const r of rows) if (!out.has(r.methodCode.toLowerCase())) out.set(r.methodCode.toLowerCase(), r);
  return out;
}

/** Result id -> the failed run that invalidated its current version. */
export async function invalidResults(ex: Executor, sampleId: string): Promise<Map<string, SstRunRow>> {
  const failed = await ex.select().from(sstRuns).where(and(eq(sstRuns.sampleId, sampleId), eq(sstRuns.passed, false))).orderBy(sstRuns.performedAt);
  if (failed.length === 0) return new Map();
  const current = new Map((await ex.select({ id: results.id, version: results.version }).from(results).where(eq(results.sampleId, sampleId))).map(r => [r.id, r.version]));
  const out = new Map<string, SstRunRow>();
  for (const run of failed) {
    for (const inv of run.invalidated ?? []) if (current.get(inv.resultId) === inv.version) out.set(inv.resultId, run);
  }
  return out;
}

export const sstNotFailed: ResultGuard = {
  name: 'sst-not-failed',
  async check(ex, { sampleId, resultId }) {
    const b = await bindingOfResult(ex, resultId);
    if (!b?.methodCode) return null;
    const [latest] = await ex.select().from(sstRuns)
      .where(and(eq(sstRuns.sampleId, sampleId), sql`lower(${sstRuns.methodCode}) = ${b.methodCode.toLowerCase()}`))
      .orderBy(desc(sstRuns.performedAt), desc(sstRuns.id)).limit(1);
    if (!latest || latest.passed) return null;
    return `${b.parameter}: the latest system suitability run of method ${latest.methodCode} (${latest.id}) failed. No result of the method is entered until a run passes.`;
  },
};
