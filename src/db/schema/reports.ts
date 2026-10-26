// Domain: controlled documents (roadmap M25, migration 0190_coa_reports). r2-coa-reports owns this file.
//
//   coa_documents      one row per issue of a Certificate of Analysis. `number` (COA-<year>-<n>, gap-free counter coa:<year>) is kept
//                      by every re-issue; `issue_version` counts the issues of the number; `label` = <number>-v<issue_version>.
//                      `snapshot` is the frozen content the certificate prints (src/server/reports/snapshot.ts) and `snapshot_sha256`
//                      its hash (canonical JSON). The issue is signed (COA_AUTHORISATION on entity CoaDocument, bound to `version`).
//                      Issued -> Superseded (re-issue: successor, who, when, why) | Voided (COA_VOID: who, when, why). One Issued per
//                      sample. `pdf_sha256` / `original_run_id`: the original PDF (copy 1), recorded once by the rendering job.
//                      The database refuses any other change (src/db/protections/reports.ts, gxp_coa_documents_guard).
//   report_runs        every generated document: its bytes (bytea), their sha256, the copy number (gap-free per document, counter
//                      report-copy:<document id>), the document state and the watermark it was printed with, who it was made for.
//                      Append-only.
//   report_print_log   every delivery of a run's bytes. Append-only.
import { sql } from 'drizzle-orm';
import { check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { samples } from './samples';
import { specifications } from './specifications';

export const COA_STATUSES = ['Issued', 'Superseded', 'Voided'] as const;
export type CoaStatus = (typeof COA_STATUSES)[number];
export const REPORT_TYPES = ['CoA'] as const;
export const RUN_PURPOSES = ['Original', 'Copy'] as const;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const coaDocuments = pgTable('coa_documents', {
  id: text('id').primaryKey(),
  sampleId: text('sample_id').notNull().references(() => samples.id),
  number: text('number').notNull(),
  issueVersion: integer('issue_version').notNull(),
  label: text('label').notNull(),
  status: text('status').default('Issued').notNull(),
  specId: text('spec_id').references(() => specifications.id),
  specRevision: integer('spec_revision'),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  snapshotSha256: text('snapshot_sha256').notNull(),
  issuedBy: text('issued_by').notNull().references(() => users.id),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  supersedesId: text('supersedes_id').references((): AnyPgColumn => coaDocuments.id),
  supersededById: text('superseded_by_id'),
  supersededBy: text('superseded_by').references(() => users.id),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededReason: text('superseded_reason'),
  voidedBy: text('voided_by').references(() => users.id),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  pdfSha256: text('pdf_sha256'),
  originalRunId: text('original_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('coa_documents_number_issue_version_uidx').on(t.number, t.issueVersion),
  uniqueIndex('coa_documents_one_issued_per_sample_uidx').on(t.sampleId).where(sql`${t.status} = 'Issued'`),
  uniqueIndex('coa_documents_supersedes_id_uidx').on(t.supersedesId),
  index('coa_documents_sample_id_idx').on(t.sampleId),
  index('coa_documents_spec_id_idx').on(t.specId),
  index('coa_documents_issued_by_idx').on(t.issuedBy),
  index('coa_documents_superseded_by_idx').on(t.supersededBy),
  index('coa_documents_voided_by_idx').on(t.voidedBy),
  check('coa_documents_status_check', sql`${t.status} IN ('Issued', 'Superseded', 'Voided')`),
  check('coa_documents_number_check', sql`${t.number} ~ '^COA-[0-9]{4}-[0-9]{4,}$'`),
  check('coa_documents_issue_version_check', sql`${t.issueVersion} >= 1`),
  check('coa_documents_label_check', sql`${t.label} = ${t.number} || '-v' || ${t.issueVersion}`),
  check('coa_documents_snapshot_sha256_check', sql`${t.snapshotSha256} ~ '^[0-9a-f]{64}$'`),
  check('coa_documents_pdf_sha256_check', sql`${t.pdfSha256} IS NULL OR ${t.pdfSha256} ~ '^[0-9a-f]{64}$'`),
]);

export const reportRuns = pgTable('report_runs', {
  id: text('id').primaryKey(),
  reportType: text('report_type').notNull(),
  documentId: text('document_id').references(() => coaDocuments.id),
  copyNo: integer('copy_no').notNull(),
  purpose: text('purpose').notNull(),
  documentStatus: text('document_status').notNull(),
  watermark: text('watermark'),
  fileName: text('file_name').notNull(),
  mime: text('mime').default('application/pdf').notNull(),
  bytes: integer('bytes').notNull(),
  pdfSha256: text('pdf_sha256').notNull(),
  pdf: bytea('pdf').notNull(),
  jobId: text('job_id'),
  generatedBy: text('generated_by').notNull().references(() => users.id),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('report_runs_document_copy_uidx').on(t.documentId, t.copyNo),
  uniqueIndex('report_runs_one_original_uidx').on(t.documentId).where(sql`${t.purpose} = 'Original'`),
  index('report_runs_generated_by_idx').on(t.generatedBy),
  check('report_runs_report_type_check', sql`${t.reportType} IN ('CoA')`),
  check('report_runs_purpose_check', sql`${t.purpose} IN ('Original', 'Copy')`),
  check('report_runs_document_check', sql`${t.reportType} <> 'CoA' OR ${t.documentId} IS NOT NULL`),
  check('report_runs_copy_no_check', sql`${t.copyNo} >= 1`),
  check('report_runs_bytes_check', sql`${t.bytes} > 0`),
  check('report_runs_pdf_sha256_check', sql`${t.pdfSha256} ~ '^[0-9a-f]{64}$'`),
]);

export const reportPrintLog = pgTable('report_print_log', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => reportRuns.id),
  action: text('action').notNull(),
  printedBy: text('printed_by').notNull().references(() => users.id),
  printedAt: timestamp('printed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('report_print_log_run_id_idx').on(t.runId),
  index('report_print_log_printed_by_idx').on(t.printedBy),
  check('report_print_log_action_check', sql`${t.action} IN ('Download')`),
]);
