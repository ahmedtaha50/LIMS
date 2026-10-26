/**
 * Turnaround time: the due date of a sample and the scheduled sweep (roadmap M34). Owned by r2-tat-kpi; SCHEDULES (./index.ts), the
 * handler registry (src/server/jobs/handlers/index.ts) and the event catalog (src/server/events/catalog.ts) list it through the wave gate.
 *
 *   tat.sweep   every ten minutes. (1) Starts the clock of every received sample that is not finished and has no due date yet: the due
 *               date is the receipt plus the SLA of its priority in business days (src/server/lib/businessCalendar.ts), written with an
 *               audit entry, one transaction per sample. (2) Announces, once per sample and due date, that a sample is due within 24 hours
 *               and that it is overdue (event sample.tat_alert).
 * The due date is calculated once and stored. A later change of the calendar or of an SLA does not move the due dates already given.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { outboxEvents } from '../../db/schema/events';
import { sampleCustody } from '../../db/schema/custody';
import { samples } from '../../db/schema/samples';
import { businessCalendar, businessHolidays, sampleTat, tatSlaRules, TAT_PRIORITIES, type TatPriority } from '../../db/schema/tat';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Executor, type Tx, type AfterCommit } from '../core/tx';
import { emitEvent } from '../events/emit';
import { ConflictError } from '../http/errors';
import { ensureServicePrincipal } from '../jobs/principal';
import type { Handler } from '../jobs/types';
import { addBusinessDays, DEFAULT_CALENDAR, type CalendarConfig } from '../lib/businessCalendar';
import type { ScheduleDef } from './index';

export const TAT_SCHEDULES: ScheduleDef[] = [
  { name: 'tat.sweep', cron: '*/10 * * * *', type: 'tat.sweep', description: 'Every 10 minutes: starts the turnaround clock of received samples (due date from the priority and the business calendar), and announces samples due within 24 hours and overdue ones (event sample.tat_alert).' },
];

/** Business days per priority until QA saves a rule. A conservative default that the site confirms or changes (Settings, turnaround). */
export const DEFAULT_SLA_DAYS: Record<TatPriority, number> = { Routine: 10, Urgent: 3, Critical: 1 };
/** Samples in these states are finished: no due date is started for them and no alert is raised. */
export const FINISHED_STATES = ['Approved', 'Rejected'] as const;
export const DUE_SOON_HOURS = 24;
/** How many samples one sweep handles; the rest follow in the next run. */
const BATCH = 500;

export interface LoadedCalendar extends CalendarConfig { version: number | null; source: 'default' | 'configured'; updatedAt: string | null }

export async function loadCalendar(ex: Executor): Promise<LoadedCalendar> {
  const [row] = await ex.select().from(businessCalendar).where(eq(businessCalendar.id, 'default')).limit(1);
  const holidays = (await ex.select({ d: businessHolidays.holidayDate }).from(businessHolidays)).map(h => h.d).sort();
  if (!row) return { ...DEFAULT_CALENDAR, holidays, version: null, source: 'default', updatedAt: null };
  return { weekendDays: [...row.weekendDays].sort((a, b) => a - b), timeZone: row.timeZone, holidays, version: row.version, source: 'configured', updatedAt: row.updatedAt.toISOString() };
}

export interface LoadedSla { priority: TatPriority; businessDays: number; version: number | null; source: 'default' | 'configured' }

export async function loadSlaRules(ex: Executor): Promise<LoadedSla[]> {
  const rows = await ex.select().from(tatSlaRules);
  return TAT_PRIORITIES.map(priority => {
    const r = rows.find(x => x.id === priority);
    return r ? { priority, businessDays: r.businessDays, version: r.version, source: 'configured' as const } : { priority, businessDays: DEFAULT_SLA_DAYS[priority], version: null, source: 'default' as const };
  });
}

/** The due date of a sample received at `startedAt` with this priority, under the calendar and rules now in force. */
export async function calculateDue(ex: Executor, startedAt: Date, priority: TatPriority): Promise<{ dueAt: Date; slaBusinessDays: number }> {
  const [calendar, rules] = await Promise.all([loadCalendar(ex), loadSlaRules(ex)]);
  const slaBusinessDays = rules.find(r => r.priority === priority)!.businessDays;
  return { dueAt: addBusinessDays(startedAt, slaBusinessDays, calendar), slaBusinessDays };
}

const view = (r: { priority: string; startedAt: Date | null; slaBusinessDays: number | null; dueAt: Date | null }) =>
  JSON.stringify({ priority: r.priority, startedAt: r.startedAt?.toISOString() ?? null, slaBusinessDays: r.slaBusinessDays, dueAt: r.dueAt?.toISOString() ?? null });

/**
 * Sets the priority of a sample and, when it is received, its due date. Creates the sidecar row or updates it with the expected
 * version, with the audit entry in the same transaction. The caller is the person (or the service principal) who is accountable.
 */
