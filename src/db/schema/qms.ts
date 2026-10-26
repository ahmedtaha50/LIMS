// Domain: quality management (roadmap M27, migration 0180_qms). r2-qms owns this file.
//
//   qms_records               deviations, CAPA, change controls and audit findings: one table, `type` says which. Each type has its own
//                             lifecycle (src/server/qms/states.ts). `payload` holds the per-type fields, validated by a strict Zod schema
//                             per type (src/server/qms/schemas.ts). `version` is the optimistic-concurrency counter.
//   qms_actions               the actions of a record, each with an owner and a due date; completed with an e-signature and evidence.
//   qms_links                 the record's CAPA, what a change control affects (and where it was implemented), the batch or sample it is
//                             about. Append-only.
//   qms_comments              append-only discussion.
//   qms_effectiveness_checks  each signed effectiveness check of a CAPA. Append-only.
//   qms_settings              one row ('default'): change_control_required. Changed only with an e-signature.
// Dates (due_date) are calendar days, YYYY-MM-DD, compared with the server's local calendar date (src/server/lib/specs.ts todayIso).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const QMS_TYPES = ['Deviation', 'CAPA', 'ChangeControl', 'AuditFinding'] as const;
export const QMS_CLASSIFICATIONS = ['Minor', 'Major', 'Critical'] as const;
export const QMS_ACTION_STATUSES = ['Open', 'Done', 'Cancelled'] as const;
export const QMS_LINK_RELATIONS = ['capa', 'affects', 'related', 'source', 'implemented'] as const;

export const qmsRecords = pgTable('qms_records', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  description: text('description').default('').notNull(),
  classification: text('classification'),
  state: text('state').notNull(),
  ownerId: text('owner_id').references(() => users.id),
  dueDate: text('due_date'),
  payload: jsonb('payload').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  origin: text('origin').default('manual').notNull(),
  sourceType: text('source_type'),
  sourceId: text('source_id'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('qms_records_type_state_idx').on(t.type, t.state),
  index('qms_records_owner_id_idx').on(t.ownerId),
  index('qms_records_created_by_idx').on(t.createdBy),
  uniqueIndex('qms_records_auto_source_uidx').on(t.type, t.sourceType, t.sourceId).where(sql`${t.origin} <> 'manual'`),
  check('qms_records_type_check', sql`${t.type} IN ('Deviation', 'CAPA', 'ChangeControl', 'AuditFinding')`),
  check('qms_records_classification_check', sql`${t.classification} IS NULL OR ${t.classification} IN ('Minor', 'Major', 'Critical')`),
]);

export const qmsActions = pgTable('qms_actions', {
  id: text('id').primaryKey(),
  recordId: text('record_id').notNull().references(() => qmsRecords.id),
  title: text('title').notNull(),
  description: text('description').default('').notNull(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  dueDate: text('due_date').notNull(),
  status: text('status').default('Open').notNull(),
  evidenceRef: text('evidence_ref'),
  completedBy: text('completed_by').references(() => users.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('qms_actions_record_id_idx').on(t.recordId),
  index('qms_actions_owner_id_idx').on(t.ownerId),
  index('qms_actions_completed_by_idx').on(t.completedBy),
  index('qms_actions_created_by_idx').on(t.createdBy),
  check('qms_actions_status_check', sql`${t.status} IN ('Open', 'Done', 'Cancelled')`),
]);

export const qmsLinks = pgTable('qms_links', {
  id: text('id').primaryKey(),
  recordId: text('record_id').notNull().references(() => qmsRecords.id),
  relation: text('relation').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('qms_links_record_relation_target_uidx').on(t.recordId, t.relation, t.targetType, t.targetId),
  index('qms_links_target_idx').on(t.targetType, t.targetId),
  index('qms_links_created_by_idx').on(t.createdBy),
  check('qms_links_relation_check', sql`${t.relation} IN ('capa', 'affects', 'related', 'source', 'implemented')`),
]);

export const qmsComments = pgTable('qms_comments', {
  id: text('id').primaryKey(),
  recordId: text('record_id').notNull().references(() => qmsRecords.id),
  authorId: text('author_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('qms_comments_record_id_idx').on(t.recordId),
  index('qms_comments_author_id_idx').on(t.authorId),
]);

export const qmsEffectivenessChecks = pgTable('qms_effectiveness_checks', {
  id: text('id').primaryKey(),
  recordId: text('record_id').notNull().references(() => qmsRecords.id),
  result: text('result').notNull(),
  evidence: text('evidence').notNull(),
  recordVersion: integer('record_version').notNull(), // the CAPA version the check was made on
  checkedBy: text('checked_by').notNull().references(() => users.id),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('qms_effectiveness_checks_record_id_idx').on(t.recordId),
  index('qms_effectiveness_checks_checked_by_idx').on(t.checkedBy),
  check('qms_effectiveness_checks_result_check', sql`${t.result} IN ('Effective', 'Not effective')`),
]);

export const qmsSettings = pgTable('qms_settings', {
  id: text('id').primaryKey(),
  changeControlRequired: boolean('change_control_required').default(false).notNull(),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('qms_settings_updated_by_idx').on(t.updatedBy),
]);
