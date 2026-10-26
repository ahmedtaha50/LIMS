// Domain: instrument data capture (roadmap M21, migration 0260_instrument_data). r2-instrument-integration owns this file.
//
//   instrument_profiles           one capture path: instrument, watched folder, file-name pattern, parser, column mapping. Approved with an
//                                 e-signature (INSTRUMENT_PROFILE_APPROVAL); only an Approved profile is watched.
//   instrument_profile_revisions  the content of a profile at each version (append-only), what a signature on the profile covers.
//   instrument_files              one row per captured file; the bytes are in the blob store (sha256 unique: a duplicate is refused).
//                                 Only disposition and its note change after the insert (trigger).
//   instrument_import_rows        the parsed values, staged until a named analyst accepts them (through saveResult) or rejects them.
//   result_sources                which captured file and row a result version came from (append-only sidecar of results).
//   instrument_usage_log          captures and accepted values per instrument (append-only).
import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';
import { results, samples } from './samples';

export const PROFILE_PARSERS = ['generic-csv', 'balance-text', 'ph-csv', 'hplc-summary-csv'] as const;
export type ProfileParser = (typeof PROFILE_PARSERS)[number];

export const instrumentProfiles = pgTable('instrument_profiles', {
  id: text('id').primaryKey(),
  instrumentId: text('instrument_id').notNull().references(() => instruments.id),
  name: text('name').notNull(),
  parser: text('parser').notNull(),
  watchDir: text('watch_dir').notNull(),
  glob: text('glob').default('*').notNull(),
  mapping: jsonb('mapping').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').default('Draft').notNull(), // Draft | Approved | Retired
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('instrument_profiles_name_uidx').on(t.name),
  index('instrument_profiles_instrument_id_idx').on(t.instrumentId),
  index('instrument_profiles_created_by_idx').on(t.createdBy),
  index('instrument_profiles_approved_by_idx').on(t.approvedBy),
  check('instrument_profiles_parser_check', sql`${t.parser} IN ('generic-csv', 'balance-text', 'ph-csv', 'hplc-summary-csv')`),
  check('instrument_profiles_status_check', sql`${t.status} IN ('Draft', 'Approved', 'Retired')`),
  check('instrument_profiles_approval_check', sql`(${t.status} = 'Approved') = (${t.approvedBy} IS NOT NULL)`),
]);

export const instrumentProfileRevisions = pgTable('instrument_profile_revisions', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  version: integer('version').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  changedBy: text('changed_by').notNull().references(() => users.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // an explicit name: the generated one is longer than the 63 characters PostgreSQL keeps
  foreignKey({ name: 'instrument_profile_revisions_profile_fk', columns: [t.profileId], foreignColumns: [instrumentProfiles.id] }),
  uniqueIndex('instrument_profile_revisions_version_uidx').on(t.profileId, t.version),
  index('instrument_profile_revisions_changed_by_idx').on(t.changedBy),
]);

export const instrumentFiles = pgTable('instrument_files', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull().references(() => instrumentProfiles.id),
  instrumentId: text('instrument_id').notNull().references(() => instruments.id),
  fileName: text('file_name').notNull(),
  source: text('source').notNull(), // watch | upload
  sha256: text('sha256').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  parseStatus: text('parse_status').notNull(), // Parsed | Failed
  parseError: text('parse_error'),
  rowCount: integer('row_count').default(0).notNull(),
  disposition: text('disposition').default('Pending').notNull(), // Pending | Processed | Error
  dispositionNote: text('disposition_note'),
  receivedBy: text('received_by').notNull().references(() => users.id),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('instrument_files_sha256_uidx').on(t.sha256),
  index('instrument_files_profile_id_idx').on(t.profileId),
  index('instrument_files_instrument_id_idx').on(t.instrumentId),
  index('instrument_files_received_by_idx').on(t.receivedBy),
  check('instrument_files_source_check', sql`${t.source} IN ('watch', 'upload')`),
  check('instrument_files_parse_status_check', sql`${t.parseStatus} IN ('Parsed', 'Failed')`),
  check('instrument_files_disposition_check', sql`${t.disposition} IN ('Pending', 'Processed', 'Error')`),
  check('instrument_files_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('instrument_files_bytes_check', sql`${t.bytes} > 0`),
]);

export const instrumentImportRows = pgTable('instrument_import_rows', {
  id: text('id').primaryKey(),
  fileId: text('file_id').notNull().references(() => instrumentFiles.id),
  lineNo: integer('line_no').notNull(),
  sampleRef: text('sample_ref'),
  parameter: text('parameter').notNull(),
  value: text('value').notNull(),
  unit: text('unit'),
  raw: jsonb('raw').$type<Record<string, unknown>>().default({}).notNull(),
  state: text('state').default('Pending').notNull(), // Pending | Accepted | Rejected
  resultId: text('result_id').references(() => results.id),
  decidedBy: text('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('instrument_import_rows_file_id_idx').on(t.fileId),
  index('instrument_import_rows_sample_state_idx').on(t.sampleRef, t.state),
  index('instrument_import_rows_result_id_idx').on(t.resultId),
  index('instrument_import_rows_decided_by_idx').on(t.decidedBy),
  check('instrument_import_rows_state_check', sql`${t.state} IN ('Pending', 'Accepted', 'Rejected')`),
  check('instrument_import_rows_decision_check', sql`(${t.state} = 'Pending') = (${t.decidedBy} IS NULL)`),
]);

export const resultSources = pgTable('result_sources', {
  id: text('id').primaryKey(),
  resultId: text('result_id').notNull().references(() => results.id),
  resultVersion: integer('result_version').notNull(),
  source: text('source').notNull(), // instrument
  fileId: text('file_id').notNull().references(() => instrumentFiles.id),
  importRowId: text('import_row_id').notNull().references(() => instrumentImportRows.id),
  sha256: text('sha256').notNull(),
  acceptedBy: text('accepted_by').notNull().references(() => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('result_sources_result_version_uidx').on(t.resultId, t.resultVersion),
  uniqueIndex('result_sources_import_row_uidx').on(t.importRowId),
  index('result_sources_file_id_idx').on(t.fileId),
  index('result_sources_accepted_by_idx').on(t.acceptedBy),
  check('result_sources_source_check', sql`${t.source} IN ('instrument')`),
  check('result_sources_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
]);

export const instrumentUsageLog = pgTable('instrument_usage_log', {
  id: text('id').primaryKey(),
  instrumentId: text('instrument_id').notNull().references(() => instruments.id),
  event: text('event').notNull(), // DataCaptured | ResultAccepted
  fileId: text('file_id').references(() => instrumentFiles.id),
  sampleId: text('sample_id').references(() => samples.id),
  resultId: text('result_id').references(() => results.id),
  userId: text('user_id').notNull().references(() => users.id),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('instrument_usage_log_instrument_at_idx').on(t.instrumentId, t.at),
  index('instrument_usage_log_file_id_idx').on(t.fileId),
  index('instrument_usage_log_sample_id_idx').on(t.sampleId),
  index('instrument_usage_log_result_id_idx').on(t.resultId),
  index('instrument_usage_log_user_id_idx').on(t.userId),
  check('instrument_usage_log_event_check', sql`${t.event} IN ('DataCaptured', 'ResultAccepted')`),
]);