export async function setPriority(tx: Tx, actorId: string, sampleId: string, priority: TatPriority, reason: string, expectedVersion: number | null) {
  const [custody] = await tx.select({ receivedAt: sampleCustody.receivedAt }).from(sampleCustody).where(eq(sampleCustody.sampleId, sampleId)).limit(1);
  const due = custody ? await calculateDue(tx, custody.receivedAt, priority) : null;
  const clock = { startedAt: custody?.receivedAt ?? null, slaBusinessDays: due?.slaBusinessDays ?? null, dueAt: due?.dueAt ?? null };
  const [existing] = await tx.select().from(sampleTat).where(eq(sampleTat.id, sampleId)).for('update');
  if (!existing) {
    const row = { id: sampleId, priority, ...clock, setBy: actorId, setAt: new Date(), version: 1 };
    await tx.insert(sampleTat).values(row);
    await writeAudit(tx, actorId, 'Create', 'SampleTat', sampleId, 'priority', '', view(row), reason);
    return row;
  }
  if (expectedVersion === null) throw new ConflictError(`Conflict: sample ${sampleId} already has a priority (version ${existing.version}). Refresh and send its version.`);
  const updated = await updateVersioned(tx, sampleTat, sampleId, expectedVersion, { priority, ...clock, setBy: actorId, setAt: new Date() });
  await writeAudit(tx, actorId, 'Update', 'SampleTat', sampleId, 'priority', view(existing), view(updated), reason);
  return updated;
}

/** (1) The clock of every received, unfinished sample that has none. Returns the number started. */
export async function startClocks(db: Db, actorId: string): Promise<number> {
  const todo = await db.select({ sampleId: sampleCustody.sampleId, receivedAt: sampleCustody.receivedAt, tatVersion: sampleTat.version, priority: sampleTat.priority })
    .from(sampleCustody)
    .innerJoin(samples, eq(samples.id, sampleCustody.sampleId))
    .leftJoin(sampleTat, eq(sampleTat.id, sampleCustody.sampleId))
    .where(and(sql`${samples.state} NOT IN ('Approved', 'Rejected')`, sql`${sampleTat.dueAt} IS NULL`))
    .orderBy(sql`${sampleCustody.sampleId} COLLATE "C"`).limit(BATCH);
  let started = 0;
  for (const t of todo) {
    const done = await withTransaction(db, async (tx) => {
      await lockRow(tx, samples, t.sampleId);
      const [current] = await tx.select().from(sampleTat).where(eq(sampleTat.id, t.sampleId)).for('update');
      if (current?.dueAt) return false; // someone set it in the meantime
      const priority = (current?.priority ?? 'Routine') as TatPriority;
      const due = await calculateDue(tx, t.receivedAt, priority);
      const clock = { startedAt: t.receivedAt, slaBusinessDays: due.slaBusinessDays, dueAt: due.dueAt };
      const reason = 'Scheduled: tat.sweep (the clock starts at the receipt of the sample)';
      if (!current) {
        const row = { id: t.sampleId, priority, ...clock, setBy: actorId, setAt: new Date(), version: 1 };
        await tx.insert(sampleTat).values(row);
        await writeAudit(tx, actorId, 'Create', 'SampleTat', t.sampleId, 'priority', '', view(row), reason);
      } else {
        const updated = await updateVersioned(tx, sampleTat, t.sampleId, current.version, clock);
        await writeAudit(tx, actorId, 'Update', 'SampleTat', t.sampleId, 'dueAt', view(current), view(updated), reason);
      }
      return true;
    });
    if (done) started++;
  }
  return started;
}

/** (2) The announcements. One event per sample, due date and kind; two runs never announce the same thing twice. */
export async function announceDue(db: Db, actorId: string, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + DUE_SOON_HOURS * 3_600_000);
  const rows = await db.select({ id: sampleTat.id, priority: sampleTat.priority, dueAt: sampleTat.dueAt }).from(sampleTat)
    .innerJoin(samples, eq(samples.id, sampleTat.id))
    .where(and(sql`${samples.state} NOT IN ('Approved', 'Rejected')`, sql`${sampleTat.dueAt} <= ${horizon.toISOString()}::timestamptz`))
    .orderBy(asc(sampleTat.dueAt), sql`${sampleTat.id} COLLATE "C"`).limit(BATCH);
  let sent = 0;
  for (const r of rows) {
    const dueAt = r.dueAt!;
    const kind = dueAt.getTime() <= now.getTime() ? 'overdue' : 'due_soon';
    const emitted = await withTransaction(db, async (tx, afterCommit: AfterCommit) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7280)`);
      const [already] = await tx.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.type, 'sample.tat_alert'), eq(outboxEvents.entityId, r.id),
        sql`${outboxEvents.payload}->>'dueAt' = ${dueAt.toISOString()}`, sql`${outboxEvents.payload}->>'kind' = ${kind}`,
      )).limit(1);
      if (already) return false;
      await emitEvent(tx, { type: 'sample.tat_alert', payload: { sampleId: r.id, priority: r.priority as TatPriority, dueAt: dueAt.toISOString(), kind }, entity: 'Sample', entityId: r.id, actorId }, afterCommit);
      return true;
    });
    if (emitted) sent++;
  }
  return sent;
}

export async function runTatSweep(db: Db, opts: { now?: Date; actorId?: string } = {}) {
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  const started = await startClocks(db, actorId);
  const announced = await announceDue(db, actorId, opts.now ?? new Date());
  return { started, announced };
}

export const tatSweepHandler: Handler = async (_payload, ctx) => runTatSweep(ctx.db, { actorId: ctx.job.createdBy ?? undefined });

export const TAT_HANDLERS: Record<string, Handler> = { 'tat.sweep': tatSweepHandler };
