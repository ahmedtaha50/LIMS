// Domain: the stability programme (roadmap M31, r2-stability; ICH Q1A(R2), 21 CFR 211.166). Migration 0240_stability.
//
//   stability_conditions    the storage condition master (editable configuration): temperature and relative humidity set points with
//                           their tolerances and the ICH role of the condition (Long-term, Intermediate, Accelerated, ...). The ICH
//                           Q1A(R2) conditions are installed (origin 'installed'); a site adds or deactivates its own.
//   stability_chambers      the chambers that hold a condition (one condition per chamber).
//   stability_protocols     the controlled protocol: product, test plan, conditions (a snapshot of each condition as it was when the
//                           protocol was written), month points and pull window. Draft, then Approved with an e-signature
//                           (STABILITY_PROTOCOL_APPROVAL) by someone other than its author; an Approved revision is never edited: a
//                           change is a new revision, signed again, and the earlier one becomes Superseded.
//   stability_study_links   1:1 sidecar of stability_studies (whose columns predate M31): the protocol revision, product and batch a
//                           study was started from. Written once, with the study. A study without a row predates M31 (legacy).
//   stability_timepoints    one per (study, condition, month point): due date, pull window, chamber and state. Scheduled -> Due ->
//                           (pull) Pulled -> InTesting -> Complete, or Missed when the window closes without a pull. The scheduler
//                           moves Scheduled/Due/Missed and follows the pull sample; a person only pulls.
// Dates (due_date, window_*) are calendar days, YYYY-MM-DD, compared with the server's local calendar date (todayIso).
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { stabilityStudies } from './equipment';
import { users } from './identity';
import { productBatches, products } from './master';
import { qmsRecords } from './qms';
import { samples } from './samples';

export const STABILITY_CONDITION_CATEGORIES = ['Long-term', 'Intermediate', 'Accelerated', 'Stress', 'Other'] as const;
export const STABILITY_CONDITION_STATUSES = ['Active', 'Inactive'] as const;
export const STABILITY_CHAMBER_STATUSES = ['Active', 'Inactive', 'Out of Service'] as const;
export const STABILITY_PROTOCOL_STATUSES = ['Draft', 'Approved', 'Superseded'] as const;
export const STABILITY_TIMEPOINT_STATUSES = ['Scheduled', 'Due', 'Pulled', 'InTesting', 'Complete', 'Missed'] as const;

/** A condition as the protocol holds it: copied when the protocol is saved, so a later edit of the master does not change it. */
export interface ProtocolCondition {
  conditionId: string;
  code: string;
  name: string;
  category: string;
  temperatureC: string;
  temperatureToleranceC: string;
  humidityRh: string | null;
  humidityToleranceRh: string | null;
}

export const stabilityConditions = pgTable('stability_conditions', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  temperatureC: numeric('temperature_c').notNull(),
  temperatureToleranceC: numeric('temperature_tolerance_c').notNull(),
  humidityRh: numeric('humidity_rh'), // null: humidity is not controlled (refrigerator, freezer)
  humidityToleranceRh: numeric('humidity_tolerance_rh'),
  status: text('status').default('Active').notNull(),
  origin: text('origin').default('entry').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('stability_conditions_code_uidx').on(sql`lower(${t.code})`),
  index('stability_conditions_created_by_idx').on(t.createdBy),
  check('stability_conditions_category_check', sql`${t.category} IN ('Long-term', 'Intermediate', 'Accelerated', 'Stress', 'Other')`),
  check('stability_conditions_status_check', sql`${t.status} IN ('Active', 'Inactive')`),
  check('stability_conditions_humidity_check', sql`(${t.humidityRh} IS NULL) = (${t.humidityToleranceRh} IS NULL)`),
  check('stability_conditions_tolerance_check', sql`${t.temperatureToleranceC} >= 0 AND (${t.humidityToleranceRh} IS NULL OR ${t.humidityToleranceRh} >= 0)`),
]);

