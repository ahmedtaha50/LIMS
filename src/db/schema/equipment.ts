// Domain: equipment, reagents, environmental monitoring and stability. Split out of src/db/schema.ts by r1-migrations;
// r1-quality-fixes owns this file. Migration 0070 adds the instrument version, calibration_history, env_limits and env_excursions.
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const stabilityStudies = pgTable('stability_studies', {
  id: text('id').primaryKey(),
  product: text('product').notNull(),
  batch: text('batch').notNull(),
  condition: text('condition').notNull(),
  pullPoints: jsonb('pull_points').$type<number[]>().notNull(),
  startDate: text('start_date').notNull(),
  status: text('status').notNull(), // Ongoing | Completed | Aborted (src/lib/validations/stability.ts)
  version: integer('version').default(1).notNull(),
});

export const envRecords = pgTable('env_records', {
  id: text('id').primaryKey(),
  location: text('location').notNull(),
  grade: text('grade').notNull(),
  date: text('date').notNull(),
  viableCount: integer('viable_count').notNull(),
  nonViableCount: integer('non_viable_count').notNull(),
  status: text('status').notNull(), // Pass | Alert | Action (v0.1.0 rows may say 'Action Level')
  testedBy: text('tested_by').references(() => users.id).notNull(),
  version: integer('version').default(1).notNull(),
  sampleType: text('sample_type'), // null only on records written before 0070
  limitAlert: integer('limit_alert'), // the limits the record was judged against, copied from env_limits
  limitAction: integer('limit_action'),
});

/** Environmental limits per grade and sample type: site data that QA approves. One active row per combination. */
export const envLimits = pgTable('env_limits', {
  id: text('id').primaryKey(),
  grade: text('grade').notNull(),
  sampleType: text('sample_type').notNull(),
  unit: text('unit').notNull(),
  alertLimit: integer('alert_limit'), // null: the site has not set one
  actionLimit: integer('action_limit').notNull(), // a count above it is an action-level result
  source: text('source').notNull(),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  active: boolean('active').default(true).notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('env_limits_active_uidx').on(t.grade, t.sampleType).where(sql`${t.active}`),
]);

/** One row per action-level result. Opened with the record; an edit of the count never closes it. */
export const envExcursions = pgTable('env_excursions', {
  id: text('id').primaryKey(),
  envRecordId: text('env_record_id').references(() => envRecords.id).notNull(),
  level: text('level').notNull(), // Action
  grade: text('grade').notNull(),
  sampleType: text('sample_type').notNull(),
  viableCount: integer('viable_count').notNull(),
  limitValue: integer('limit_value').notNull(),
  status: text('status').default('Open').notNull(),
  openedBy: text('opened_by').references(() => users.id).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('env_excursions_env_record_id_idx').on(t.envRecordId),
  index('env_excursions_opened_by_idx').on(t.openedBy),
]);

export const instruments = pgTable('instruments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  calibrationDueDate: text('calibration_due_date').notNull(),
  lastCalibrationDate: text('last_calibration_date').notNull(),
  version: integer('version').default(1).notNull(),
});

/** One row per signed calibration. Append-only (triggers in migration 0070). */
export const calibrationHistory = pgTable('calibration_history', {
  id: text('id').primaryKey(),
  instrumentId: text('instrument_id').references(() => instruments.id).notNull(),
  performedBy: text('performed_by').references(() => users.id).notNull(),
  performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
  previousDueDate: text('previous_due_date').notNull(),
  newDueDate: text('new_due_date').notNull(),
  statusBefore: text('status_before').notNull(),
  statusAfter: text('status_after').notNull(),
  instrumentVersion: integer('instrument_version').notNull(), // the instrument version this calibration produced
  reason: text('reason').notNull(),
}, (t) => [
  uniqueIndex('calibration_history_instrument_version_uidx').on(t.instrumentId, t.instrumentVersion),
  index('calibration_history_performed_by_idx').on(t.performedBy),
]);

export const reagents = pgTable('reagents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  lotNumber: text('lot_number').notNull(),
  expiryDate: text('expiry_date').notNull(),
  status: text('status').notNull(),
  quantity: text('quantity').notNull(),
});
