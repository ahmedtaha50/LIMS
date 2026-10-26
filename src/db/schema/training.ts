// Domain: training matrix and analyst qualification (roadmap M28, migration 0200_docs_training). r2-docs-training owns this file.
// The legacy table training_records (certifications of a named module) stays in ./identity.ts, owned by r1-identity.
//
//   training_curricula             what a set of roles must be trained on, how (read and understood, or on-the-job), and for which
//                                  method (method_code); `is_software` marks the one LIMS curriculum, the only one that sets
//                                  users.has_completed_software_training.
//   training_curriculum_documents  the documents of a curriculum: their Effective version is what is assigned.
//   training_assignments           one per user, curriculum and document version, due on due_date (YYYY-MM-DD, server calendar),
//                                  Overdue once past it, Completed by a signature. A completed assignment never changes (trigger).
//   analyst_qualifications         QA overrides of the qualification gate, per user and method, until valid_until (inclusive).
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { documents, documentVersions } from './documents';
import { users } from './identity';

export const TRAINING_METHODS = ['READ_AND_UNDERSTOOD', 'OJT'] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];
export const ASSIGNMENT_STATUSES = ['Assigned', 'Overdue', 'Completed', 'Superseded', 'Cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
/** An assignment in one of these states still has to be done. */
export const OPEN_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['Assigned', 'Overdue'];

export const trainingCurricula = pgTable('training_curricula', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description').default('').notNull(),
  methodCode: text('method_code'),
  roles: text('roles').array().notNull(), // empty: every role
  mandatory: boolean('mandatory').default(true).notNull(),
  dueDays: integer('due_days').default(30).notNull(),
  trainingMethod: text('training_method').notNull(),
  isSoftware: boolean('is_software').default(false).notNull(),
  createdBy: text('created_by').references(() => users.id), // null only for the LIMS curriculum the migration installs
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  uniqueIndex('training_curricula_code_lower_uidx').on(sql`lower(${t.code})`),
  uniqueIndex('training_curricula_one_software_uidx').on(t.isSoftware).where(sql`${t.isSoftware}`),
  index('training_curricula_created_by_idx').on(t.createdBy),
  check('training_curricula_method_check', sql`${t.trainingMethod} IN ('READ_AND_UNDERSTOOD', 'OJT')`),
  check('training_curricula_due_days_check', sql`${t.dueDays} BETWEEN 0 AND 365`),
]);

export const trainingCurriculumDocuments = pgTable('training_curriculum_documents', {
  id: text('id').primaryKey(),
  curriculumId: text('curriculum_id').notNull(),
  documentId: text('document_id').notNull().references(() => documents.id),
  addedBy: text('added_by').notNull().references(() => users.id),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Named explicitly: the generated name would be longer than PostgreSQL's 63 characters.
  foreignKey({ name: 'training_curriculum_documents_curriculum_id_fk', columns: [t.curriculumId], foreignColumns: [trainingCurricula.id] }),
  uniqueIndex('training_curriculum_documents_uidx').on(t.curriculumId, t.documentId),
  index('training_curriculum_documents_document_id_idx').on(t.documentId),
  index('training_curriculum_documents_added_by_idx').on(t.addedBy),
]);

export const trainingAssignments = pgTable('training_assignments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  curriculumId: text('curriculum_id').notNull().references(() => trainingCurricula.id),
  documentId: text('document_id').references(() => documents.id),
  documentVersionId: text('document_version_id'),
  trainingMethod: text('training_method').notNull(),
  dueDate: text('due_date').notNull(),
  status: text('status').default('Assigned').notNull(),
  /** 'auto:effective' (a version became Effective), 'auto:sync' (the daily job found a user without it) or 'manual'. */
  origin: text('origin').notNull(),
  trainerId: text('trainer_id').references(() => users.id),
  completedBy: text('completed_by').references(() => users.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  foreignKey({ name: 'training_assignments_document_version_id_fk', columns: [t.documentVersionId], foreignColumns: [documentVersions.id] }),
  uniqueIndex('training_assignments_user_version_uidx').on(t.userId, t.curriculumId, t.documentVersionId).where(sql`${t.documentVersionId} IS NOT NULL`),
  index('training_assignments_user_status_idx').on(t.userId, t.status),
  index('training_assignments_curriculum_id_idx').on(t.curriculumId),
  index('training_assignments_document_id_idx').on(t.documentId),
  index('training_assignments_document_version_id_idx').on(t.documentVersionId),
  index('training_assignments_trainer_id_idx').on(t.trainerId),
  index('training_assignments_completed_by_idx').on(t.completedBy),
  index('training_assignments_created_by_idx').on(t.createdBy),
  check('training_assignments_status_check', sql`${t.status} IN ('Assigned', 'Overdue', 'Completed', 'Superseded', 'Cancelled')`),
  check('training_assignments_method_check', sql`${t.trainingMethod} IN ('READ_AND_UNDERSTOOD', 'OJT')`),
]);

export const analystQualifications = pgTable('analyst_qualifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  methodCode: text('method_code').notNull(),
  basis: text('basis').notNull(),
  reason: text('reason').notNull(),
  validUntil: text('valid_until').notNull(),
  status: text('status').default('Active').notNull(),
  grantedBy: text('granted_by').notNull().references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  revokedBy: text('revoked_by').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('analyst_qualifications_user_method_idx').on(t.userId, t.methodCode),
  index('analyst_qualifications_granted_by_idx').on(t.grantedBy),
  index('analyst_qualifications_revoked_by_idx').on(t.revokedBy),
  check('analyst_qualifications_basis_check', sql`${t.basis} IN ('QA_OVERRIDE')`),
  check('analyst_qualifications_status_check', sql`${t.status} IN ('Active', 'Revoked')`),
]);
