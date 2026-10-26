/**
 * The scheduled reagent job (roadmap M30). Owned by r2-reagents; SCHEDULES (./index.ts), the handler registry
 * (src/server/jobs/handlers/index.ts) and the event catalog (src/server/events/catalog.ts) list it through the wave gate.
 *
 *   reagents.expiry   hourly: every lot (Quarantine, Approved, InUse) whose expiry or in-use expiry has passed becomes Expired, and every
 *                     Active solution past its expiry date becomes Expired, each with its audit entry, one transaction per record. Lots
 *                     and solutions that expire within 30 days, within 7 days, and those that have just expired are announced once each
 *                     (event reagent.expiry_alert: thresholds 30, 7 and 0), so two runs never announce the same thing twice.
 * Result entry does not wait for this job: the result guard reads the dates itself (src/server/services/result-guards/reagent.ts).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { outboxEvents } from '../../db/schema/events';
import { preparedSolutions, reagentItems, reagentLots } from '../../db/schema/reagents';
import { writeAudit } from '../../db/utils';
import { calibrationState, utcToday } from '../../lib/validations/instruments';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Tx, type AfterCommit } from '../core/tx';
import { emitEvent } from '../events/emit';
import { ensureServicePrincipal } from '../jobs/principal';
import type { Handler } from '../jobs/types';
import { lotUseLimit } from '../services/result-guards/reagent';
import type { ScheduleDef } from './index';

export const REAGENT_SCHEDULES: ScheduleDef[] = [
  { name: 'reagents.expiry', cron: '5 * * * *', type: 'reagents.expiry', description: 'Hourly: marks reagent lots and prepared solutions past their expiry (or in-use expiry) Expired, and announces those expiring within 30 and 7 days (event reagent.expiry_alert).' },
];

/** The days before the use limit at which a lot or solution is announced; 0 is "has expired". */
export const REAGENT_ALERT_THRESHOLDS = [30, 7] as const;
/** Serialises two runs that start at the same moment (another process, a manual run). */
const SCAN_LOCK = 7230;

interface Candidate { id: string; kind: 'lot' | 'solution'; name: string; lotNumber: string | null; useUntil: string }

async function alertOnce(tx: Tx, afterCommit: AfterCommit, actorId: string, c: Candidate, threshold: 30 | 7 | 0, daysRemaining: number) {
  const [already] = await tx.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
    eq(outboxEvents.type, 'reagent.expiry_alert'), eq(outboxEvents.entityId, c.id),
    sql`${outboxEvents.payload}->>'useUntil' = ${c.useUntil}`, sql`(${outboxEvents.payload}->>'threshold')::int = ${threshold}`,
  )).limit(1);
  if (already) return false;
  await emitEvent(tx, {
    type: 'reagent.expiry_alert',
    payload: { materialId: c.id, kind: c.kind, name: c.name, lotNumber: c.lotNumber, useUntil: c.useUntil, threshold, daysRemaining: Math.max(daysRemaining, 0) },
    entity: c.kind === 'lot' ? 'ReagentLot' : 'PreparedSolution', entityId: c.id, actorId,
  }, afterCommit);
  return true;
}

