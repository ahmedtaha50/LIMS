-- 0200_docs_training: controlled documents (SOPs) and the training matrix with qualification gating (roadmap M28, r2-docs-training).
--
-- What this adds, and why:
--   documents                      one row per controlled document: its code (unique ignoring case), title, type and periodic review
--                                  period. The content lives in its versions.
--   document_versions              each revision: Draft, InReview, Approved, Effective, Superseded, Obsolete. The file is kept in the
--                                  content-addressed blob store (src/server/blobs, BLOB_DIR/<sha256>) and named here by its sha256.
--                                  Three people sign each cycle (author DOCUMENT_AUTHORSHIP, reviewer DOCUMENT_REVIEW, approver
--                                  DOCUMENT_APPROVAL); only QA makes a version Effective (DOCUMENT_EFFECTIVE), which supersedes the
--                                  previous Effective version in the same transaction. One Effective version per document (partial
--                                  unique index). Once submitted the content is frozen, and once Effective the row only moves forward
--                                  (Superseded, Obsolete): trigger gxp_document_versions_row_guard.
--   document_prints                the print log of controlled copies (copy number per version). Append-only.
--   training_curricula             what a role must be trained on: documents (read and understood, or on-the-job), optionally for one
--                                  method (method_code); mandatory curricula gate result entry for that method. One curriculum is the
--                                  LIMS software curriculum (is_software): only it sets users.has_completed_software_training.
--   training_curriculum_documents  the documents of a curriculum.
--   training_assignments           one per user, curriculum and document version: created when the version becomes Effective, due
--                                  after the curriculum's due days, marked Overdue by the scheduled job training.overdue, completed by
--                                  the trainee's TRAINING_ACKNOWLEDGEMENT signature (read and understood) or a trainer's
--                                  TRAINING_CERTIFICATION signature (on-the-job, trainer is not the trainee). A completed assignment is
--                                  a training record and cannot be changed or deleted (trigger gxp_training_assignments_row_guard).
--   analyst_qualifications         QA overrides of the qualification gate: per user and method, time-limited, signed
--                                  (QUALIFICATION_OVERRIDE, reason required), revocable; every use is audited on the result.
--   signature_meanings             six meanings (document authorship, review, approval, effectivity, withdrawal; qualification override).
--   permissions                    doc.view, doc.author, doc.review, doc.approve, doc.print, training.manage, training.acknowledge,
--                                  training.override and their grants (positions 200 to 207).
--   training_curricula row         the LIMS software curriculum (LIMS-CORE, "LIMS Core Software", on-the-job).
--
-- No existing table is changed and no existing row is touched (users.has_completed_software_training keeps its value; from now on it
-- is derived from the LIMS curriculum by the application). The constants are written only under the migration runner
-- (WHERE EXISTS schema_migrations), like 0020, 0040 and 0180, because a restore replays this file into an EMPTY database.

CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"doc_type" text NOT NULL,
	"review_period_months" integer DEFAULT 24 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "documents_doc_type_check" CHECK ("documents"."doc_type" IN ('SOP', 'Method', 'Policy', 'Form', 'Specification', 'Other')),
	CONSTRAINT "documents_review_period_check" CHECK ("documents"."review_period_months" BETWEEN 1 AND 120)
);

