// Domain: specifications. Split out of src/db/schema.ts by r1-migrations; r1-spec owns this file.
//
// Two numbers, two jobs (roadmap M11):
//   version         the optimistic-concurrency counter. Every write to the row adds 1 (updateVersioned). It says nothing about the
//                   specification as a document: a first revision that was edited three times and approved has version 5.
//   revision_label  the revision of the specification as the laboratory knows it (Rev 1, Rev 2, ...), per material. Assigned by the
//                   server when a revision is created (the previous one + 1), never edited, never sent by a client. A sample keeps
//                   the revision it was registered under (r1-results-oos).
// created_by is the author (whoever created the draft); approved_by is the person whose signature made it Active. The approver may
// not be the author or an editor (record-level separation of duties, src/server/authz/sod.ts, rule spec.approve).
import { sql } from 'drizzle-orm';
import { pgTable, text, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const specifications = pgTable('specifications', {
  id: text('id').primaryKey(),
  material: text('material').notNull(),
  version: integer('version').notNull(),
  revisionLabel: integer('revision_label').default(1).notNull(),
  effectiveDate: text('effective_date').notNull(), // YYYY-MM-DD, the laboratory's calendar day (src/server/lib/specs.ts)
  status: text('status').notNull(),
  parameters: jsonb('parameters').$type<any[]>().notNull(),
  createdBy: text('created_by').references(() => users.id),
  approvedBy: text('approved_by').references(() => users.id),
}, (t) => [
  index('specifications_material_status_idx').on(t.material, t.status),
  uniqueIndex('specifications_material_revision_uq').on(t.material, t.revisionLabel),
  index('specifications_created_by_idx').on(t.createdBy),
  index('specifications_approved_by_idx').on(t.approvedBy),
  index('specifications_search_trgm_idx').using('gin', sql`(search_norm(${t.id} || ' ' || ${t.material})) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
]);
