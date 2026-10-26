// Domain: samples, results and batch release. Split out of src/db/schema.ts by r1-migrations; r1-results-oos owns this file.
// The samples and results core tables are frozen (their columns feed signed hashes): new features add 1:1 sidecar tables.
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, real, boolean, index } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { instruments } from './equipment';
import { specifications } from './specifications';

export const samples = pgTable('samples', {
  id: text('id').primaryKey(),
  material: text('material').notNull(),
  batch: text('batch').notNull(),
  state: text('state').notNull(),
  createdBy: text('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(), // Optimistic Concurrency
  // 0050_results_oos: the specification revision the sample was registered under (resolveActiveSpec). Null before 0050.
  specId: text('spec_id').references(() => specifications.id),
  specRevision: integer('spec_revision'),
}, (t) => [
  index('samples_batch_idx').on(t.batch),
  index('samples_spec_id_idx').on(t.specId),
  index('samples_material_idx').on(t.material),
  index('samples_state_idx').on(t.state),
  index('samples_created_at_idx').on(t.createdAt),
  index('samples_search_trgm_idx').using('gin', sql`(search_norm(${t.id} || ' ' || ${t.material} || ' ' || ${t.batch})) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
]);

export const results = pgTable('results', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').references(() => samples.id).notNull(),
  parameter: text('parameter').notNull(),
  value: text('value'),
  specMin: real('spec_min'),
  specMax: real('spec_max'),
  isOos: boolean('is_oos').default(false).notNull(),
  enteredBy: text('entered_by').references(() => users.id),
  enteredAt: timestamp('entered_at', { withTimezone: true }),
  instrumentId: text('instrument_id').references(() => instruments.id),
  attachmentName: text('attachment_name'),
  attachmentData: text('attachment_data'),
  version: integer('version').default(1).notNull(),
  // 0050_results_oos: the limit copied from the specification revision at registration (src/server/lib/evaluate.ts). Null before 0050.
  unit: text('unit'),
  limitKind: text('limit_kind'), // RANGE | NMT | NLT | TEXT | PRESENCE
  lowerText: text('lower_text'), // limits as decimal text, as written in the specification
  upperText: text('upper_text'),
  decimals: integer('decimals'),
  acceptanceText: text('acceptance_text'),
}, (t) => [
  index('results_sample_id_idx').on(t.sampleId),
]);

export const batchMaterials = pgTable('batch_materials', {
  id: text('id').primaryKey(),
  batch: text('batch').notNull(),
  materialName: text('material_name').notNull(),
  materialType: text('material_type').notNull(), // 'API' | 'Excipient' | 'Packaging'
  lotNumber: text('lot_number').notNull(),
  manufacturer: text('manufacturer').notNull(),
  coaNumber: text('coa_number').notNull(),
  coaStatus: text('coa_status').notNull(), // 'Verified Pass' | 'Quarantined' | 'Rejected'
  quantityDispensed: text('quantity_dispensed').notNull(),
  potencyAssay: text('potency_assay'),
  lossOnDrying: text('loss_on_drying'),
  dispensedBy: text('dispensed_by').references(() => users.id),
  verifiedBy: text('verified_by').references(() => users.id),
  dispensedAt: timestamp('dispensed_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('batch_materials_batch_idx').on(t.batch),
]);

export const batchReleases = pgTable('batch_releases', {
  id: text('id').primaryKey(),
  batch: text('batch').notNull().unique(),
  status: text('status').notNull(), // 'Released' | 'Quarantine Hold' | 'Rejected'
  dispositionRecommendation: text('disposition_recommendation'),
  releasedBy: text('released_by').references(() => users.id),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  meaning: text('meaning'),
  contentHash: text('content_hash'),
  signatureId: text('signature_id'),
  auditEntryId: text('audit_entry_id'),
  version: integer('version').default(1).notNull(),
});
