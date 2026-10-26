// Domain: raw-data integrity (roadmap M20, migration 0120_raw_data). r2-raw-data owns this file.
//
//   result_versions    every value a result has held, one row per write, with its coded reason (src/server/services/result-hooks/codes.ts).
//                      Written in the transaction of the result write (saveResult). Append-only. result_version is the results.version
//                      the write produced. A REINTEGRATION row is approved by a QA signature on entity ResultVersion (signatures table).
//   attachments        the register of raw-data files: one row per file attached to a sample (optionally to one of its results). The
//                      content lives in the blob store as BLOB_DIR/<sha256> (src/server/blobs); the row names it by its hash. Append-only.
//   review_checklists  what a reviewer recorded: the manual attestations, and the server items as they were evaluated at that moment
//                      (src/server/review.ts). Append-only. Approval itself re-evaluates the server items (the guard), not this row.
// The three tables refuse UPDATE, DELETE and TRUNCATE (src/db/protections/rawdata.ts and the migration).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { instruments } from './equipment';
import { users } from './identity';
import { results, samples } from './samples';

export const resultVersions = pgTable('result_versions', {
  id: text('id').primaryKey(),
  resultId: text('result_id').notNull().references(() => results.id),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  resultVersion: integer('result_version').notNull(),
  value: text('value'),
  previousValue: text('previous_value'),
  isOos: boolean('is_oos').notNull(),
  changeCode: text('change_code').notNull(),
  reason: text('reason').notNull(),
  oosId: text('oos_id'),
  instrumentId: text('instrument_id').references(() => instruments.id),
  enteredBy: text('entered_by').references(() => users.id),
  enteredAt: timestamp('entered_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('result_versions_result_version_uidx').on(t.resultId, t.resultVersion),
  index('result_versions_sample_id_idx').on(t.sampleId),
  index('result_versions_instrument_id_idx').on(t.instrumentId),
  index('result_versions_entered_by_idx').on(t.enteredBy),
  check('result_versions_change_code_check', sql`${t.changeCode} IN ('INITIAL_ENTRY', 'MIGRATED', 'TRANSCRIPTION_ERROR', 'CALCULATION_ERROR', 'INSTRUMENT_MALFUNCTION', 'SAMPLE_PREPARATION_ERROR', 'METHOD_DEVIATION', 'REINTEGRATION')`),
]);

export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  resultId: text('result_id').references(() => results.id),
  fileName: text('file_name').notNull(),
  mediaType: text('media_type').notNull(),
  kind: text('kind').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  description: text('description'),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('attachments_sample_id_idx').on(t.sampleId),
  index('attachments_result_id_idx').on(t.resultId),
  index('attachments_sha256_idx').on(t.sha256),
  index('attachments_uploaded_by_idx').on(t.uploadedBy),
  check('attachments_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('attachments_bytes_check', sql`${t.bytes} > 0`),
]);

export const reviewChecklists = pgTable('review_checklists', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  sampleVersion: integer('sample_version').notNull(),
  items: jsonb('items').$type<Array<{ code: string; status: string; detail: string }>>().notNull(),
  attestations: jsonb('attestations').$type<string[]>().notNull(),
  serverItemsPassed: boolean('server_items_passed').notNull(),
  comment: text('comment'),
  recordedBy: text('recorded_by').notNull().references(() => users.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('review_checklists_sample_id_idx').on(t.sampleId),
  index('review_checklists_recorded_by_idx').on(t.recordedBy),
]);
