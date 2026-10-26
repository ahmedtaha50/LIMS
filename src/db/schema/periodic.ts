// Domain: periodic review, retention and archive (roadmap M42, migration 0330_periodic_archive). r3-periodic-archive owns this file.
//
//   periodic_review_plans   what is reviewed (kind + subject), how often, when next due, and the checklist template.
//   periodic_reviews        one review for one due date; Open -> Completed (QA e-signature) | Cancelled. Evidence is fixed at opening.
//   retention_policies      years to keep per record class; no row or NULL years = keep indefinitely (the conservative default).
//   legal_holds             a hold on a record class (or one record); blocks flagging for purge.
//   retention_flags         an archived record flagged for disposal REVIEW. Nothing in the application deletes a GxP record.
//   archive_bundles         the register of verifiable export bundles; Built -> Archived by a QA e-signature bound to the manifest hash.
//   archived_records        the sidecar that marks records archived (read-only); written once, never changed.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const REVIEW_KINDS = ['user_access', 'instrument', 'specification', 'method', 'document', 'module', 'system'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const REVIEW_CONCLUSIONS = ['Satisfactory', 'SatisfactoryWithActions', 'Unsatisfactory'] as const;

export interface ReviewFinding { text: string; severity: 'Observation' | 'Minor' | 'Major' | 'Critical'; qmsRecordId?: string }
export interface ChecklistAnswer { item: string; answer: 'Yes' | 'No' | 'NotApplicable'; comment?: string }