CREATE TABLE "document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"file_name" text,
	"media_type" text,
	"bytes" bigint,
	"file_sha256" text,
	"author_id" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_version" integer,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	"approver_id" text,
	"approved_at" timestamp with time zone,
	"effective_by" text,
	"effective_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"obsoleted_by" text,
	"obsoleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_versions_status_check" CHECK ("document_versions"."status" IN ('Draft', 'InReview', 'Approved', 'Effective', 'Superseded', 'Obsolete')),
	CONSTRAINT "document_versions_sha256_check" CHECK ("document_versions"."file_sha256" IS NULL OR "document_versions"."file_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "document_prints" (
	"id" text PRIMARY KEY NOT NULL,
	"document_version_id" text NOT NULL,
	"copy_number" integer NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text,
	"printed_by" text NOT NULL,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "training_curricula" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"method_code" text,
	"roles" text[] NOT NULL,
	"mandatory" boolean DEFAULT true NOT NULL,
	"due_days" integer DEFAULT 30 NOT NULL,
	"training_method" text NOT NULL,
	"is_software" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "training_curricula_method_check" CHECK ("training_curricula"."training_method" IN ('READ_AND_UNDERSTOOD', 'OJT')),
	CONSTRAINT "training_curricula_due_days_check" CHECK ("training_curricula"."due_days" BETWEEN 0 AND 365)
);

CREATE TABLE "training_curriculum_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"curriculum_id" text NOT NULL,
	"document_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "training_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"curriculum_id" text NOT NULL,
	"document_id" text,
	"document_version_id" text,
	"training_method" text NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'Assigned' NOT NULL,
	"origin" text NOT NULL,
	"trainer_id" text,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "training_assignments_status_check" CHECK ("training_assignments"."status" IN ('Assigned', 'Overdue', 'Completed', 'Superseded', 'Cancelled')),
	CONSTRAINT "training_assignments_method_check" CHECK ("training_assignments"."training_method" IN ('READ_AND_UNDERSTOOD', 'OJT'))
);

