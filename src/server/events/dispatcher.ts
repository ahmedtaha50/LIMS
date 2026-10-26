/**
 * The event dispatcher (roadmap M23). Reads committed rows of outbox_events and does two things, each in its own short transaction:
 *
 *   fan-out   for each event not yet fanned out (FOR UPDATE SKIP LOCKED, so several server processes never take the same row): one
 *             notification for every active user whose role holds the event's audience permission at this moment ('*': every
 *             active user of a role in the permission matrix; service accounts hold no role there), and one delivery for every Active
 *             subscription to the event type. After COMMIT each new notification is pushed to the socket room of its user only.
 *   delivery  each due delivery (pending and due, or 'sending' whose lease ran out) is claimed under a lease, attempted ONCE per pass
 *             through its sink, and recorded: delivered; or pending again with back-off; or dead after `max_attempts` attempts (the
 *             first try and 5 retries). Every change of a delivery row checks and increments `version`.
 *
 * A delivery attempt is never inside a transaction: a slow receiver holds no lock. A process that dies during an attempt leaves the
 * row in 'sending'; another pass takes it again after the lease, so an event can reach a receiver twice but is never lost. That is
 * why every attempt carries the same X-LIMS-Event-Id.
 */
import { randomBytes } from 'crypto';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { rolePermissions, roles, users } from '../../db/schema';
import { eventDeliveries, eventSubscriptions, notifications, outboxEvents, type EventDeliveryRow, type EventSubscriptionRow, type OutboxEventRow } from '../../db/schema/events';
import type { Db } from '../core/context';
import { log, serializeError } from '../core/logger';
import { withTransaction, type Executor } from '../core/tx';
import { getKeystore } from '../crypto/keystore';
import { EVENT_CATALOG, isEventType } from './catalog';
import { onEventEmitted } from './emit';
import { deliverEmail } from './sinks/email';
import { deliverFile } from './sinks/file';
import type { SinkOutcome } from './sinks/types';
import { deliverWebhook } from './sinks/webhook';
import { configuredAllowList, DestinationError, parseAllowList, type AllowList } from './ssrf';

/** The first try and 5 retries. */
export const MAX_ATTEMPTS = 6;
/** Seconds before retry n (n = 1 after the first failure): 30 s, 2 min, 10 min, 30 min, 2 h. */
export const DEFAULT_BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];
export const defaultBackoff = (attempt: number) => DEFAULT_BACKOFF_SECONDS[Math.min(attempt, DEFAULT_BACKOFF_SECONDS.length) - 1] ?? 7200;
/** A delivery left in 'sending' longer than this (the process died during the attempt) is taken again. */
export const LEASE_SECONDS = 120;

export const userRoom = (userId: string) => `user:${userId}`;
export const subscriptionSecretContext = (subscriptionId: string) => `event-subscription:${subscriptionId}`;

/** The part of the Socket.IO server the dispatcher uses. */
export interface RoomEmitter { to(room: string): { emit(event: string, payload: unknown): unknown } }

export interface DispatchOptions {
  io?: RoomEmitter;
  /** Seconds to wait before retry `attempt` (1-based). Tests pass () => 0. */
  backoffSeconds?: (attempt: number) => number;
  /** Overrides EVENTS_WEBHOOK_ALLOWLIST for this pass. */
  allowList?: AllowList | string | readonly string[];
  batchSize?: number;
  workerId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DispatchReport { fannedOut: number; notifications: number; attempted: number; delivered: number; failed: number; dead: number }

export type NotificationRow = typeof notifications.$inferSelect;

/** What the client receives of a notification (socket push and GET /notifications). */
export const notificationView = (n: NotificationRow) => ({
  id: n.id, userId: n.userId, eventId: n.eventId, type: n.type, title: n.title, message: n.message, href: n.href,
  createdAt: n.createdAt.toISOString(), readAt: n.readAt?.toISOString() ?? null,
});

/** The body every sink receives: no actor credentials, no result value (the catalog's strict payloads). */
export const envelopeOf = (e: OutboxEventRow) => ({
  id: e.id, type: e.type, version: e.typeVersion, occurredAt: e.createdAt.toISOString(), entity: e.entity, entityId: e.entityId, data: e.payload,
});

function textOf(e: OutboxEventRow): { title: string; message: string; href: string | null } {
  if (!isEventType(e.type)) return { title: e.type, message: `${e.type} ${e.entityId}`, href: null };
  const def = EVENT_CATALOG[e.type] as unknown as { title: string; message: (p: unknown) => string; href: (p: unknown) => string | null };
  return { title: def.title, message: def.message(e.payload), href: def.href(e.payload) };
}

/** Active users who receive `audience` now. */
async function recipients(ex: Executor, audience: string): Promise<string[]> {
  const base = ex.selectDistinct({ id: users.id }).from(users).innerJoin(roles, and(eq(roles.name, users.role), eq(roles.active, true)));
  const rows = audience === '*'
    ? await base.where(eq(users.active, true))
    : await base.innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id)).where(and(eq(users.active, true), eq(rolePermissions.permissionCode, audience)));
  return rows.map(r => r.id).sort();
}