export const periodicReviewPlans = pgTable('periodic_review_plans', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  subjectId: text('subject_id').notNull(), // the record reviewed; '*' for a whole-system kind (user_access, system)
  title: text('title').notNull(),
  intervalMonths: integer('interval_months').notNull(),
  nextDueDate: text('next_due_date').notNull(), // YYYY-MM-DD
  checklist: jsonb('checklist').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('periodic_review_plans_active_uidx').on(t.kind, t.subjectId).where(sql`${t.status} = 'Active'`),
  index('periodic_review_plans_next_due_idx').on(t.nextDueDate),
  index('periodic_review_plans_created_by_idx').on(t.createdBy),
  check('periodic_review_plans_kind_check', sql`${t.kind} IN ('user_access', 'instrument', 'specification', 'method', 'document', 'module', 'system')`),
  check('periodic_review_plans_status_check', sql`${t.status} IN ('Active', 'Retired')`),
  check('periodic_review_plans_interval_check', sql`${t.intervalMonths} BETWEEN 1 AND 120`),
  check('periodic_review_plans_due_check', sql`${t.nextDueDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
]);

export const periodicReviews = pgTable('periodic_reviews', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => periodicReviewPlans.id),
  kind: text('kind').notNull(),
  subjectId: text('subject_id').notNull(),
  title: text('title').notNull(),
  dueDate: text('due_date').notNull(),
  status: text('status').default('Open').notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  evidenceSha256: text('evidence_sha256').notNull(),
  evidenceGeneratedAt: timestamp('evidence_generated_at', { withTimezone: true }).notNull(),
  checklist: jsonb('checklist').$type<ChecklistAnswer[]>().default(sql`'[]'::jsonb`).notNull(),
  findings: jsonb('findings').$type<ReviewFinding[]>().default(sql`'[]'::jsonb`).notNull(),
  conclusion: text('conclusion'),
  summary: text('summary'),
  openedBy: text('opened_by').notNull().references(() => users.id),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  completedBy: text('completed_by').references(() => users.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('periodic_reviews_one_open_per_plan_uidx').on(t.planId).where(sql`${t.status} = 'Open'`),
  index('periodic_reviews_plan_id_idx').on(t.planId),
  index('periodic_reviews_status_due_idx').on(t.status, t.dueDate),
  index('periodic_reviews_opened_by_idx').on(t.openedBy),
  index('periodic_reviews_completed_by_idx').on(t.completedBy),
  check('periodic_reviews_status_check', sql`${t.status} IN ('Open', 'Completed', 'Cancelled')`),
  check('periodic_reviews_conclusion_check', sql`${t.conclusion} IS NULL OR ${t.conclusion} IN ('Satisfactory', 'SatisfactoryWithActions', 'Unsatisfactory')`),
  check('periodic_reviews_completed_check', sql`${t.status} <> 'Completed' OR (${t.conclusion} IS NOT NULL AND ${t.completedBy} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`),
]);

export const retentionPolicies = pgTable('retention_policies', {
  recordClass: text('record_class').primaryKey(),
  retentionYears: integer('retention_years'), // NULL = keep indefinitely
  basis: text('basis').notNull(),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('retention_policies_updated_by_idx').on(t.updatedBy),
  check('retention_policies_years_check', sql`${t.retentionYears} IS NULL OR ${t.retentionYears} BETWEEN 1 AND 100`),
  check('retention_policies_basis_check', sql`length(btrim(${t.basis})) >= 5`),
]);

export const legalHolds = pgTable('legal_holds', {
  id: text('id').primaryKey(),
  recordClass: text('record_class').notNull(),
  scopeRef: text('scope_ref'), // NULL = the whole class
  reason: text('reason').notNull(),
  status: text('status').default('Active').notNull(),
  placedBy: text('placed_by').notNull().references(() => users.id),
  placedAt: timestamp('placed_at', { withTimezone: true }).defaultNow().notNull(),
  releasedBy: text('released_by').references(() => users.id),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('legal_holds_class_status_idx').on(t.recordClass, t.status),
  index('legal_holds_placed_by_idx').on(t.placedBy),
  index('legal_holds_released_by_idx').on(t.releasedBy),
  check('legal_holds_status_check', sql`${t.status} IN ('Active', 'Released')`),
  check('legal_holds_reason_check', sql`length(btrim(${t.reason})) >= 5`),
  check('legal_holds_released_check', sql`${t.status} = 'Active' OR (${t.releasedBy} IS NOT NULL AND ${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL)`),
]);

export const archiveBundles = pgTable('archive_bundles', {
  id: text('id').primaryKey(),
  kind: text('kind').default('batch').notNull(),
  subjectId: text('subject_id').notNull(),
  subjectLabel: text('subject_label').notNull(),
  dirName: text('dir_name').notNull(), // relative to ARCHIVE_DIR
  manifestSha256: text('manifest_sha256').notNull(),
  fileCount: integer('file_count').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  recordCounts: jsonb('record_counts').$type<Record<string, number>>().notNull(),
  status: text('status').default('Built').notNull(),
  builtBy: text('built_by').notNull().references(() => users.id),
  builtAt: timestamp('built_at', { withTimezone: true }).defaultNow().notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastVerifiedOk: boolean('last_verified_ok'),
  decidedBy: text('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('archive_bundles_one_archived_per_subject_uidx').on(t.kind, t.subjectId).where(sql`${t.status} = 'Archived'`),
  index('archive_bundles_built_by_idx').on(t.builtBy),
  index('archive_bundles_decided_by_idx').on(t.decidedBy),
  check('archive_bundles_kind_check', sql`${t.kind} IN ('batch')`),
  check('archive_bundles_status_check', sql`${t.status} IN ('Built', 'Archived')`),
  check('archive_bundles_manifest_check', sql`${t.manifestSha256} ~ '^[0-9a-f]{64}$'`),
  check('archive_bundles_archived_check', sql`${t.status} <> 'Archived' OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`),
]);

export const archivedRecords = pgTable('archived_records', {
  id: text('id').primaryKey(), // <entityType>:<entityId> (drizzle-kit's introspection fails on a composite primary key; the pair is unique below)
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  bundleId: text('bundle_id').notNull().references(() => archiveBundles.id),
  archivedBy: text('archived_by').notNull().references(() => users.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('archived_records_entity_uidx').on(t.entityType, t.entityId),
  index('archived_records_bundle_id_idx').on(t.bundleId),
  index('archived_records_archived_by_idx').on(t.archivedBy),
]);

export const retentionFlags = pgTable('retention_flags', {
  id: text('id').primaryKey(),
  recordClass: text('record_class').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').default('Flagged').notNull(),
  flaggedBy: text('flagged_by').notNull().references(() => users.id),
  flaggedAt: timestamp('flagged_at', { withTimezone: true }).defaultNow().notNull(),
  withdrawnBy: text('withdrawn_by').references(() => users.id),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('retention_flags_entity_idx').on(t.entityType, t.entityId),
  index('retention_flags_flagged_by_idx').on(t.flaggedBy),
  index('retention_flags_withdrawn_by_idx').on(t.withdrawnBy),
  uniqueIndex('retention_flags_one_flagged_uidx').on(t.entityType, t.entityId).where(sql`${t.status} = 'Flagged'`),
  check('retention_flags_status_check', sql`${t.status} IN ('Flagged', 'Withdrawn')`),
]);