CREATE TABLE "analyst_qualifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method_code" text NOT NULL,
	"basis" text NOT NULL,
	"reason" text NOT NULL,
	"valid_until" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "analyst_qualifications_basis_check" CHECK ("analyst_qualifications"."basis" IN ('QA_OVERRIDE')),
	CONSTRAINT "analyst_qualifications_status_check" CHECK ("analyst_qualifications"."status" IN ('Active', 'Revoked'))
);

ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_effective_by_users_id_fk" FOREIGN KEY ("effective_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_obsoleted_by_users_id_fk" FOREIGN KEY ("obsoleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_prints" ADD CONSTRAINT "document_prints_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_prints" ADD CONSTRAINT "document_prints_printed_by_users_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_curricula" ADD CONSTRAINT "training_curricula_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_curriculum_documents" ADD CONSTRAINT "training_curriculum_documents_curriculum_id_fk" FOREIGN KEY ("curriculum_id") REFERENCES "public"."training_curricula"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_curriculum_documents" ADD CONSTRAINT "training_curriculum_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_curriculum_documents" ADD CONSTRAINT "training_curriculum_documents_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_curriculum_id_training_curricula_id_fk" FOREIGN KEY ("curriculum_id") REFERENCES "public"."training_curricula"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_trainer_id_users_id_fk" FOREIGN KEY ("trainer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "analyst_qualifications" ADD CONSTRAINT "analyst_qualifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "analyst_qualifications" ADD CONSTRAINT "analyst_qualifications_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "analyst_qualifications" ADD CONSTRAINT "analyst_qualifications_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "documents_code_lower_uidx" ON "documents" USING btree (lower("code"));
CREATE INDEX "documents_created_by_idx" ON "documents" USING btree ("created_by");
CREATE UNIQUE INDEX "document_versions_document_revision_uidx" ON "document_versions" USING btree ("document_id","revision");
CREATE UNIQUE INDEX "document_versions_one_effective_uidx" ON "document_versions" USING btree ("document_id") WHERE "document_versions"."status" = 'Effective';
CREATE UNIQUE INDEX "document_versions_one_open_uidx" ON "document_versions" USING btree ("document_id") WHERE "document_versions"."status" IN ('Draft', 'InReview', 'Approved');
CREATE INDEX "document_versions_author_id_idx" ON "document_versions" USING btree ("author_id");
CREATE INDEX "document_versions_reviewer_id_idx" ON "document_versions" USING btree ("reviewer_id");
CREATE INDEX "document_versions_approver_id_idx" ON "document_versions" USING btree ("approver_id");
CREATE INDEX "document_versions_effective_by_idx" ON "document_versions" USING btree ("effective_by");
CREATE INDEX "document_versions_obsoleted_by_idx" ON "document_versions" USING btree ("obsoleted_by");
CREATE UNIQUE INDEX "document_prints_version_copy_uidx" ON "document_prints" USING btree ("document_version_id","copy_number");
CREATE INDEX "document_prints_printed_by_idx" ON "document_prints" USING btree ("printed_by");
CREATE UNIQUE INDEX "training_curricula_code_lower_uidx" ON "training_curricula" USING btree (lower("code"));
CREATE UNIQUE INDEX "training_curricula_one_software_uidx" ON "training_curricula" USING btree ("is_software") WHERE "training_curricula"."is_software";
CREATE INDEX "training_curricula_created_by_idx" ON "training_curricula" USING btree ("created_by");
CREATE UNIQUE INDEX "training_curriculum_documents_uidx" ON "training_curriculum_documents" USING btree ("curriculum_id","document_id");
CREATE INDEX "training_curriculum_documents_document_id_idx" ON "training_curriculum_documents" USING btree ("document_id");
CREATE INDEX "training_curriculum_documents_added_by_idx" ON "training_curriculum_documents" USING btree ("added_by");
CREATE UNIQUE INDEX "training_assignments_user_version_uidx" ON "training_assignments" USING btree ("user_id","curriculum_id","document_version_id") WHERE "training_assignments"."document_version_id" IS NOT NULL;
CREATE INDEX "training_assignments_user_status_idx" ON "training_assignments" USING btree ("user_id","status");
CREATE INDEX "training_assignments_curriculum_id_idx" ON "training_assignments" USING btree ("curriculum_id");
CREATE INDEX "training_assignments_document_id_idx" ON "training_assignments" USING btree ("document_id");
CREATE INDEX "training_assignments_document_version_id_idx" ON "training_assignments" USING btree ("document_version_id");
CREATE INDEX "training_assignments_trainer_id_idx" ON "training_assignments" USING btree ("trainer_id");
CREATE INDEX "training_assignments_completed_by_idx" ON "training_assignments" USING btree ("completed_by");
CREATE INDEX "training_assignments_created_by_idx" ON "training_assignments" USING btree ("created_by");
CREATE INDEX "analyst_qualifications_user_method_idx" ON "analyst_qualifications" USING btree ("user_id","method_code");
CREATE INDEX "analyst_qualifications_granted_by_idx" ON "analyst_qualifications" USING btree ("granted_by");
CREATE INDEX "analyst_qualifications_revoked_by_idx" ON "analyst_qualifications" USING btree ("revoked_by");

-- ---- database-level controls (the same statements are in src/db/protections/documents.ts, re-applied at every start) -----------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

-- A submitted version's content is frozen; an Effective version only moves forward; no version is ever deleted.
CREATE OR REPLACE FUNCTION gxp_document_version_guard() RETURNS trigger AS $$
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
    $$ LANGUAGE plpgsql;

-- A completed assignment is a training record: it is never changed or deleted. Open assignments are not deleted either.
CREATE OR REPLACE FUNCTION gxp_training_assignment_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.status = 'Completed' THEN
        RAISE EXCEPTION 'GxP: % on training record % is not permitted', TG_OP, OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gxp_document_versions_row_guard ON document_versions;
