// Domain: events, notifications and outbound integrations (roadmap M23, migration 0150_events). r2-events owns this file.
//
//   outbox_events         one row per business event (src/server/events/catalog.ts), written by emitEvent() in the transaction of the change
//                         that caused it: a rolled-back change leaves no event, so nothing is ever announced that did not happen. The
//                         dispatcher (src/server/events/dispatcher.ts) claims rows with FOR UPDATE SKIP LOCKED and fans each out once
//                         (fanned_out_at). The payload never holds a result value (the catalog's strict schemas).
//   notifications         the persistent per-user copy of an event, for every active user whose role holds the event's audience
//                         permission at fan-out time: a user who was away sees it at the next sign-in. Not a GxP record and never a
//                         substitute for a signature; read_at is the user's own state.
//   event_subscriptions   outbound sinks chosen by an Administrator: a signed webhook (HMAC-SHA256 with the subscription's own secret,
//                         kept encrypted by the keystore), an e-mail address (SMTP) or a folder under the drop directory (ERP). Created,
//                         disabled and re-enabled with an e-signature (ADMIN_AUTHORISATION, record type EventSubscription) bound to
//                         `version`. What a subscription is (sink, target, event types, secret) never changes after creation.
//   event_deliveries      one row per (event, subscription): attempts, back-off, dead letter. Claimed with FOR UPDATE SKIP LOCKED under a
//                         lease (locked_by); every change increments `version`.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const SUBSCRIPTION_SINKS = ['webhook', 'email', 'file'] as const;
export type SubscriptionSink = (typeof SUBSCRIPTION_SINKS)[number];
export const SUBSCRIPTION_STATUSES = ['Active', 'Disabled'] as const;
export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const outboxEvents = pgTable('outbox_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  typeVersion: integer('type_version').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** A permission code, or '*' for every active user. */
  audience: text('audience').notNull(),
  actorId: text('actor_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  fannedOutAt: timestamp('fanned_out_at', { withTimezone: true }),
}, (t) => [
  index('outbox_events_pending_idx').on(t.createdAt).where(sql`${t.fannedOutAt} IS NULL`),
  index('outbox_events_actor_id_idx').on(t.actorId),
  check('outbox_events_payload_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
]);

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  eventId: text('event_id').notNull().references(() => outboxEvents.id),
  type: text('type').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  href: text('href'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('notifications_user_id_event_id_uidx').on(t.userId, t.eventId),
  index('notifications_user_id_created_at_idx').on(t.userId, t.createdAt),
  index('notifications_event_id_idx').on(t.eventId),
]);

export const eventSubscriptions = pgTable('event_subscriptions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  eventTypes: jsonb('event_types').$type<string[]>().notNull(),
  sink: text('sink').$type<SubscriptionSink>().notNull(),
  /** webhook: the URL; email: the address; file: the folder name under EVENTS_DROP_DIR. */
  target: text('target').notNull(),
  /** webhook only: the HMAC secret, keystore ciphertext bound to this row. */
  secretEnc: text('secret_enc'),
  /** webhook only: the first 16 hex digits of SHA-256(secret), so a receiver's configuration can be compared without the secret. */
  secretFingerprint: text('secret_fingerprint'),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('event_subscriptions_name_lower_uidx').on(sql`lower(${t.name})`),
  index('event_subscriptions_created_by_idx').on(t.createdBy),
  index('event_subscriptions_updated_by_idx').on(t.updatedBy),
  check('event_subscriptions_sink_check', sql`${t.sink} IN ('webhook', 'email', 'file')`),
  check('event_subscriptions_status_check', sql`${t.status} IN ('Active', 'Disabled')`),
  check('event_subscriptions_event_types_check', sql`jsonb_typeof(${t.eventTypes}) = 'array'`),
  check('event_subscriptions_secret_check', sql`(${t.sink} = 'webhook') = (${t.secretEnc} IS NOT NULL)`),
]);

export const eventDeliveries = pgTable('event_deliveries', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => outboxEvents.id),
  subscriptionId: text('subscription_id').notNull().references(() => eventSubscriptions.id),
  status: text('status').$type<DeliveryStatus>().default('pending').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('event_deliveries_event_id_subscription_id_uidx').on(t.eventId, t.subscriptionId),
  index('event_deliveries_due_idx').on(t.status, t.nextAttemptAt),
  index('event_deliveries_subscription_id_idx').on(t.subscriptionId),
  check('event_deliveries_status_check', sql`${t.status} IN ('pending', 'sending', 'delivered', 'dead')`),
]);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type EventSubscriptionRow = typeof eventSubscriptions.$inferSelect;
export type EventDeliveryRow = typeof eventDeliveries.$inferSelect;