async function fanOut(db: Db, o: DispatchOptions, report: DispatchReport): Promise<NotificationRow[]> {
  return withTransaction(db, async (tx) => {
    const events = await tx.select().from(outboxEvents).where(isNull(outboxEvents.fannedOutAt))
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id)).limit(o.batchSize ?? 100).for('update', { skipLocked: true });
    const created: NotificationRow[] = [];
    for (const e of events) {
      const text = textOf(e);
      const to = await recipients(tx, e.audience);
      if (to.length) {
        const rows = await tx.insert(notifications).values(to.map(userId => ({
          id: `ntf-${randomBytes(10).toString('hex')}`, userId, eventId: e.id, type: e.type, title: text.title, message: text.message, href: text.href,
        }))).onConflictDoNothing().returning();
        created.push(...rows);
      }
      const subs = await tx.select({ id: eventSubscriptions.id }).from(eventSubscriptions)
        .where(and(eq(eventSubscriptions.status, 'Active'), sql`${eventSubscriptions.eventTypes} @> ${JSON.stringify([e.type])}::jsonb`));
      if (subs.length) {
        await tx.insert(eventDeliveries).values(subs.map(s => ({
          id: `dlv-${randomBytes(10).toString('hex')}`, eventId: e.id, subscriptionId: s.id, maxAttempts: MAX_ATTEMPTS,
        }))).onConflictDoNothing();
      }
      await tx.update(outboxEvents).set({ fannedOutAt: sql`now()` }).where(eq(outboxEvents.id, e.id));
    }
    report.fannedOut += events.length;
    report.notifications += created.length;
    return created;
  });
}

interface Claimed { delivery: EventDeliveryRow; subscription: EventSubscriptionRow; event: OutboxEventRow }

async function claim(db: Db, workerId: string, limit: number): Promise<Claimed[]> {
  return withTransaction(db, async (tx) => {
    const due = await tx.select({ delivery: eventDeliveries, subscription: eventSubscriptions, event: outboxEvents })
      .from(eventDeliveries)
      .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
      .innerJoin(outboxEvents, eq(outboxEvents.id, eventDeliveries.eventId))
      .where(and(
        eq(eventSubscriptions.status, 'Active'),
        or(
          and(eq(eventDeliveries.status, 'pending'), lte(eventDeliveries.nextAttemptAt, sql`now()`)),
          and(eq(eventDeliveries.status, 'sending'), lte(eventDeliveries.lockedAt, sql`now() - make_interval(secs => ${LEASE_SECONDS})`)),
        ),
      ))
      .orderBy(asc(eventDeliveries.nextAttemptAt), asc(eventDeliveries.id))
      .limit(limit)
      .for('update', { of: eventDeliveries, skipLocked: true });
    if (!due.length) return [];
    const locked = await tx.update(eventDeliveries)
      .set({ status: 'sending', lockedBy: workerId, lockedAt: sql`now()`, version: sql`${eventDeliveries.version} + 1` })
      .where(inArray(eventDeliveries.id, due.map(d => d.delivery.id))).returning();
    const byId = new Map(locked.map(d => [d.id, d]));
    return due.map(d => ({ ...d, delivery: byId.get(d.delivery.id)! }));
  });
}

