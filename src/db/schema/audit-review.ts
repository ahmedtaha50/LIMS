// Domain: audit-trail review and tamper evidence (roadmap M35, migration 0170_audit_review). r2-audit-tamper owns this file.
//
//   audit_reviews           signed reviews (AUDIT_REVIEW) of a batch's audit rows or of a sequence range. Append-only.
//   audit_review_settings   one row ('default'): required_for_release. Changed only with an e-signature (AUDIT_REVIEW_SETTING).
//   audit_anchors           the register of the anchor files written to the second path (src/server/audit/anchors.ts). Append-only.
//   clock_state             one row ('default'): the clock guard's watermark (src/server/audit/clockGuard.ts).
//   clock_anomalies         clock set-backs found by the guard; acknowledged with an e-signature (CLOCK_ANOMALY_ACK).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const AUDIT_REVIEW_SCOPES = ['batch', 'range'] as const;

export const auditReviews = pgTable('audit_reviews', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  scopeId: text('scope_id'),
  fromSequence: integer('from_sequence').notNull(),
  toSequence: integer('to_sequence').notNull(),
  rowsReviewed: integer('rows_reviewed').notNull(),
  exceptionCount: integer('exception_count').notNull(),
  comment: text('comment').default('').notNull(),
  reviewerId: text('reviewer_id').notNull().references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('audit_reviews_scope_idx').on(t.scope, t.scopeId),
  index('audit_reviews_reviewer_id_idx').on(t.reviewerId),
  check('audit_reviews_scope_check', sql`${t.scope} IN ('batch', 'range')`),
  check('audit_reviews_scope_id_check', sql`(${t.scope} = 'batch') = (${t.scopeId} IS NOT NULL)`),
  check('audit_reviews_range_check', sql`${t.fromSequence} >= 1 AND ${t.fromSequence} <= ${t.toSequence}`),
]);

export const auditReviewSettings = pgTable('audit_review_settings', {
  id: text('id').primaryKey(),
  requiredForRelease: boolean('required_for_release').default(false).notNull(),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('audit_review_settings_updated_by_idx').on(t.updatedBy),
]);

export const auditAnchors = pgTable('audit_anchors', {
  id: text('id').primaryKey(),
  sequence: integer('sequence').notNull(),
  hash: text('hash').notNull(),
  seal: text('seal'),
  securitySequence: integer('security_sequence'),
  securityHash: text('security_hash'),
  anchoredAt: timestamp('anchored_at', { withTimezone: true }).notNull(),
  fileName: text('file_name').notNull(),
  keyGeneration: integer('key_generation').notNull(),
  hmac: text('hmac').notNull(),
  createdBy: text('created_by'),
}, (t) => [
  index('audit_anchors_sequence_idx').on(t.sequence),
]);

export const clockState = pgTable('clock_state', {
  id: text('id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const clockAnomalies = pgTable('clock_anomalies', {
  id: text('id').primaryKey(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
  watermark: timestamp('watermark', { withTimezone: true }).notNull(),
  behindMs: bigint('behind_ms', { mode: 'number' }).notNull(),
  source: text('source').notNull(),
  acknowledgedBy: text('acknowledged_by').references(() => users.id),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  ackReason: text('ack_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('clock_anomalies_open_idx').on(t.acknowledgedAt),
  index('clock_anomalies_acknowledged_by_idx').on(t.acknowledgedBy),
]);
