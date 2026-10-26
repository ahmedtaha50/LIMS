/**
 * The scheduled training job (roadmap M28; topDefect "Overdue training is never set"). Listed in SCHEDULES (src/server/schedules)
 * and the handler registry (src/server/jobs/handlers) by the gate; runs daily as the service principal.
 *
 *   1. every curriculum is synchronised: users and documents added since get their assignments (origin auto:sync);
 *   2. every Assigned assignment whose due date has passed becomes Overdue, with an audit entry, one transaction per assignment;
 *   3. the software-trained flag is re-derived for each user with a LIMS-curriculum assignment that became Overdue.
 * Result entry does not wait for this job: the qualification guard reads the due date itself (src/server/training/status.ts).
 */
import { and, asc, eq, lt } from 'drizzle-orm';
import { trainingAssignments, trainingCurricula } from '../../db/schema/training';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { ensureServicePrincipal } from '../jobs/principal';
import type { Handler } from '../jobs/types';
import { todayIso } from '../lib/specs';
import type { ScheduleDef } from '../schedules';
import { syncCurriculum } from './assign';
import { refreshSoftwareFlag } from './status';

export const TRAINING_SCHEDULES: ScheduleDef[] = [
  { name: 'training.overdue', cron: '10 1 * * *', type: 'training.overdue', description: 'Daily: assigns curricula to users and documents added since, marks training past its due date Overdue and re-derives the software-trained flag.' },
];

export async function runTrainingMaintenance(db: Db, opts: { now?: Date; actorId?: string } = {}) {
  const now = opts.now ?? new Date();
  const today = todayIso(now);
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  let assigned = 0, overdue = 0, flagsChanged = 0;

  for (const c of await db.select().from(trainingCurricula).orderBy(asc(trainingCurricula.code))) {
    assigned += (await withTransaction(db, tx => syncCurriculum(tx, actorId, c, today))).length;
  }

  const due = await db.select({ id: trainingAssignments.id }).from(trainingAssignments)
    .where(and(eq(trainingAssignments.status, 'Assigned'), lt(trainingAssignments.dueDate, today))).orderBy(asc(trainingAssignments.dueDate));
  const [lims] = await db.select({ id: trainingCurricula.id }).from(trainingCurricula).where(eq(trainingCurricula.isSoftware, true)).limit(1);
  for (const { id } of due) {
    const changed = await withTransaction(db, async (tx) => {
      const a = await lockRow(tx, trainingAssignments, id);
      if (a.status !== 'Assigned' || a.dueDate >= today) return false;
      await updateVersioned(tx, trainingAssignments, id, a.version, { status: 'Overdue' });
      await writeAudit(tx, actorId, 'Overdue', 'TrainingAssignment', id, 'status', 'Assigned', 'Overdue', `Scheduled: training.overdue (due ${a.dueDate}, not completed)`);
      overdue++;
      if (lims && a.curriculumId === lims.id) {
        return (await refreshSoftwareFlag(tx, a.userId, actorId, today, `assignment ${id} is overdue`)) !== null;
      }
      return false;
    });
    if (changed) flagsChanged++;
  }
  return { assigned, overdue, flagsChanged };
}

export const trainingOverdueHandler: Handler = async (_payload, ctx) => runTrainingMaintenance(ctx.db, { actorId: ctx.job.createdBy ?? undefined });

export const TRAINING_HANDLERS: Record<string, Handler> = { 'training.overdue': trainingOverdueHandler };
