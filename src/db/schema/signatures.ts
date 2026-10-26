// Domain: electronic signatures. Split out of src/db/schema.ts by r1-migrations; r1-esign owns this file (roadmap M07, migration 0020).
// Append-only apart from the single pending -> audit-id link (see src/db/protections/signatures.ts).
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, boolean, index, check } from 'drizzle-orm/pg-core';
import { samples } from './samples';

/**
 * What a signature means, in one place. The client sends the code; the text, the roles, the reason rule and the training
 * exemption come from here. Corrected with a migration, never by the application: every signature keeps the text it was signed with.
 */
export const signatureMeanings = pgTable('signature_meanings', {
  code: text('code').primaryKey(), // UPPER_SNAKE
  text: text('text').notNull(), // the sentence a signature prints (21 CFR 11.50(a)(3))
  allowedRoles: text('allowed_roles').array().notNull(),
  requiresReason: boolean('requires_reason').default(false).notNull(),
  trainingExempt: boolean('training_exempt').default(false).notNull(), // the meanings that grant or acknowledge the software training itself
  active: boolean('active').default(true).notNull(), // when the row was installed is in the migration journal, not here
});

export const signatures = pgTable('signatures', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').references(() => samples.id), // only for a signature that belongs to a sample; the binding is entity_type + entity_id
  signerId: text('signer_id').notNull(),
  meaning: text('meaning').notNull(), // the text printed when the signature was made (a snapshot of the catalog text, or the legacy free text)
  reason: text('reason').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  recordVersion: integer('record_version').notNull(), // Tied to specific record version
  contentHash: text('content_hash').notNull(),
  auditEntryId: text('audit_entry_id').notNull(),
  // Added by migration 0020 (roadmap M07)
  entityType: text('entity_type'), // Sample, OOS, Specification, LabNotebook, BatchRelease, Instrument, Reagent, User, ...
  entityId: text('entity_id'),
  meaningCode: text('meaning_code').references(() => signatureMeanings.code),
  signerName: text('signer_name'), // printed name and role when the signature was made: a later rename or role change does not touch them
  signerRole: text('signer_role'),
  authMethod: text('auth_method'), // password | password+totp
  hashVersion: integer('hash_version').default(1).notNull(), // 1 = v0.1.0 formulas (per record type), 2 = src/server/esign/hash.ts
}, (t) => [
  index('signatures_sample_id_timestamp_idx').on(t.sampleId, t.timestamp),
  index('signatures_entity_idx').on(t.entityType, t.entityId),
  // A row written by signRecord (version 2) is complete; a version 1 row is what the routes that have not moved to signRecord write.
  check('signatures_v2_complete', sql`${t.hashVersion} < 2 OR (${t.entityType} IS NOT NULL AND ${t.entityId} IS NOT NULL AND ${t.meaningCode} IS NOT NULL AND ${t.signerName} IS NOT NULL AND ${t.signerRole} IS NOT NULL AND ${t.authMethod} IS NOT NULL)`),
]);
