// Domain: outbound event subscriptions (roadmap M23). Owned by r2-events.
//
//   GET  /event-subscriptions                   every subscription with its delivery counts, the event catalog and which sinks are configured
//   POST /event-subscriptions                   create one, e-signed (ADMIN_AUTHORISATION); a webhook's secret is answered ONCE
//   POST /event-subscriptions/:id/status        disable or re-enable, e-signed, with the version the screen showed
//   GET  /event-subscriptions/:id/deliveries    its deliveries, newest first (?status=pending|sending|delivered|dead)
//   POST /event-deliveries/:id/retry            put a dead delivery back in the queue (audited, with a reason and the version)
//
// Permissions (src/server/authz/routeTable.ts): admin.integrations.view and admin.integrations.manage, which only Admin holds.
// What a subscription is (sink, target, event types, secret) never changes after creation: another destination is another subscription.
// A webhook destination must pass the SSRF guard and the LAN allow-list (EVENTS_WEBHOOK_ALLOWLIST) here and again at every delivery.
import { createHash, randomBytes } from 'crypto';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { eventDeliveries, eventSubscriptions, outboxEvents, DELIVERY_STATUSES, SUBSCRIPTION_SINKS, type EventDeliveryRow, type EventSubscriptionRow } from '../../db/schema/events';
import { writeAudit } from '../../db/utils';
import { signatureFields } from '../../lib/validations/signatures';
import { securityEventContext } from '../auth/events';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { updateVersioned, withTransaction } from '../core/tx';
import { getKeystore } from '../crypto/keystore';
import { signRecord } from '../esign';
import { catalogView, EVENT_TYPES, MAX_ATTEMPTS, newWebhookSecret, subscriptionSecretContext, wakeDispatchers } from '../events';
import { isEmailAddress, smtpConfig } from '../events/sinks/email';
import { dropDirOf, fileTargetProblem } from '../events/sinks/file';
import { checkWebhookUrl, configuredAllowList, DestinationError } from '../events/ssrf';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

const MEANING = 'ADMIN_AUTHORISATION';

const credentials = {
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: z.string('A reason is required.').trim().min(5, 'A reason of at least 5 characters is required.').max(500),
};

/** POST /event-subscriptions. id, secret, status, version and the creator are the server's. */
export const subscriptionCreateSchema = z.object({
  name: z.string('A name is required.').trim().min(3, 'The name needs at least 3 characters.').max(100),
  sink: z.enum(SUBSCRIPTION_SINKS, { error: `The sink is one of: ${SUBSCRIPTION_SINKS.join(', ')}.` }),
  target: z.string('A target is required.').trim().min(1).max(500),
  eventTypes: z.array(z.enum(EVENT_TYPES as [string, ...string[]], { error: `Event types are: ${EVENT_TYPES.join(', ')}.` }))
    .min(1, 'Choose at least one event type.')
    .refine(t => new Set(t).size === t.length, 'An event type is listed twice.'),
  ...credentials,
}).strict();

/** POST /event-subscriptions/:id/status */
export const subscriptionStatusSchema = z.object({
  status: z.enum(['Active', 'Disabled']),
  expectedVersion: z.number().int().min(1),
  ...credentials,
}).strict();

/** GET /event-subscriptions/:id/deliveries */
export const deliveryListQuerySchema = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

/** POST /event-deliveries/:id/retry */
export const deliveryRetrySchema = z.object({
  reason: credentials.reason,
  expectedVersion: z.number().int().min(1),
}).strict();

/** What the screen shows of a subscription. Never the secret or its ciphertext. */
export function subscriptionView(s: EventSubscriptionRow) {
  return {
    id: s.id, name: s.name, sink: s.sink, target: s.target, eventTypes: s.eventTypes, status: s.status, secretFingerprint: s.secretFingerprint,
    createdBy: s.createdBy, createdAt: s.createdAt.toISOString(), updatedBy: s.updatedBy, updatedAt: s.updatedAt?.toISOString() ?? null, version: s.version,
  };
}

