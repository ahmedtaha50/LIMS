// Domain: turnaround time and the business calendar (roadmap M34, migration 0280_tat). r2-tat-kpi owns this file.
// The samples table is frozen (its columns feed signed hashes), so priority and due date are a 1:1 sidecar.
//
//   business_calendar   one row ('default'): the weekend days and the time zone the calendar counts days in
//   business_holidays   days that do not count towards a due date
//   tat_sla_rules       business days allowed per priority (Routine, Urgent, Critical); a priority without a row uses the built-in default
//   sample_tat          1:1 with samples: priority, the clock start (the receipt), the SLA applied and the due date calculated from them
//
// Cycle time is not stored: it is derived from the immutable audit trail (the Create and Transition rows of the sample).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { samples } from './samples';

export const TAT_PRIORITIES = ['Routine', 'Urgent', 'Critical'] as const;
export type TatPriority = typeof TAT_PRIORITIES[number];

export const businessCalendar = pgTable('business_calendar', {
  id: text('id').primaryKey(),
  weekendDays: integer('weekend_days').array().notNull(),
  timeZone: text('time_zone').notNull(),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('business_calendar_updated_by_idx').on(t.updatedBy),
  check('business_calendar_id_check', sql`${t.id} = 'default'`),
  check('business_calendar_weekend_check', sql`${t.weekendDays} <@ ARRAY[0, 1, 2, 3, 4, 5, 6] AND cardinality(${t.weekendDays}) <= 6`),
]);

export const businessHolidays = pgTable('business_holidays', {
  id: text('id').primaryKey(),
  holidayDate: text('holiday_date').notNull(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('business_holidays_date_uidx').on(t.holidayDate),
  index('business_holidays_created_by_idx').on(t.createdBy),
  check('business_holidays_date_check', sql`${t.holidayDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
]);

export const tatSlaRules = pgTable('tat_sla_rules', {
  id: text('id').primaryKey(), // the priority
  businessDays: integer('business_days').notNull(),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('tat_sla_rules_updated_by_idx').on(t.updatedBy),
  check('tat_sla_rules_priority_check', sql`${t.id} IN ('Routine', 'Urgent', 'Critical')`),
  check('tat_sla_rules_days_check', sql`${t.businessDays} BETWEEN 1 AND 365`),
]);

export const sampleTat = pgTable('sample_tat', {
  id: text('id').primaryKey().references(() => samples.id), // the sample
  priority: text('priority').default('Routine').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }), // the receipt (sample_custody.received_at); null until the sample is received
  slaBusinessDays: integer('sla_business_days'),
  dueAt: timestamp('due_at', { withTimezone: true }), // calculated once, when the clock starts or the priority changes
  setBy: text('set_by').notNull().references(() => users.id),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('sample_tat_due_at_idx').on(t.dueAt),
  index('sample_tat_set_by_idx').on(t.setBy),
  check('sample_tat_priority_check', sql`${t.priority} IN ('Routine', 'Urgent', 'Critical')`),
  check('sample_tat_clock_check', sql`(${t.dueAt} IS NULL) = (${t.startedAt} IS NULL)`),
]);
