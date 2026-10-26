// Domain: audit trail and security events. Split out of src/db/schema.ts by r1-migrations; r1-audit owns this file.
// All three tables are append-only (see src/db/protections/audit.ts). The hashes cover `timestamp_str`, never the `timestamp`
// column; the formulas are in src/server/audit/hash.ts.
import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const auditTrail = pgTable('audit_trail', {
  id: text('id').primaryKey(),
  sequence: integer('sequence').notNull().unique(), // Immutable order
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  timestampStr: text('timestamp_str'),
  userId: text('user_id').notNull(),
  // Who/where snapshot taken when the action happened (audit v2; null on rows written before, and for actors that are not users).
  actorName: text('actor_name'),
  actorRole: text('actor_role'),
  sessionId: text('session_id'),
  appVersion: text('app_version'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  field: text('field').notNull(),
  oldValue: text('old_value').notNull(),
  newValue: text('new_value').notNull(),
  reason: text('reason').notNull(),
  hash: text('hash').notNull(), // Cryptographic link
  prevHash: text('prev_hash').notNull(),
  hashVersion: integer('hash_version').notNull().default(1), // 1: link only (before audit v2); 2: link + seal
  hashAlg: text('hash_alg').notNull().default('sha256'),
  seal: text('seal'), // v2: covers the snapshot above, chained to the previous seal
}, (t) => [
  index('audit_trail_entity_idx').on(t.entity, t.entityId),
  index('audit_trail_user_id_idx').on(t.userId),
  index('audit_trail_action_idx').on(t.action),
  index('audit_trail_timestamp_idx').on(t.timestamp),
]);

/** (sequence, hash, seal) of the audit row at every 5,000th sequence: where bounded verification starts. */
export const auditCheckpoints = pgTable('audit_checkpoints', {
  sequence: integer('sequence').primaryKey(),
  hash: text('hash').notNull(),
  seal: text('seal'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Sign-in, lockout, refusal, export and configuration events, in their own hash chain. */
export const securityEvents = pgTable('security_events', {
  id: text('id').primaryKey(),
  sequence: integer('sequence').notNull().unique(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  timestampStr: text('timestamp_str').notNull(),
  eventType: text('event_type').notNull(),
  outcome: text('outcome').notNull(), // success | failure | denied | info
  actorId: text('actor_id'), // null when nobody was identified (a failed login for an unknown address)
  actorLabel: text('actor_label'), // what the actor claimed to be (the e-mail address typed at the login)
  actorRole: text('actor_role'),
  sessionId: text('session_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  detail: text('detail').notNull().default(''), // JSON text, credentials removed, at most 4,000 characters
  appVersion: text('app_version'),
  hashVersion: integer('hash_version').notNull().default(1),
  hashAlg: text('hash_alg').notNull().default('sha256'),
  hash: text('hash').notNull(),
  prevHash: text('prev_hash').notNull(),
}, (t) => [
  index('security_events_event_type_idx').on(t.eventType),
  index('security_events_actor_id_idx').on(t.actorId),
  index('security_events_timestamp_idx').on(t.timestamp),
]);