export function deliveryView(d: EventDeliveryRow & { eventType?: string }) {
  return {
    id: d.id, eventId: d.eventId, eventType: d.eventType ?? null, subscriptionId: d.subscriptionId, status: d.status, attempts: d.attempts,
    maxAttempts: d.maxAttempts, nextAttemptAt: d.nextAttemptAt.toISOString(), lastStatusCode: d.lastStatusCode, lastError: d.lastError,
    deliveredAt: d.deliveredAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(), version: d.version,
  };
}

/** Checks the target for its sink before anyone signs. Throws a 400 with the reason. */
async function assertTarget(sink: (typeof SUBSCRIPTION_SINKS)[number], target: string) {
  if (sink === 'webhook') {
    try { await checkWebhookUrl(target, configuredAllowList()); } catch (e) {
      if (e instanceof DestinationError) throw new BadRequestError(e.message);
      throw e;
    }
  } else if (sink === 'email') {
    const c = smtpConfig();
    if (typeof c === 'string') throw new BadRequestError(c);
    if (!isEmailAddress(target)) throw new BadRequestError(`${target} is not an e-mail address.`);
  } else {
    const problem = fileTargetProblem(target);
    if (problem) throw new BadRequestError(problem);
  }
}

const isUniqueViolation = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';

export const subscriptionsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/event-subscriptions', requireAuth, async (_req, res) => {
    const rows = await db.select().from(eventSubscriptions).orderBy(desc(eventSubscriptions.createdAt), desc(eventSubscriptions.id));
    const counts = await db.select({ id: eventDeliveries.subscriptionId, status: eventDeliveries.status, n: count() })
      .from(eventDeliveries).groupBy(eventDeliveries.subscriptionId, eventDeliveries.status);
    const of = (id: string) => {
      const c = { pending: 0, delivered: 0, dead: 0 };
      for (const r of counts) if (r.id === id) {
        if (r.status === 'delivered') c.delivered += Number(r.n); else if (r.status === 'dead') c.dead += Number(r.n); else c.pending += Number(r.n);
      }
      return c;
    };
    const smtp = smtpConfig();
    res.json({
      subscriptions: rows.map(r => ({ ...subscriptionView(r), deliveries: of(r.id) })),
      catalog: catalogView(),
      sinks: {
        webhook: { configured: configuredAllowList().entries.length > 0, allowList: configuredAllowList().entries },
        email: { configured: typeof smtp !== 'string', problem: typeof smtp === 'string' ? smtp : null },
        file: { configured: dropDirOf() !== null },
      },
    });
  });

  router.post('/event-subscriptions', requireAuth, validate(subscriptionCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as z.infer<typeof subscriptionCreateSchema>;
    // Checked before the signature, so a refusal costs the signer no attempt; the unique index decides a race.
    const [taken] = await db.select({ id: eventSubscriptions.id }).from(eventSubscriptions).where(sql`lower(${eventSubscriptions.name}) = lower(${body.name})`).limit(1);
    if (taken) throw new ConflictError(`A subscription named "${body.name}" already exists (${taken.id}). Names are unique, ignoring case.`);
    await assertTarget(body.sink, body.target);

    const id = `sub-${randomBytes(6).toString('hex')}`;
    const secret = body.sink === 'webhook' ? newWebhookSecret() : null;
    const fingerprint = secret ? createHash('sha256').update(secret).digest('hex').slice(0, 16) : null;
    const eventTypes = [...body.eventTypes].sort();
    try {
      const { result } = await signRecord({
        db, user, meaningCode: MEANING, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
        entityType: 'EventSubscription', entityId: id, context: securityEventContext(req),
        execute: async (tx) => {
          const [row] = await tx.insert(eventSubscriptions).values({
            id, name: body.name, eventTypes, sink: body.sink, target: body.target,
            secretEnc: secret ? getKeystore().encrypt(secret, subscriptionSecretContext(id)) : null, secretFingerprint: fingerprint,
            status: 'Active', createdBy: user.id,
          }).returning();
          return {
            recordVersion: row.version,
            audit: {
              action: 'Create', field: 'status', oldValue: '', newValue: 'Active',
              reason: `${body.reason} [${body.sink} ${body.target}; events: ${eventTypes.join(', ')}${fingerprint ? `; secret ${fingerprint}` : ''}]`,
            },
            result: row,
          };
        },
      });
      res.status(201).json({ subscription: subscriptionView(result), ...(secret ? { secret } : {}) });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictError(`A subscription named "${body.name}" already exists. Names are unique, ignoring case.`);
      throw e;
    }
  });

  router.post('/event-subscriptions/:id/status', requireAuth, validate(subscriptionStatusSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof subscriptionStatusSchema>;
    const check = (s: EventSubscriptionRow | undefined): EventSubscriptionRow => {
      if (!s) throw new NotFoundError(`Subscription ${id} does not exist.`);
      if (s.version !== body.expectedVersion) throw new ConflictError();
      if (s.status === body.status) throw new BadRequestError(`Subscription ${id} is already ${body.status}.`);
      return s;
    };
    const before = check((await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, id)).limit(1))[0]);
    if (body.status === 'Active') await assertTarget(before.sink, before.target); // the configuration may have changed since it was disabled

    const { result } = await signRecord({
      db, user, meaningCode: MEANING, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
      entityType: 'EventSubscription', entityId: id, context: securityEventContext(req),
      execute: async (tx, afterCommit) => {
        const [locked] = await tx.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, id)).for('update').limit(1);
        const current = check(locked);
        const row = await updateVersioned(tx, eventSubscriptions, id, body.expectedVersion, { status: body.status, updatedBy: user.id, updatedAt: new Date() });
        if (body.status === 'Active') afterCommit(() => wakeDispatchers());
        return {
          recordVersion: row.version,
          audit: { action: body.status === 'Active' ? 'Enable' : 'Disable', field: 'status', oldValue: current.status, newValue: body.status, reason: body.reason },
          result: row,
        };
      },
    });
    res.json(subscriptionView(result));
  });

  router.get('/event-subscriptions/:id/deliveries', requireAuth, validate(deliveryListQuerySchema, 'query'), async (req, res) => {
    const id = String(req.params.id);
    const q = req.query as z.infer<typeof deliveryListQuerySchema>;
    const [sub] = await db.select({ id: eventSubscriptions.id }).from(eventSubscriptions).where(eq(eventSubscriptions.id, id)).limit(1);
    if (!sub) throw new NotFoundError(`Subscription ${id} does not exist.`);
    const rows = await db.select({ d: eventDeliveries, eventType: outboxEvents.type }).from(eventDeliveries)
      .innerJoin(outboxEvents, eq(outboxEvents.id, eventDeliveries.eventId))
      .where(and(eq(eventDeliveries.subscriptionId, id), q.status ? eq(eventDeliveries.status, q.status) : undefined))
      .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id)).limit(q.limit ?? 100);
    res.json({ deliveries: rows.map(r => deliveryView({ ...r.d, eventType: r.eventType })) });
  });

  router.post('/event-deliveries/:id/retry', requireAuth, validate(deliveryRetrySchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof deliveryRetrySchema>;
    const row = await withTransaction(db, async (tx, afterCommit) => {
      const [d] = await tx.select().from(eventDeliveries).where(eq(eventDeliveries.id, id)).for('update').limit(1);
      if (!d) throw new NotFoundError(`Delivery ${id} does not exist.`);
      if (d.version !== body.expectedVersion) throw new ConflictError();
      if (d.status !== 'dead') throw new ConflictError(`Only a dead delivery can be requeued; delivery ${id} is ${d.status}.`);
      // The attempt counter keeps the true total; the requeue grants a new budget of MAX_ATTEMPTS.
      const updated = await updateVersioned(tx, eventDeliveries, id, body.expectedVersion, {
        status: 'pending', nextAttemptAt: new Date(), maxAttempts: d.attempts + MAX_ATTEMPTS, lockedBy: null, lockedAt: null,
      });
      await writeAudit(tx, user.id, 'Requeue', 'EventDelivery', id, 'status', 'dead', 'pending', body.reason);
      afterCommit(() => wakeDispatchers());
      return updated;
    });
    res.json(deliveryView(row));
  });

  return router;
};