export async function runReagentExpiry(db: Db, opts: { now?: Date; actorId?: string } = {}) {
  const now = opts.now ?? new Date();
  const today = utcToday(now);
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  let expired = 0, alerts = 0;

  // 1. lots and solutions past their use limit become Expired, one transaction each (a failure leaves the others done).
  const lots = await db.select({ lot: reagentLots, itemName: reagentItems.name }).from(reagentLots)
    .innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId))
    .where(inArray(reagentLots.status, ['Quarantine', 'Approved', 'InUse'])).orderBy(asc(reagentLots.id));
  for (const { lot, itemName } of lots) {
    if (lotUseLimit(lot) >= today) continue;
    const done = await withTransaction(db, async (tx, afterCommit) => {
      const current = await lockRow(tx, reagentLots, lot.id);
      const limit = lotUseLimit(current);
      if (!['Quarantine', 'Approved', 'InUse'].includes(current.status) || limit >= today) return false;
      await updateVersioned(tx, reagentLots, current.id, current.version, { status: 'Expired', closedBy: actorId, closedAt: now, closeReason: `Use limit ${limit} passed` });
      await writeAudit(tx, actorId, 'Expire', 'ReagentLot', current.id, 'status', current.status, 'Expired',
        `Scheduled: reagents.expiry (${limit === current.expiryDate ? `expiry date ${limit}` : `in-use expiry ${limit}`} passed)`);
      await alertOnce(tx, afterCommit, actorId, { id: current.id, kind: 'lot', name: itemName, lotNumber: current.lotNumber, useUntil: limit }, 0, 0);
      return true;
    });
    if (done) { expired++; alerts++; }
  }
  const solutions = await db.select().from(preparedSolutions).where(eq(preparedSolutions.status, 'Active')).orderBy(asc(preparedSolutions.id));
  for (const s of solutions) {
    if (s.expiryDate >= today) continue;
    const done = await withTransaction(db, async (tx, afterCommit) => {
      const current = await lockRow(tx, preparedSolutions, s.id);
      if (current.status !== 'Active' || current.expiryDate >= today) return false;
      await updateVersioned(tx, preparedSolutions, current.id, current.version, { status: 'Expired', closedBy: actorId, closedAt: now, closeReason: `Expiry date ${current.expiryDate} passed` });
      await writeAudit(tx, actorId, 'Expire', 'PreparedSolution', current.id, 'status', 'Active', 'Expired', `Scheduled: reagents.expiry (expiry date ${current.expiryDate} passed)`);
      await alertOnce(tx, afterCommit, actorId, { id: current.id, kind: 'solution', name: current.name, lotNumber: null, useUntil: current.expiryDate }, 0, 0);
      return true;
    });
    if (done) { expired++; alerts++; }
  }

  // 2. the announcements at 30 and 7 days, once per record, threshold and use limit (a retest or an opening gives a new limit).
  const open = [
    ...(await db.select({ lot: reagentLots, itemName: reagentItems.name }).from(reagentLots).innerJoin(reagentItems, eq(reagentItems.id, reagentLots.itemId))
      .where(inArray(reagentLots.status, ['Approved', 'InUse'])).orderBy(asc(reagentLots.id)))
      .map(({ lot, itemName }): Candidate => ({ id: lot.id, kind: 'lot', name: itemName, lotNumber: lot.lotNumber, useUntil: lotUseLimit(lot) })),
    ...(await db.select().from(preparedSolutions).where(eq(preparedSolutions.status, 'Active')).orderBy(asc(preparedSolutions.id)))
      .map((s): Candidate => ({ id: s.id, kind: 'solution', name: s.name, lotNumber: null, useUntil: s.expiryDate })),
  ];
  for (const c of open) {
    const { expired: past, daysRemaining } = calibrationState(c.useUntil, now);
    if (past) continue;
    const thresholds = REAGENT_ALERT_THRESHOLDS.filter(t => daysRemaining <= t);
    if (thresholds.length === 0) continue;
    // Only the nearest threshold is announced: a lot received 5 days before expiry gets the 7-day alert, not both.
    const threshold = Math.min(...thresholds) as 30 | 7;
    const sent = await withTransaction(db, async (tx, afterCommit) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCAN_LOCK})`);
      return alertOnce(tx, afterCommit, actorId, c, threshold, daysRemaining);
    });
    if (sent) alerts++;
  }
  return { expired, alerts };
}

export const reagentExpiryHandler: Handler = async (_payload, ctx) => runReagentExpiry(ctx.db, { actorId: ctx.job.createdBy ?? undefined });

export const REAGENT_HANDLERS: Record<string, Handler> = { 'reagents.expiry': reagentExpiryHandler };
