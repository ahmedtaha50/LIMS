/**
 * Release blocker of the QMS (roadmap M27): a batch is not released while a deviation about it is open and Major, Critical or not yet
 * classified (fail closed: an unclassified deviation could be critical). A Minor deviation does not block.
 *
 * "About the batch": a link (any relation but `implemented`) from the deviation to the batch itself, to one of its samples, or to an
 * OOS investigation of one of its samples. The batch dossier (GET /traceability/batch/:batch) lists the same deviations through
 * findBatchDeviations. Owned by r2-qms; listed in RELEASE_BLOCKERS (./index.ts) by the wave gate.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { oosInvestigations, samples } from '../../db/schema';
import { qmsLinks, qmsRecords } from '../../db/schema/qms';
import type { Executor } from '../core/tx';
import { LIFECYCLES } from '../qms/states';
import type { ReleaseBlocker } from './index';

export interface BatchDeviation {
  id: string; title: string; classification: string | null; state: string;
  /** Not Closed or Cancelled. */
  open: boolean;
  /** Open and Major, Critical or not classified. */
  blocksRelease: boolean;
}

/** Every deviation about `batch` (open and final), oldest number first. `sampleIds` defaults to the samples registered on the batch. */
export async function findBatchDeviations(ex: Executor, batch: string, sampleIds?: readonly string[]): Promise<BatchDeviation[]> {
  const ids = sampleIds ?? (await ex.select({ id: samples.id }).from(samples).where(eq(samples.batch, batch))).map(s => s.id);
  const oosIds = ids.length
    ? (await ex.select({ id: oosInvestigations.id }).from(oosInvestigations).where(inArray(oosInvestigations.sampleId, [...ids]))).map(o => o.id)
    : [];
  const about = [and(eq(qmsLinks.targetType, 'Batch'), eq(qmsLinks.targetId, batch))];
  if (ids.length) about.push(and(eq(qmsLinks.targetType, 'Sample'), inArray(qmsLinks.targetId, [...ids])));
  if (oosIds.length) about.push(and(eq(qmsLinks.targetType, 'OOS'), inArray(qmsLinks.targetId, oosIds)));

  const rows = await ex.selectDistinct({ id: qmsRecords.id, title: qmsRecords.title, state: qmsRecords.state, classification: qmsRecords.classification })
    .from(qmsRecords)
    .innerJoin(qmsLinks, eq(qmsLinks.recordId, qmsRecords.id))
    .where(and(eq(qmsRecords.type, 'Deviation'), ne(qmsLinks.relation, 'implemented'), or(...about)))
    .orderBy(qmsRecords.id);
  return rows.map(r => {
    const open = !LIFECYCLES.Deviation.terminal.includes(r.state);
    return { ...r, open, blocksRelease: open && (r.classification === null || r.classification === 'Major' || r.classification === 'Critical') };
  });
}

export const qmsReleaseBlocker: ReleaseBlocker = {
  name: 'no-open-serious-deviation',
  async check(ex, batch, batchSamples) {
    const blocking = (await findBatchDeviations(ex, batch, batchSamples.map(s => s.id))).filter(d => d.blocksRelease);
    return blocking.map(r => `Deviation ${r.id} (${r.classification ?? 'not classified'}, ${r.state}) concerns batch ${batch} and is not closed.`);
  },
};