CREATE TRIGGER gxp_document_versions_row_guard BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION gxp_document_version_guard();
DROP TRIGGER IF EXISTS gxp_document_versions_truncate_guard ON document_versions;
CREATE TRIGGER gxp_document_versions_truncate_guard BEFORE TRUNCATE ON document_versions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_document_prints_row_guard ON document_prints;
CREATE TRIGGER gxp_document_prints_row_guard BEFORE UPDATE OR DELETE ON document_prints FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_document_prints_truncate_guard ON document_prints;
CREATE TRIGGER gxp_document_prints_truncate_guard BEFORE TRUNCATE ON document_prints FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_training_assignments_row_guard ON training_assignments;
CREATE TRIGGER gxp_training_assignments_row_guard BEFORE UPDATE OR DELETE ON training_assignments FOR EACH ROW EXECUTE FUNCTION gxp_training_assignment_guard();
DROP TRIGGER IF EXISTS gxp_training_assignments_truncate_guard ON training_assignments;
CREATE TRIGGER gxp_training_assignments_truncate_guard BEFORE TRUNCATE ON training_assignments FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "training_curricula" ("id", "code", "title", "description", "roles", "training_method", "is_software", "due_days")
SELECT 'CUR-LIMS-CORE', 'LIMS-CORE', 'LIMS Core Software',
	'Use of this LIMS, including electronic signatures. Completing it is what enables a user to sign (has_completed_software_training).', '{}'::text[], 'OJT', true, 30
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('DOCUMENT_AUTHORSHIP', 'Document authorship: I wrote this version of the document, it is complete and accurate, and I submit it for review.', ARRAY['Analyst','Reviewer','QA','Admin'], false, false),
	('DOCUMENT_REVIEW', 'Document review: I have reviewed this version of the document for technical accuracy and completeness.', ARRAY['Reviewer','QA','Admin'], false, false),
	('DOCUMENT_APPROVAL', 'Document approval: I approve this version of the document for issue.', ARRAY['QA','Admin'], false, false),
	('DOCUMENT_EFFECTIVE', 'Document effectivity: I release this approved version as the effective version; the previous version is superseded and training is assigned.', ARRAY['QA'], false, false),
	('DOCUMENT_OBSOLETE', 'Document withdrawal: I withdraw this document from use; it becomes obsolete.', ARRAY['QA','Admin'], true, false),
	('QUALIFICATION_OVERRIDE', 'Qualification override: I authorise this analyst to perform this method before the required training is complete, for the period and the reason stated.', ARRAY['QA'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('doc.view', 'Documents', 'Read controlled documents, their versions and files', 200),
	('doc.author', 'Documents', 'Draft a controlled document or a new revision, and submit it for review with an authorship signature', 201),
	('doc.review', 'Documents', 'Review a submitted document version with an e-signature, or return it to Draft', 202),
	('doc.approve', 'Documents', 'Approve a reviewed document version, make it effective (QA) or withdraw it, with an e-signature', 203),
	('doc.print', 'Documents', 'Print a numbered controlled copy of an effective document (print log)', 204),
	('training.manage', 'Training', 'Define curricula and assign training', 205),
	('training.acknowledge', 'Training', 'Sign one''s own training assignment as read and understood', 206),
	('training.override', 'Training', 'Authorise a time-limited qualification override for an analyst with an e-signature', 207)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'doc.view'), ('role-admin', 'doc.author'), ('role-admin', 'doc.review'), ('role-admin', 'doc.approve'), ('role-admin', 'doc.print'),
	('role-admin', 'training.manage'), ('role-admin', 'training.acknowledge'), ('role-admin', 'training.override'),
	('role-qa', 'doc.view'), ('role-qa', 'doc.author'), ('role-qa', 'doc.review'), ('role-qa', 'doc.approve'), ('role-qa', 'doc.print'),
	('role-qa', 'training.manage'), ('role-qa', 'training.acknowledge'), ('role-qa', 'training.override'),
	('role-reviewer', 'doc.view'), ('role-reviewer', 'doc.author'), ('role-reviewer', 'doc.review'), ('role-reviewer', 'doc.print'), ('role-reviewer', 'training.acknowledge'),
	('role-analyst', 'doc.view'), ('role-analyst', 'doc.author'), ('role-analyst', 'doc.print'), ('role-analyst', 'training.acknowledge')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
