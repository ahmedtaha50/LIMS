// Domain: worklists and batch runs (roadmap M33, r2-worklists; migration drizzle/0270_worklists.sql). The samples and results core
// tables are frozen (their columns feed signed hashes), so a worklist is a set of its own tables that point at them.
//
//   worklists        one run of one method on at most one instrument, planned for a date: WL-<year>-<n> from the gap-free counter
//                    worklist:<year>. Draft while it is being planned, Released when the run is fixed (its membership is frozen:
//                    a later change needs a reason and is audited), then Completed or Cancelled. `method_code` never changes.
//   worklist_items   what is run, in sequence: a Sample item (one result of one sample, with the analyst who runs it) or a
//                    Standard, Blank, SST or Control injection (a label only). An item is never deleted; it is Removed with a reason.
//                    A result is on one Active item at a time (the application locks the result row; the database refuses the same
//                    result twice on one worklist). While the worklist is Released the item is the ASSIGNMENT of its result: the
//                    result guard `assignment` (src/server/services/result-guards/assignment.ts) lets only the assignee enter it.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';
import { results, samples } from './samples';

export const worklists = pgTable('worklists', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  methodCode: text('method_code').notNull(),
  instrumentId: text('instrument_id').references(() => instruments.id),
  plannedDate: text('planned_date').notNull(),
  status: text('status').default('Draft').notNull(),
  notes: text('notes'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  releasedBy: text('released_by').references(() => users.id),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  closedBy: text('closed_by').references(() => users.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('worklists_status_planned_date_idx').on(t.status, t.plannedDate),
  index('worklists_instrument_id_idx').on(t.instrumentId),
  index('worklists_created_by_idx').on(t.createdBy),
  index('worklists_released_by_idx').on(t.releasedBy),
  index('worklists_closed_by_idx').on(t.closedBy),
  check('worklists_status_check', sql`${t.status} IN ('Draft', 'Released', 'Completed', 'Cancelled')`),
  check('worklists_planned_date_check', sql`${t.plannedDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  check('worklists_closed_check', sql`(${t.status} IN ('Completed', 'Cancelled')) = (${t.closedAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL)`),
]);

export const worklistItems = pgTable('worklist_items', {
  id: text('id').primaryKey(),
  worklistId: text('worklist_id').notNull().references(() => worklists.id),
  position: integer('position').notNull(),
  kind: text('kind').notNull(),
  sampleId: text('sample_id').references(() => samples.id),
  resultId: text('result_id').references(() => results.id),
  label: text('label'),
  assigneeId: text('assignee_id').references(() => users.id),
  status: text('status').default('Active').notNull(),
  addedBy: text('added_by').notNull().references(() => users.id),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  removedBy: text('removed_by').references(() => users.id),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedReason: text('removed_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('worklist_items_result_uidx').on(t.worklistId, t.resultId).where(sql`${t.status} = 'Active' AND ${t.resultId} IS NOT NULL`),
  index('worklist_items_worklist_position_idx').on(t.worklistId, t.position),
  index('worklist_items_result_id_idx').on(t.resultId),
  index('worklist_items_sample_id_idx').on(t.sampleId),
  index('worklist_items_assignee_id_idx').on(t.assigneeId),
  index('worklist_items_added_by_idx').on(t.addedBy),
  index('worklist_items_removed_by_idx').on(t.removedBy),
  check('worklist_items_kind_check', sql`${t.kind} IN ('Sample', 'Standard', 'Blank', 'SST', 'Control')`),
  check('worklist_items_status_check', sql`${t.status} IN ('Active', 'Removed')`),
  check('worklist_items_sample_check', sql`${t.kind} <> 'Sample' OR (${t.sampleId} IS NOT NULL AND ${t.resultId} IS NOT NULL AND ${t.assigneeId} IS NOT NULL)`),
  check('worklist_items_other_check', sql`${t.kind} = 'Sample' OR (${t.sampleId} IS NULL AND ${t.resultId} IS NULL AND length(btrim(coalesce(${t.label}, ''))) > 0)`),
  check('worklist_items_removed_check', sql`(${t.status} = 'Removed') = (${t.removedAt} IS NOT NULL AND ${t.removedBy} IS NOT NULL AND length(btrim(coalesce(${t.removedReason}, ''))) > 0)`),
]);
