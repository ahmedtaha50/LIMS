// Controlled documents and training records. Owned by r2-docs-training (migration 0200_docs_training, roadmap M28). The migration
// creates the same functions and triggers, so a schema built from the migrations alone is guarded as well.
//
//   document_versions     the content of a submitted version is frozen, an Effective version only moves forward (Superseded,
//                         Obsolete) and its approval record never changes; no version is deleted (gxp_document_version_guard)
//   document_prints       the print log of controlled copies: append-only
//   training_assignments  a Completed assignment is a training record: never changed; no assignment is deleted
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string, rowFunction?: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table, rowFunction).join('; ')}; END IF; END $guard$`;

export const documentsProtections: ProtectionSet = {
  domain: 'documents',
  statements: [
    `CREATE OR REPLACE FUNCTION gxp_document_version_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GxP: DELETE on document_versions is not permitted (controlled document %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'Draft' AND (NEW.document_id, NEW.revision, NEW.title, NEW.change_summary, NEW.file_name, NEW.media_type, NEW.bytes, NEW.file_sha256, NEW.author_id, NEW.created_at)
          IS DISTINCT FROM (OLD.document_id, OLD.revision, OLD.title, OLD.change_summary, OLD.file_name, OLD.media_type, OLD.bytes, OLD.file_sha256, OLD.author_id, OLD.created_at) THEN
        RAISE EXCEPTION 'GxP: the content of controlled document % (status %) cannot be changed', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status IN ('Effective', 'Superseded', 'Obsolete') THEN
        IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'Effective' AND NEW.status IN ('Superseded', 'Obsolete')) OR (OLD.status = 'Superseded' AND NEW.status = 'Obsolete')) THEN
          RAISE EXCEPTION 'GxP: controlled document % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.submitted_at, NEW.submitted_version, NEW.reviewer_id, NEW.reviewed_at, NEW.approver_id, NEW.approved_at, NEW.effective_by, NEW.effective_at)
            IS DISTINCT FROM (OLD.submitted_at, OLD.submitted_version, OLD.reviewer_id, OLD.reviewed_at, OLD.approver_id, OLD.approved_at, OLD.effective_by, OLD.effective_at) THEN
          RAISE EXCEPTION 'GxP: the approval record of controlled document % cannot be changed', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
    `CREATE OR REPLACE FUNCTION gxp_training_assignment_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.status = 'Completed' THEN
        RAISE EXCEPTION 'GxP: % on training record % is not permitted', TG_OP, OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
    whenTableExists('document_versions', 'gxp_document_version_guard'),
    whenTableExists('document_prints'),
    whenTableExists('training_assignments', 'gxp_training_assignment_guard'),
  ],
};
