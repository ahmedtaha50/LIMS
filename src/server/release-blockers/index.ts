/**
 * The release-blocker registry (roadmap M10). Owned by r1-results-oos.
 *
 * Each blocker looks at the samples of a batch and says why the batch may not be released; the release route refuses (400) while any
 * blocker reports something, and checks again inside the signing transaction. Fail closed: an investigation whose status is not a
 * terminal word of src/lib/constants/oos.ts blocks, whatever it is called.
 *
 * To add a rule: one entry in RELEASE_BLOCKERS.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { oosInvestigations, results, samples } from '../../db/schema';
import { OOS_TERMINAL_STATUSES, oosStage } from '../../lib/constants/oos';
import type { Executor } from '../core/tx';
import { qmsReleaseBlocker } from './qms';
import { oosVocabularyReleaseBlocker } from './oos';
import { auditReviewReleaseBlocker } from '../audit/review';

export interface BatchSample { id: string; state: string }

export interface ReleaseBlocker {
  name: string;
  check(ex: Executor, batch: string, batchSamples: readonly BatchSample[]): Promise<string[]>;
}

/** The OOS reasons a set of samples cannot be approved or released. Shared with the sample approval guard. */
export async function findOosBlockers(ex: Executor, sampleIds: readonly string[]): Promise<string[]> {
  if (sampleIds.length === 0) return [];
  const problems: string[] = [];
  const open = await ex.select().from(oosInvestigations)
    .where(and(inArray(oosInvestigations.sampleId, [...sampleIds]), notInArray(oosInvestigations.status, [...OOS_TERMINAL_STATUSES])))
    .orderBy(oosInvestigations.id);
  for (const o of open) problems.push(`OOS investigation ${o.id} (sample ${o.sampleId}, ${o.parameter}) is ${oosStage(o)}, not closed.`);

  const oosResults = await ex.select({ id: results.id, sampleId: results.sampleId, parameter: results.parameter }).from(results)
    .where(and(inArray(results.sampleId, [...sampleIds]), eq(results.isOos, true))).orderBy(results.id);
  if (oosResults.length) {
    const closed = await ex.select({ resultId: oosInvestigations.resultId }).from(oosInvestigations)
      .where(and(inArray(oosInvestigations.resultId, oosResults.map(r => r.id)), inArray(oosInvestigations.status, [...OOS_TERMINAL_STATUSES])));
    const investigated = new Set(closed.map(c => c.resultId));
    const pending = new Set(open.map(o => o.resultId));
    for (const r of oosResults) {
      if (!investigated.has(r.id) && !pending.has(r.id)) problems.push(`Result ${r.id} (sample ${r.sampleId}, ${r.parameter}) is OOS and has no closed investigation.`);
    }
  }
  return problems;
}

export const RELEASE_BLOCKERS: readonly ReleaseBlocker[] = [
  {
    name: 'has-samples',
    async check(_ex, batch, batchSamples) {
      return batchSamples.length === 0 ? [`Batch ${batch} has no samples: there are no results to release it on.`] : [];
    },
  },
  {
    name: 'all-approved',
    async check(_ex, _batch, batchSamples) {
      const notApproved = batchSamples.filter(s => s.state !== 'Approved');
      return notApproved.length ? [`Samples not Approved: ${notApproved.map(s => `${s.id} (${s.state})`).join(', ')}.`] : [];
    },
  },
  {
    name: 'no-open-oos',
    async check(ex, _batch, batchSamples) {
      return findOosBlockers(ex, batchSamples.map(s => s.id));
    },
  },
  oosVocabularyReleaseBlocker,
  qmsReleaseBlocker,
  auditReviewReleaseBlocker,
];

/** Every reason `batch` cannot be released now; empty when it can. */
export async function findReleaseBlockers(ex: Executor, batch: string): Promise<string[]> {
  const batchSamples = await ex.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.batch, batch)).orderBy(samples.id);
  const problems: string[] = [];
  for (const blocker of RELEASE_BLOCKERS) problems.push(...await blocker.check(ex, batch, batchSamples));
  return problems;
}
