// Domain: out-of-specification investigations. Split out of src/db/schema.ts by r1-migrations; r1-results-oos wrote the investigation
// table (0050_results_oos), r2-oos-workflow owns this file and the workflow tables (0210_oos_workflow, roadmap M26).
//
//   oos_investigations        one per OOS result. Phase I / Phase II / Pending QA while Open, then Closed with QA's signed decision. The
//                             workflow columns: the due date of the current phase, when Phase II started, the assignable cause recorded
//                             by the investigator and QA's confirmation of it, which invalidates the original result.
//   oos_settings              one row ('default'): the retest rules and the phase periods. Changed only with an e-signature.
//   oos_checklist_templates   the investigation checklists, versioned per code.
//   oos_tasks                 the tasks of an investigation: from a template (once per template) or added by hand.
//   oos_retest_plans          the signed retest authorisation, one per investigation. Append-only.
//   oos_retests               each retest under the plan, numbered. Append-only.
// Dates (due_date) are calendar days, YYYY-MM-DD, compared with the server's local calendar date (src/server/lib/specs.ts todayIso).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';
import { samples, results } from './samples';

export const oosInvestigations = pgTable('oos_investigations', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').references(() => samples.id).notNull(),
  resultId: text('result_id').references(() => results.id).notNull(),
  parameter: text('parameter').notNull(),
  dateRaised: text('date_raised').notNull(),
  status: text('status').notNull(),
  assignedTo: text('assigned_to').references(() => users.id),
  rootCause: text('root_cause'),
  conclusion: text('conclusion'),
  version: integer('version').default(1).notNull(),
  // 0050_results_oos (vocabulary: src/lib/constants/oos.ts). Null on rows written before 0050.
  phase: text('phase'), // Phase I | Phase II | Pending QA while the status is Open
  decision: text('decision'), // the outcome signed on closure (src/lib/validations/oos.ts OOS_CLOSURE_DECISIONS)
  // 0210_oos_workflow. Null on rows written before 0210.
  dueDate: text('due_date'), // the due date of the current phase; null = date_raised + the Phase I period
  phase2StartedAt: timestamp('phase2_started_at', { withTimezone: true }),
  assignableCauseCategory: text('assignable_cause_category'), // one of OOS_RESULT_CHANGE_CODES
  assignableCause: text('assignable_cause'),
  assignableCauseBy: text('assignable_cause_by').references(() => users.id),
  assignableCauseAt: timestamp('assignable_cause_at', { withTimezone: true }),
  invalidatedBy: text('invalidated_by').references(() => users.id), // QA who confirmed the cause (OOS_INVALIDATION)
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
}, (t) => [
  // One investigation per result that is not final (Closed, or v0.1.0's Approved).
  uniqueIndex('oos_investigations_one_open_per_result_uidx').on(t.resultId).where(sql`${t.status} NOT IN ('Closed', 'Approved')`),
  index('oos_investigations_sample_id_status_idx').on(t.sampleId, t.status),
  index('oos_investigations_result_id_idx').on(t.resultId),
  index('oos_investigations_assignable_cause_by_idx').on(t.assignableCauseBy),
  index('oos_investigations_invalidated_by_idx').on(t.invalidatedBy),
]);

export const oosSettings = pgTable('oos_settings', {
  id: text('id').primaryKey(),
  retestAnalystMustDiffer: boolean('retest_analyst_must_differ').default(true).notNull(),
  maxRetests: integer('max_retests').default(2).notNull(),
  phase1DueDays: integer('phase1_due_days').default(10).notNull(),
  phase2DueDays: integer('phase2_due_days').default(30).notNull(),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('oos_settings_updated_by_idx').on(t.updatedBy),
  check('oos_settings_max_retests_check', sql`${t.maxRetests} BETWEEN 1 AND 10`),
  check('oos_settings_due_days_check', sql`${t.phase1DueDays} BETWEEN 1 AND 365 AND ${t.phase2DueDays} BETWEEN 1 AND 365`),
]);

export interface ChecklistItem { key: string; text: string }

export const oosChecklistTemplates = pgTable('oos_checklist_templates', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  phase: text('phase').notNull(),
  title: text('title').notNull(),
  items: jsonb('items').$type<ChecklistItem[]>().notNull(),
  version: integer('version').notNull(),
  active: boolean('active').default(true).notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('oos_checklist_templates_code_version_uidx').on(t.code, t.version),
  index('oos_checklist_templates_created_by_idx').on(t.createdBy),
  check('oos_checklist_templates_phase_check', sql`${t.phase} IN ('Phase I', 'Phase II')`),
]);

export const oosTasks = pgTable('oos_tasks', {
  id: text('id').primaryKey(),
  oosId: text('oos_id').notNull().references(() => oosInvestigations.id),
  phase: text('phase').notNull(),
  title: text('title').notNull(),
  templateId: text('template_id').references(() => oosChecklistTemplates.id),
  itemKey: text('item_key'),
  ownerId: text('owner_id').references(() => users.id),
  dueDate: text('due_date'),
  status: text('status').default('Open').notNull(),
  finding: text('finding'),
  completedBy: text('completed_by').references(() => users.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('oos_tasks_oos_id_idx').on(t.oosId),
  uniqueIndex('oos_tasks_template_item_uidx').on(t.oosId, t.templateId, t.itemKey).where(sql`${t.templateId} IS NOT NULL`),
  index('oos_tasks_template_id_idx').on(t.templateId),
  index('oos_tasks_owner_id_idx').on(t.ownerId),
  index('oos_tasks_completed_by_idx').on(t.completedBy),
  index('oos_tasks_created_by_idx').on(t.createdBy),
  check('oos_tasks_status_check', sql`${t.status} IN ('Open', 'Done', 'Not applicable')`),
  check('oos_tasks_phase_check', sql`${t.phase} IN ('Phase I', 'Phase II')`),
]);

export const oosRetestPlans = pgTable('oos_retest_plans', {
  id: text('id').primaryKey(),
  oosId: text('oos_id').notNull().references(() => oosInvestigations.id),
  retestOf: text('retest_of').notNull().references(() => results.id),
  basis: text('basis').notNull(), // Assignable cause | Phase II protocol
  justification: text('justification').notNull(),
  maxRetests: integer('max_retests').notNull(),
  approvedBy: text('approved_by').notNull().references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('oos_retest_plans_oos_id_unique').on(t.oosId),
  index('oos_retest_plans_retest_of_idx').on(t.retestOf),
  index('oos_retest_plans_approved_by_idx').on(t.approvedBy),
  check('oos_retest_plans_basis_check', sql`${t.basis} IN ('Assignable cause', 'Phase II protocol')`),
  check('oos_retest_plans_max_retests_check', sql`${t.maxRetests} >= 1`),
]);

export const oosRetests = pgTable('oos_retests', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => oosRetestPlans.id),
  oosId: text('oos_id').notNull().references(() => oosInvestigations.id),
  retestOf: text('retest_of').notNull().references(() => results.id),
  seq: integer('seq').notNull(),
  value: text('value').notNull(),
  isOos: boolean('is_oos').notNull(),
  analystId: text('analyst_id').notNull().references(() => users.id),
  instrumentId: text('instrument_id').references(() => instruments.id),
  reason: text('reason').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('oos_retests_plan_seq_uidx').on(t.planId, t.seq),
  index('oos_retests_oos_id_idx').on(t.oosId),
  index('oos_retests_retest_of_idx').on(t.retestOf),
  index('oos_retests_analyst_id_idx').on(t.analystId),
  index('oos_retests_instrument_id_idx').on(t.instrumentId),
]);
