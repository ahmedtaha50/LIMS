// Domain: the environmental monitoring programme (roadmap M32, migration 0250_em). r2-em owns this file.
//
//   em_sampling_points   the site map: one row per sampling point, in a room, with the cleanroom grade it is judged by. Maintained by
//                        QA (env.manage), every change versioned and audited with a reason. Retired, never deleted.
//   em_limit_profiles    alert/action limits per grade, method and occupancy state (and ISO class for particles), with the source
//                        they are taken from. Draft (editable) -> Approved (e-signed EM_LIMIT_APPROVAL, by someone who did not write
//                        it) -> Retired (superseded by the next approval for the same key). Only an Approved profile judges a result.
//   em_results           one reading at a point: viable (CFU, with media lot and incubation) or total particles. Status, unit, limits
//                        and grade are the server's, copied from the point and the profile in force when it was judged.
//   em_excursions        one per action-level result, opened in the result's transaction with its deviation (M27). Append-only.
//   em_batch_rooms       where and when a batch was exposed: room and date window. The batch impact of a result is read from it.
//   em_trend_flags       adverse trends found by the scheduled evaluation (src/server/em/trends.ts); acknowledged by QA.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { productBatches } from './master';
import { qmsRecords } from './qms';

export const emSamplingPoints = pgTable('em_sampling_points', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  room: text('room').notNull(),
  description: text('description').notNull(),
  grade: text('grade').notNull(),
  status: text('status').default('Active').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('em_sampling_points_code_lower_uidx').on(sql`lower(${t.code})`),
  index('em_sampling_points_room_idx').on(t.room),
  index('em_sampling_points_created_by_idx').on(t.createdBy),
  check('em_sampling_points_status_check', sql`${t.status} IN ('Active', 'Retired')`),
  check('em_sampling_points_grade_check', sql`${t.grade} IN ('Grade A', 'Grade B', 'Grade C', 'Grade D')`),
]);

