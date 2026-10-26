// Domain: electronic lab notebook. Split out of src/db/schema.ts by r1-migrations; r1-quality-fixes owns this file.
import { pgTable, text, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { samples } from './samples';

export const labNotebook = pgTable('lab_notebook', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  sampleId: text('sample_id').references(() => samples.id),
  content: text('content').notNull(),
  experimentType: text('experiment_type'),
  status: text('status').default('Draft').notNull(),
  enteredBy: text('entered_by').references(() => users.id).notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).defaultNow().notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signedBy: text('signed_by').references(() => users.id),
  signatureMeaning: text('signature_meaning'),
  contentHash: text('content_hash'),
  version: integer('version').default(1).notNull(),
  locked: boolean('locked').default(false).notNull(),
  pharmacopeia: text('pharmacopeia'),
}, (t) => [
  index('lab_notebook_sample_id_entered_at_idx').on(t.sampleId, t.enteredAt),
]);

export const notebookTemplates = pgTable('notebook_templates', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  createdBy: text('created_by').references(() => users.id).notNull(),
});