async function attempt(c: Claimed, allowList: AllowList, env: NodeJS.ProcessEnv): Promise<SinkOutcome> {
  const envelope = envelopeOf(c.event);
  const body = JSON.stringify(envelope);
  try {
    switch (c.subscription.sink) {
      case 'webhook': {
        const secret = getKeystore().decrypt(c.subscription.secretEnc ?? '', subscriptionSecretContext(c.subscription.id));
        return await deliverWebhook({ url: c.subscription.target, secret, eventId: c.event.id, eventType: c.event.type, body }, { allowList });
      }
      case 'file':
        return await deliverFile({ folder: c.subscription.target, eventId: c.event.id, body: JSON.stringify(envelope, null, 2) }, env);
      case 'email': {
        const text = textOf(c.event);
        const lines = [
          text.message, '',
          `Event: ${c.event.type} (version ${c.event.typeVersion}), ${c.event.id}`,
          `Record: ${c.event.entity} ${c.event.entityId}`,
          `Time: ${c.event.createdAt.toISOString()}`, '',
          'This message is a notification from the LIMS. It is not a GxP record and does not replace a review or a signature in the LIMS.',
        ];
        return await deliverEmail({ to: c.subscription.target, subject: `[LIMS] ${text.title}`, text: lines.join('\n'), eventId: c.event.id }, env);
      }
      default:
        return { ok: false, error: `Unknown sink ${String(c.subscription.sink)}.` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof DestinationError ? err.message : `The delivery failed: ${(err as Error).message}` };
  }
}

async function record(db: Db, c: Claimed, outcome: SinkOutcome, backoff: (n: number) => number, report: DispatchReport): Promise<void> {
  const d = c.delivery;
  const attempts = d.attempts + 1;
  const dead = !outcome.ok && attempts >= d.maxAttempts;
  const set = outcome.ok
    ? { status: 'delivered' as const, deliveredAt: sql`now()`, lastError: null }
    : dead
      ? { status: 'dead' as const, lastError: (outcome.error ?? 'failed').slice(0, 1000) }
      : { status: 'pending' as const, nextAttemptAt: sql`now() + make_interval(secs => ${Math.max(0, backoff(attempts))})`, lastError: (outcome.error ?? 'failed').slice(0, 1000) };
  const rows = await db.update(eventDeliveries)
    .set({ ...set, attempts, lastStatusCode: outcome.statusCode ?? null, lockedBy: null, lockedAt: null, version: sql`${eventDeliveries.version} + 1` } as any)
    .where(and(eq(eventDeliveries.id, d.id), eq(eventDeliveries.version, d.version), eq(eventDeliveries.status, 'sending')))
    .returning({ id: eventDeliveries.id });
  if (!rows.length) {
    log.warn({ deliveryId: d.id }, 'event delivery changed while it was being attempted; its outcome was not recorded');
    return;
  }
  report.attempted++;
  if (outcome.ok) report.delivered++;
  else if (dead) report.dead++;
  else report.failed++;
  if (!outcome.ok) log.warn({ deliveryId: d.id, subscriptionId: c.subscription.id, attempts, dead, statusCode: outcome.statusCode, error: outcome.error }, 'event delivery failed');
}

/** One pass: fan out what is new, then attempt every due delivery once. */
export async function dispatchOnce(db: Db, o: DispatchOptions = {}): Promise<DispatchReport> {
  const report: DispatchReport = { fannedOut: 0, notifications: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 };
  const created = await fanOut(db, o, report);
  for (const n of created) {
    try { o.io?.to(userRoom(n.userId)).emit('notification', notificationView(n)); } catch (err) { log.error({ err: serializeError(err) }, 'notification push failed'); }
  }

  const env = o.env ?? process.env;
  const allowList = o.allowList === undefined ? configuredAllowList(env)
    : (typeof o.allowList === 'string' || Array.isArray(o.allowList)) ? parseAllowList(o.allowList as string | readonly string[]) : o.allowList as AllowList;
  const claimed = await claim(db, o.workerId ?? `pid-${process.pid}`, o.batchSize ?? 20);
  await Promise.all(claimed.map(async (c) => record(db, c, await attempt(c, allowList, env), o.backoffSeconds ?? defaultBackoff, report)));
  return report;
}

export interface Dispatcher { stop(): Promise<void>; nudge(): void }

/**
 * Runs dispatchOnce every `intervalMs`, and at once when an event is committed in this process (emitEvent's afterCommit) or a
 * delivery is requeued. Passes never overlap; a failing pass is logged and the next one runs as usual.
 */
export function startDispatcher(db: Db, o: Omit<DispatchOptions, 'backoffSeconds'> & { intervalMs?: number } = {}): Dispatcher {
  const workerId = o.workerId ?? `pid-${process.pid}-${randomBytes(3).toString('hex')}`;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const pass = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        try { await dispatchOnce(db, { ...o, workerId }); } catch (err) { log.error({ err: serializeError(err) }, 'event dispatch pass failed'); }
      } while (again && !stopped);
    })().finally(() => { running = null; });
  };
  const timer = setInterval(pass, o.intervalMs ?? 5000);
  timer.unref?.();
  const unsubscribe = onEventEmitted(pass);
  pass();
  return {
    nudge: pass,
    async stop() { stopped = true; clearInterval(timer); unsubscribe(); await running; },
  };
}