export const emLimitProfiles = pgTable('em_limit_profiles', {
  id: text('id').primaryKey(),
  grade: text('grade').notNull(),
  method: text('method').notNull(),
  occupancy: text('occupancy').notNull(),
  isoClass: text('iso_class'),
  unit: text('unit').notNull(),
  alertLimit: integer('alert_limit'), // null: the site has not set one
  actionLimit: integer('action_limit').notNull(), // a count above it is an action-level result
  source: text('source').notNull(),
  status: text('status').default('Draft').notNull(),
  origin: text('origin').default('entry').notNull(),
  createdBy: text('created_by').references(() => users.id), // null for the drafts migration 0250 wrote
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  supersededBy: text('superseded_by'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('em_limit_profiles_approved_uidx').on(t.grade, t.method, t.occupancy).where(sql`${t.status} = 'Approved'`),
  index('em_limit_profiles_created_by_idx').on(t.createdBy),
  index('em_limit_profiles_approved_by_idx').on(t.approvedBy),
  check('em_limit_profiles_status_check', sql`${t.status} IN ('Draft', 'Approved', 'Retired')`),
  check('em_limit_profiles_occupancy_check', sql`${t.occupancy} IN ('In operation', 'At rest')`),
  check('em_limit_profiles_limits_check', sql`${t.actionLimit} >= 0 AND (${t.alertLimit} IS NULL OR (${t.alertLimit} >= 0 AND ${t.alertLimit} <= ${t.actionLimit}))`),
]);

export const emResults = pgTable('em_results', {
  id: text('id').primaryKey(),
  pointId: text('point_id').notNull().references(() => emSamplingPoints.id),
  room: text('room').notNull(),
  grade: text('grade').notNull(),
  method: text('method').notNull(),
  occupancy: text('occupancy').notNull(),
  sampledOn: text('sampled_on').notNull(),
  count: integer('count').notNull(),
  unit: text('unit').notNull(),
  mediaLot: text('media_lot'),
  incubationStartedAt: timestamp('incubation_started_at', { withTimezone: true }),
  incubationEndedAt: timestamp('incubation_ended_at', { withTimezone: true }),
  incubationConditions: text('incubation_conditions'),
  organism: text('organism'),
  identifiedBy: text('identified_by').references(() => users.id),
  identifiedAt: timestamp('identified_at', { withTimezone: true }),
  status: text('status').notNull(),
  limitProfileId: text('limit_profile_id').notNull().references(() => emLimitProfiles.id),
  limitAlert: integer('limit_alert'),
  limitAction: integer('limit_action').notNull(),
  recordedBy: text('recorded_by').notNull().references(() => users.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('em_results_point_sampled_idx').on(t.pointId, t.sampledOn),
  index('em_results_room_sampled_idx').on(t.room, t.sampledOn),
  index('em_results_limit_profile_id_idx').on(t.limitProfileId),
  index('em_results_identified_by_idx').on(t.identifiedBy),
  index('em_results_recorded_by_idx').on(t.recordedBy),
  check('em_results_status_check', sql`${t.status} IN ('Pass', 'Alert', 'Action')`),
  check('em_results_count_check', sql`${t.count} >= 0`),
]);

export const emExcursions = pgTable('em_excursions', {
  id: text('id').primaryKey(),
  resultId: text('result_id').notNull().unique().references(() => emResults.id),
  pointId: text('point_id').notNull().references(() => emSamplingPoints.id),
  room: text('room').notNull(),
  level: text('level').notNull(),
  count: integer('count').notNull(),
  limitValue: integer('limit_value').notNull(),
  qmsRecordId: text('qms_record_id').notNull().references(() => qmsRecords.id),
  openedBy: text('opened_by').notNull().references(() => users.id),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('em_excursions_point_id_idx').on(t.pointId),
  index('em_excursions_room_idx').on(t.room),
  index('em_excursions_qms_record_id_idx').on(t.qmsRecordId),
  index('em_excursions_opened_by_idx').on(t.openedBy),
]);

export const emBatchRooms = pgTable('em_batch_rooms', {
  id: text('id').primaryKey(),
  productBatchId: text('product_batch_id').notNull().references(() => productBatches.id),
  room: text('room').notNull(),
  fromDate: text('from_date').notNull(),
  toDate: text('to_date').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('em_batch_rooms_product_batch_id_idx').on(t.productBatchId),
  index('em_batch_rooms_room_idx').on(t.room, t.fromDate),
  index('em_batch_rooms_created_by_idx').on(t.createdBy),
  check('em_batch_rooms_window_check', sql`${t.fromDate} <= ${t.toDate}`),
]);

export const emTrendFlags = pgTable('em_trend_flags', {
  id: text('id').primaryKey(),
  rule: text('rule').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  pointId: text('point_id').notNull().references(() => emSamplingPoints.id),
  room: text('room').notNull(),
  organism: text('organism'),
  resultIds: jsonb('result_ids').$type<string[]>().notNull(),
  detail: text('detail').notNull(),
  status: text('status').default('Open').notNull(),
  detectedBy: text('detected_by').notNull().references(() => users.id),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  acknowledgedBy: text('acknowledged_by').references(() => users.id),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgement: text('acknowledgement'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('em_trend_flags_point_id_idx').on(t.pointId),
  index('em_trend_flags_status_idx').on(t.status),
  index('em_trend_flags_detected_by_idx').on(t.detectedBy),
  index('em_trend_flags_acknowledged_by_idx').on(t.acknowledgedBy),
  check('em_trend_flags_rule_check', sql`${t.rule} IN ('CONSECUTIVE_ALERTS', 'REPEATED_ACTIONS', 'RECURRING_ORGANISM')`),
  check('em_trend_flags_status_check', sql`${t.status} IN ('Open', 'Acknowledged')`),
]);
