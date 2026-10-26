/**
 * The scheduled sweep of the pull calendar (roadmap M31): "a timepoint turns Due and Missed with no user action, including after the PC
 * was off". It is a job of the scheduler (src/server/schedules/stability.ts), which runs a schedule that fell due while the server was
 * off once when it starts again; the sweep itself decides from the calendar date, so one run catches up however many days were missed.
 *
 *   1. Every Scheduled or Due timepoint of an Ongoing study is put where the calendar says (./calendar.ts scheduledStatus): Scheduled ->
 *      Due when the window opens; Scheduled or Due -> Missed when it has closed without a pull. A missed pull opens a deviation
 *      (r2-qms autoOpenQmsRecord, source 'stability-pull-missed') in the same transaction: a missed pull is a deviation, not a silent
 *      edit (21 CFR 211.166, 211.192).
 *   2. A pulled timepoint follows its sample: Pulled -> InTesting when the sample is in Testing or Pending Review; -> Complete when the
 *      sample is Approved or Rejected (the sample's state stays visible on the timepoint).
 * One transaction per timepoint, each change audited, with the version predicate. The actor is the scheduler's service principal.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { samples, stabilityStudies } from '../../db/schema';
import { stabilityTimepoints } from '../../db/schema/stability';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { ensureServicePrincipal } from '../jobs/principal';
import { todayIso } from '../lib/specs';
import { AUTO_OPEN_SOURCES, autoOpenQmsRecord, type AutoOpenSource } from '../qms/autoOpen';
import { scheduledStatus } from './calendar';

export const MISSED_PULL_SOURCE = 'stability-pull-missed';

const FOLLOW: Record<string, 'InTesting' | 'Complete' | undefined> = { Testing: 'InTesting', 'Pending Review': 'InTesting', Approved: 'Complete', Rejected: 'Complete' };
const RANK: Record<string, number> = { Pulled: 0, InTesting: 1, Complete: 2 };

export async function runStabilitySweep(db: Db, opts: { now?: Date; actorId?: string } = {}) {
  const now = opts.now ?? new Date();
  const today = todayIso(now);
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  if (!(MISSED_PULL_SOURCE in AUTO_OPEN_SOURCES)) {
    // The deviation of a missed pull is not optional: refuse to run rather than mark pulls missed without one.
    throw new Error(`The quality-record source '${MISSED_PULL_SOURCE}' is not registered (src/server/qms/autoOpen.ts): missed pulls cannot be recorded.`);
  }
  let due = 0, missed = 0, followed = 0;

  const open = await db.select({ id: stabilityTimepoints.id }).from(stabilityTimepoints)
    .innerJoin(stabilityStudies, eq(stabilityStudies.id, stabilityTimepoints.studyId))
    .where(and(eq(stabilityStudies.status, 'Ongoing'), inArray(stabilityTimepoints.status, ['Scheduled', 'Due'])));
  for (const { id } of open) {
    await withTransaction(db, async (tx) => {
      const tp = await lockRow(tx, stabilityTimepoints, id);
      const study = await lockRow(tx, stabilityStudies, tp.studyId);
      if (study.status !== 'Ongoing' || (tp.status !== 'Scheduled' && tp.status !== 'Due')) return;
      const { status } = scheduledStatus(today, tp);
      if (status === tp.status) return;
      if (status === 'Due') {
        await updateVersioned(tx, stabilityTimepoints, id, tp.version, { status });
        await writeAudit(tx, actorId, 'StatusChange', 'StabilityTimepoint', id, 'status', tp.status, status, `Scheduled: stability.timepoints (pull window ${tp.windowStart} to ${tp.windowEnd} is open)`);
        due++;
        return;
      }
      const deviation = await autoOpenQmsRecord(tx, {
        source: MISSED_PULL_SOURCE as AutoOpenSource, sourceId: id, actorId,
        title: `Missed stability pull: study ${study.id}, ${tp.conditionCode}, month ${tp.month}`,
        description: `Batch ${study.batch} of ${study.product}. The pull was due on ${tp.dueDate}; its window ${tp.windowStart} to ${tp.windowEnd} closed without a pull (timepoint ${id}).`,
      });
      await updateVersioned(tx, stabilityTimepoints, id, tp.version, { status: 'Missed', missedAt: now, deviationId: deviation.id });
      await writeAudit(tx, actorId, 'StatusChange', 'StabilityTimepoint', id, 'status', tp.status, 'Missed',
        `Scheduled: stability.timepoints (pull window ${tp.windowStart} to ${tp.windowEnd} closed without a pull; deviation ${deviation.id})`);
      missed++;
    });
  }

  const pulled = await db.select({ id: stabilityTimepoints.id }).from(stabilityTimepoints)
    .innerJoin(samples, eq(samples.id, stabilityTimepoints.sampleId))
    .where(and(inArray(stabilityTimepoints.status, ['Pulled', 'InTesting']), inArray(samples.state, Object.keys(FOLLOW))));
  for (const { id } of pulled) {
    await withTransaction(db, async (tx) => {
      const tp = await lockRow(tx, stabilityTimepoints, id);
      const [sample] = await tx.select({ state: samples.state }).from(samples).where(eq(samples.id, tp.sampleId!)).limit(1);
      const next = FOLLOW[sample.state];
      if (!next || !(tp.status in RANK) || RANK[next] <= RANK[tp.status]) return;
      await updateVersioned(tx, stabilityTimepoints, id, tp.version, { status: next });
      await writeAudit(tx, actorId, 'StatusChange', 'StabilityTimepoint', id, 'status', tp.status, next, `Scheduled: stability.timepoints (pull sample ${tp.sampleId} is ${sample.state})`);
      followed++;
    });
  }
  return { today, due, missed, followed };
}