export const stabilityChambers = pgTable('stability_chambers', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  conditionId: text('condition_id').notNull().references(() => stabilityConditions.id),
  location: text('location'),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('stability_chambers_code_uidx').on(sql`lower(${t.code})`),
  index('stability_chambers_condition_id_idx').on(t.conditionId),
  index('stability_chambers_created_by_idx').on(t.createdBy),
  check('stability_chambers_status_check', sql`${t.status} IN ('Active', 'Inactive', 'Out of Service')`),
]);

export const stabilityProtocols = pgTable('stability_protocols', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  productId: text('product_id').notNull().references(() => products.id),
  testPlanCode: text('test_plan_code').notNull(),
  conditions: jsonb('conditions').$type<ProtocolCondition[]>().notNull(),
  monthPoints: jsonb('month_points').$type<number[]>().notNull(),
  windowDays: integer('window_days').notNull(),
  revision: integer('revision').notNull(),
  status: text('status').default('Draft').notNull(),
  createdBy: text('created_by').references(() => users.id),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('stability_protocols_code_revision_uidx').on(t.code, t.revision),
  uniqueIndex('stability_protocols_one_draft_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Draft'`),
  uniqueIndex('stability_protocols_one_approved_uidx').on(sql`lower(${t.code})`).where(sql`${t.status} = 'Approved'`),
  index('stability_protocols_product_id_idx').on(t.productId),
  index('stability_protocols_created_by_idx').on(t.createdBy),
  index('stability_protocols_approved_by_idx').on(t.approvedBy),
  check('stability_protocols_status_check', sql`${t.status} IN ('Draft', 'Approved', 'Superseded')`),
  check('stability_protocols_window_check', sql`${t.windowDays} BETWEEN 0 AND 60`),
]);

export const stabilityStudyLinks = pgTable('stability_study_links', {
  studyId: text('study_id').primaryKey().references(() => stabilityStudies.id),
  protocolId: text('protocol_id').notNull().references(() => stabilityProtocols.id),
  productId: text('product_id').notNull().references(() => products.id),
  batchId: text('batch_id').notNull().references(() => productBatches.id),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('stability_study_links_protocol_id_idx').on(t.protocolId),
  index('stability_study_links_product_id_idx').on(t.productId),
  index('stability_study_links_batch_id_idx').on(t.batchId),
  index('stability_study_links_created_by_idx').on(t.createdBy),
]);

export const stabilityTimepoints = pgTable('stability_timepoints', {
  id: text('id').primaryKey(),
  studyId: text('study_id').notNull().references(() => stabilityStudies.id),
  conditionId: text('condition_id').notNull().references(() => stabilityConditions.id),
  conditionCode: text('condition_code').notNull(),
  chamberId: text('chamber_id').references(() => stabilityChambers.id),
  month: integer('month').notNull(),
  dueDate: text('due_date').notNull(),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  status: text('status').default('Scheduled').notNull(),
  sampleId: text('sample_id').references(() => samples.id),
  pulledBy: text('pulled_by').references(() => users.id),
  pulledAt: timestamp('pulled_at', { withTimezone: true }),
  missedAt: timestamp('missed_at', { withTimezone: true }),
  deviationId: text('deviation_id').references(() => qmsRecords.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('stability_timepoints_point_uidx').on(t.studyId, t.conditionId, t.month),
  uniqueIndex('stability_timepoints_sample_id_uidx').on(t.sampleId),
  index('stability_timepoints_condition_id_idx').on(t.conditionId),
  index('stability_timepoints_chamber_id_idx').on(t.chamberId),
  index('stability_timepoints_status_idx').on(t.status, t.windowStart),
  index('stability_timepoints_pulled_by_idx').on(t.pulledBy),
  index('stability_timepoints_deviation_id_idx').on(t.deviationId),
  check('stability_timepoints_status_check', sql`${t.status} IN ('Scheduled', 'Due', 'Pulled', 'InTesting', 'Complete', 'Missed')`),
  check('stability_timepoints_window_check', sql`${t.windowStart} <= ${t.dueDate} AND ${t.dueDate} <= ${t.windowEnd}`),
  check('stability_timepoints_month_check', sql`${t.month} BETWEEN 0 AND 120`),
]);
