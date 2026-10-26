/**
 * Clock guard (roadmap M35, ALCOA+ "contemporaneous", Annex 11 s.9). r2-audit-tamper owns this file.
 *
 * Every audit entry and signature takes its time from this PC's clock. A clock set back (by hand, or a CMOS battery) makes new records
 * look older than records already written, and nothing noticed it. The guard keeps a watermark, the latest time it has seen (stored in
 * clock_state; before the first check, the newest audit entry). A check that reads the clock more than TOLERANCE before the
 * watermark is an anomaly:
 *
 *   * a clock_anomalies row (one while it is open) and a CLOCK_ANOMALY security event, in one transaction;
 *   * signing is refused (423 CLOCK_ANOMALY) until an Administrator acknowledges the anomaly with an e-signature (CLOCK_ANOMALY_ACK).
 *     The acknowledgement is the one signature still allowed: it is what lifts the block (AGENTS.md, the SignatureModal rule).
 *     It makes the current clock the new watermark.
 *
 * The watermark never moves back by itself. A clock that jumps forward is not detectable this way (no outside time source) and
 * simply moves the watermark: the return to the right time is then reported, which is the conservative side.
 * Checks run before every signature (guardSigningClock, from signRecord), every 5 minutes (src/server/schedules/audit.ts) and at start.
 */
import { randomBytes } from 'crypto';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { auditTrail } from '../../db/schema';
import { clockAnomalies, clockState } from '../../db/schema/audit-review';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Executor } from '../core/tx';
// Not from '../esign': signRecord.ts imports guardSigningClock from here, and the index would be half-loaded at that point.
import type { SigningCredentials } from '../esign/authorize';
import { registerSignable } from '../esign/registry';
import { signRecord } from '../esign/signRecord';
import type { EventContext } from '../auth/events';
import { AppError, NotFoundError } from '../http/errors';
import { writeSecurityEvent } from './securityEvents';

/** A clock this much behind the watermark is an anomaly; less is jitter (NTP corrections, two processes). */
export const CLOCK_TOLERANCE_MS = 60_000;
export const CLOCK_ACK_MEANING = 'CLOCK_ANOMALY_ACK';
/** Advisory lock of the guard (7001 audit chain, 7002 migrations, 7003 security events). */
const CLOCK_LOCK = 7170;
const STATE_ID = 'default';

export type ClockAnomaly = typeof clockAnomalies.$inferSelect;
export interface ClockCheck { ok: boolean; behindMs: number; watermark: Date | null; anomaly: ClockAnomaly | null }

export async function openClockAnomalies(ex: Executor): Promise<ClockAnomaly[]> {
  return ex.select().from(clockAnomalies).where(isNull(clockAnomalies.acknowledgedAt)).orderBy(clockAnomalies.detectedAt);
}

