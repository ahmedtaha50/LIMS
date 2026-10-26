// Domain: controlled documents (roadmap M28, migration 0200_docs_training). r2-docs-training owns this file.
//
//   documents           one row per controlled document (code unique ignoring case); the content lives in its versions.
//   document_versions   each revision and its lifecycle: Draft, InReview, Approved, Effective, Superseded, Obsolete. The file is in the
//                       blob store (BLOB_DIR/<file_sha256>). Author, reviewer and approver are three people who each sign the cycle
//                       that started at submitted_version; QA makes it Effective. One Effective and one open version per document.
//                       Trigger gxp_document_versions_row_guard freezes the content once submitted and the record once Effective.
//   document_prints     the print log of numbered controlled copies. Append-only.
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const DOCUMENT_TYPES = ['SOP', 'Method', 'Policy', 'Form', 'Specification', 'Other'] as const;
export const DOCUMENT_STATUSES = ['Draft', 'InReview', 'Approved', 'Effective', 'Superseded', 'Obsolete'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  docType: text('doc_type').notNull(),
  reviewPeriodMonths: integer('review_period_months').default(24).notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('documents_code_lower_uidx').on(sql`lower(${t.code})`),
  index('documents_created_by_idx').on(t.createdBy),
  index('documents_search_trgm_idx').using('gin', sql`(search_norm(${t.code} || ' ' || ${t.title})) gin_trgm_ops`), // 0340_global_search; the same text as GET /search
  check('documents_doc_type_check', sql`${t.docType} IN ('SOP', 'Method', 'Policy', 'Form', 'Specification', 'Other')`),
  check('documents_review_period_check', sql`${t.reviewPeriodMonths} BETWEEN 1 AND 120`),
]);

export const documentVersions = pgTable('document_versions', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  revision: integer('revision').notNull(),
  title: text('title').notNull(),
  changeSummary: text('change_summary').default('').notNull(),
  status: text('status').default('Draft').notNull(),
  fileName: text('file_name'),
  mediaType: text('media_type'),
  bytes: bigint('bytes', { mode: 'number' }),
  fileSha256: text('file_sha256'),
  authorId: text('author_id').notNull().references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  /** The record version the authorship signature of the current cycle produced: review and approval signatures count from it. */
  submittedVersion: integer('submitted_version'),
  reviewerId: text('reviewer_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  approverId: text('approver_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  effectiveBy: text('effective_by').references(() => users.id),
  effectiveAt: timestamp('effective_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  obsoletedBy: text('obsoleted_by').references(() => users.id),
  obsoletedAt: timestamp('obsoleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('document_versions_document_revision_uidx').on(t.documentId, t.revision),
  uniqueIndex('document_versions_one_effective_uidx').on(t.documentId).where(sql`${t.status} = 'Effective'`),
  uniqueIndex('document_versions_one_open_uidx').on(t.documentId).where(sql`${t.status} IN ('Draft', 'InReview', 'Approved')`),
  index('document_versions_author_id_idx').on(t.authorId),
  index('document_versions_reviewer_id_idx').on(t.reviewerId),
  index('document_versions_approver_id_idx').on(t.approverId),
  index('document_versions_effective_by_idx').on(t.effectiveBy),
  index('document_versions_obsoleted_by_idx').on(t.obsoletedBy),
  check('document_versions_status_check', sql`${t.status} IN ('Draft', 'InReview', 'Approved', 'Effective', 'Superseded', 'Obsolete')`),
  check('document_versions_sha256_check', sql`${t.fileSha256} IS NULL OR ${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
]);

export const documentPrints = pgTable('document_prints', {
  id: text('id').primaryKey(),
  documentVersionId: text('document_version_id').notNull().references(() => documentVersions.id),
  copyNumber: integer('copy_number').notNull(),
  purpose: text('purpose').notNull(),
  recipient: text('recipient'),
  printedBy: text('printed_by').notNull().references(() => users.id),
  printedAt: timestamp('printed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('document_prints_version_copy_uidx').on(t.documentVersionId, t.copyNumber),
  index('document_prints_printed_by_idx').on(t.printedBy),
]);
