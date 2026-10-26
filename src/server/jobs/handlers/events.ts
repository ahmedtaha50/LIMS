/**
 * calibration.due (roadmap M23): the scheduled scan that announces instruments coming due for calibration. For every instrument
 * that is not Retired it emits instrument.calibration_due once per due date when the date is within the warning window (30 days, the
 * amber band of the Instruments screen), and once more when the date has passed (overdue: true). A recalibration sets a new due date,
 * which is announced again in its turn. The events are attributed to the job's owner (the service principal) and written in one
 * transaction with the check that they were not announced before, so two runs never announce the same thing twice.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { instruments } from '../../../db/schema';
import { outboxEvents } from '../../../db/schema/events';
import { calibrationState } from '../../../lib/validations/instruments';
import { withTransaction } from '../../core/tx';
import { emitEvent } from '../../events/emit';
import { PermanentJobError, type Handler } from '../types';

export const CALIBRATION_WARNING_DAYS = 30;
/** Serialises two scans that run at the same moment (another process, a manual run). */
const SCAN_LOCK = 7150;

export const calibrationDueHandler: Handler = async (_payload, ctx) => {
  const actorId = ctx.job.createdBy;
  if (!actorId) throw new PermanentJobError('The job has no owner.');
  return withTransaction(ctx.db, async (tx, afterCommit) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCAN_LOCK})`);
    const rows = await tx.select().from(instruments).where(ne(instruments.status, 'Retired'));
    let emitted = 0;
    for (const inst of rows) {
      const dueDate = String(inst.calibrationDueDate).slice(0, 10);
      const { expired, daysRemaining } = calibrationState(dueDate);
      if (!expired && daysRemaining > CALIBRATION_WARNING_DAYS) continue;
      const overdue = expired;
      const [already] = await tx.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.type, 'instrument.calibration_due'), eq(outboxEvents.entityId, inst.id),
        sql`${outboxEvents.payload}->>'dueDate' = ${dueDate}`, sql`(${outboxEvents.payload}->>'overdue')::boolean = ${overdue}`,
      )).limit(1);
      if (already) continue;
      await emitEvent(tx, {
        type: 'instrument.calibration_due', payload: { instrumentId: inst.id, name: inst.name, dueDate, overdue },
        entity: 'Instrument', entityId: inst.id, actorId,
      }, afterCommit);
      emitted++;
    }
    return { scanned: rows.length, emitted };
  });
};