export async function checkClock(db: Db, o: { now?: Date; source: string; actorId?: string | null }): Promise<ClockCheck> {
  return withTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLOCK_LOCK})`);
    const now = o.now ?? new Date();
    const [state] = await tx.select().from(clockState).where(eq(clockState.id, STATE_ID)).limit(1);
    let watermark: Date | null = state?.lastSeenAt ?? null;
    if (!watermark) {
      const [last] = await tx.select({ at: auditTrail.timestamp }).from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
      watermark = last?.at ?? null;
    }

    if (watermark && now.getTime() < watermark.getTime() - CLOCK_TOLERANCE_MS) {
      const behindMs = watermark.getTime() - now.getTime();
      let [anomaly] = await tx.select().from(clockAnomalies).where(isNull(clockAnomalies.acknowledgedAt)).limit(1);
      if (!anomaly) {
        [anomaly] = await tx.insert(clockAnomalies).values({
          id: `CLK-${randomBytes(6).toString('hex').toUpperCase()}`, detectedAt: now, watermark, behindMs, source: o.source,
        }).returning();
        await writeSecurityEvent(tx, {
          type: 'CLOCK_ANOMALY', outcome: 'failure', actorId: o.actorId ?? null,
          detail: { anomalyId: anomaly.id, source: o.source, behindMs, watermark: watermark.toISOString(), clock: now.toISOString() },
        });
      }
      if (!state) await tx.insert(clockState).values({ id: STATE_ID, lastSeenAt: watermark });
      return { ok: false, behindMs, watermark, anomaly };
    }

    const next = watermark && watermark.getTime() > now.getTime() ? watermark : now;
    await tx.insert(clockState).values({ id: STATE_ID, lastSeenAt: next })
      .onConflictDoUpdate({ target: clockState.id, set: { lastSeenAt: next, updatedAt: new Date() } });
    return { ok: true, behindMs: 0, watermark: next, anomaly: null };
  });
}

/** 423 CLOCK_ANOMALY while an anomaly is open, for every meaning but the acknowledgement. */
export async function assertClockTrusted(ex: Executor, meaningCode: string): Promise<void> {
  if (meaningCode === CLOCK_ACK_MEANING) return;
  const [open] = await ex.select().from(clockAnomalies).where(isNull(clockAnomalies.acknowledgedAt)).orderBy(clockAnomalies.detectedAt).limit(1);
  if (!open) return;
  const minutes = Math.round(open.behindMs / 60_000);
  throw new AppError(423, 'CLOCK_ANOMALY',
    `Electronic signatures are blocked: on ${open.detectedAt.toISOString()} the system clock was found about ${minutes} minute(s) behind the time of ` +
    `records already written (anomaly ${open.id}). An Administrator must check the clock and acknowledge the anomaly (Audit review, Clock).`,
    { anomalyId: open.id });
}

/** What signRecord runs before it asks for the password: a clock check, then the block. Nothing is counted when it refuses. */
export async function guardSigningClock(db: Db, meaningCode: string, now?: Date): Promise<void> {
  await checkClock(db, { now, source: 'signature' });
  await assertClockTrusted(db, meaningCode);
}

registerSignable({
  type: 'ClockAnomaly',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(clockAnomalies).where(eq(clockAnomalies.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, detectedAt: row.detectedAt.toISOString(), watermark: row.watermark.toISOString(), behindMs: row.behindMs, source: row.source,
      acknowledgedBy: row.acknowledgedBy, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, ackReason: row.ackReason,
    };
  },
});

export interface AcknowledgeBody extends SigningCredentials { reason: string; expectedVersion: number }

/** The Administrator's signed acknowledgement (CLOCK_ANOMALY_ACK, reason required). The current clock becomes the watermark. */
export async function acknowledgeClockAnomaly(db: Db, user: { id: string }, id: string, body: AcknowledgeBody, context?: Partial<EventContext>) {
  const [current] = await db.select().from(clockAnomalies).where(eq(clockAnomalies.id, id)).limit(1);
  if (!current) throw new NotFoundError(`Clock anomaly ${id} was not found.`);
  const already = () => new AppError(409, 'ALREADY_ACKNOWLEDGED', `Clock anomaly ${id} was already acknowledged.`);
  if (current.acknowledgedAt) throw already();

  const { result, signature } = await signRecord({
    db, user, meaningCode: CLOCK_ACK_MEANING, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'ClockAnomaly', entityId: id, context,
    execute: async tx => {
      const row = await lockRow(tx, clockAnomalies, id);
      if (row.acknowledgedAt) throw already();
      const at = new Date();
      const updated = await updateVersioned(tx, clockAnomalies, id, body.expectedVersion, { acknowledgedBy: user.id, acknowledgedAt: at, ackReason: body.reason });
      await tx.execute(sql`select pg_advisory_xact_lock(${CLOCK_LOCK})`);
      await tx.insert(clockState).values({ id: STATE_ID, lastSeenAt: at }).onConflictDoUpdate({ target: clockState.id, set: { lastSeenAt: at, updatedAt: at } });
      return { recordVersion: updated.version, audit: { action: 'Acknowledge', field: 'acknowledged', oldValue: 'false', newValue: 'true', reason: body.reason }, result: updated };
    },
  });
  return { anomaly: result, signature };
}
