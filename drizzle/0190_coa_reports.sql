-- 0190_coa_reports: the controlled Certificate of Analysis and the register of generated documents (roadmap M25, r2-coa-reports).
--
-- What this adds, and why:
--   coa_documents      one row per issue of a certificate. `number` (COA-<year>-<n>) comes from the gap-free `counters` table
--                      (src/server/core/tx.ts nextSequence, key coa:<year>) and is kept by every re-issue; `issue_version` counts the
--                      issues of that number and `label` is <number>-v<issue_version>. `snapshot` is the frozen content the certificate
--                      prints (results, methods, limits, conclusion, batch dates, approvals), and `snapshot_sha256` its hash; the issue is
--                      signed (COA_AUTHORISATION, signatures.entity_type = 'CoaDocument') and bound to the row's `version`.
--                      Status Issued -> Superseded (by a re-issue, with the reason and the successor) or Voided (signed withdrawal,
--                      COA_VOID, with the reason). One Issued certificate per sample (partial unique index). `pdf_sha256` and
--                      `original_run_id` name the original PDF (copy 1) once the job has made it. `version` is the optimistic-
--                      concurrency counter.
--   report_runs        every generated document, with its bytes, their sha256, the copy number (gap-free per document, counter
--                      report-copy:<document id>), the state of the document and the watermark it was printed with, and who it was
--                      made for. Append-only.
--   report_print_log   every delivery of a run's bytes (who, when). Append-only.
--   signature_meanings COA_AUTHORISATION and COA_VOID (QA, Admin).
--   permissions        coa.issue (position 190) for Admin and QA; the description of report.generate says what it now does.
--
-- The database itself refuses what a controlled document must never undergo (trigger gxp_coa_documents_guard): a change of its number,
-- version, label, sample, specification, snapshot, hash or authorisation; a status move other than Issued -> Superseded | Voided; a
-- supersede or void without its reason; a second PDF hash; a DELETE or TRUNCATE.
-- No existing table is changed and no existing row is touched. The constants are written only under the migration runner
-- (WHERE EXISTS schema_migrations), like 0020, 0040, 0100 and 0180, because a restore replays this file into an EMPTY database.

CREATE TABLE "coa_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"number" text NOT NULL,
	"issue_version" integer NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'Issued' NOT NULL,
	"spec_id" text,
	"spec_revision" integer,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"supersedes_id" text,
	"superseded_by_id" text,
	"superseded_by" text,
	"superseded_at" timestamp with time zone,
	"superseded_reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"pdf_sha256" text,
	"original_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "coa_documents_status_check" CHECK ("coa_documents"."status" IN ('Issued', 'Superseded', 'Voided')),
	CONSTRAINT "coa_documents_number_check" CHECK ("coa_documents"."number" ~ '^COA-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "coa_documents_issue_version_check" CHECK ("coa_documents"."issue_version" >= 1),
	CONSTRAINT "coa_documents_label_check" CHECK ("coa_documents"."label" = "coa_documents"."number" || '-v' || "coa_documents"."issue_version"),
	CONSTRAINT "coa_documents_snapshot_sha256_check" CHECK ("coa_documents"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "coa_documents_pdf_sha256_check" CHECK ("coa_documents"."pdf_sha256" IS NULL OR "coa_documents"."pdf_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"report_type" text NOT NULL,
	"document_id" text,
	"copy_no" integer NOT NULL,
	"purpose" text NOT NULL,
	"document_status" text NOT NULL,
	"watermark" text,
	"file_name" text NOT NULL,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"bytes" integer NOT NULL,
	"pdf_sha256" text NOT NULL,
	"pdf" bytea NOT NULL,
	"job_id" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_runs_report_type_check" CHECK ("report_runs"."report_type" IN ('CoA')),
	CONSTRAINT "report_runs_purpose_check" CHECK ("report_runs"."purpose" IN ('Original', 'Copy')),
	CONSTRAINT "report_runs_document_check" CHECK ("report_runs"."report_type" <> 'CoA' OR "report_runs"."document_id" IS NOT NULL),
	CONSTRAINT "report_runs_copy_no_check" CHECK ("report_runs"."copy_no" >= 1),
	CONSTRAINT "report_runs_bytes_check" CHECK ("report_runs"."bytes" > 0),
	CONSTRAINT "report_runs_pdf_sha256_check" CHECK ("report_runs"."pdf_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "report_print_log" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"action" text NOT NULL,
	"printed_by" text NOT NULL,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_print_log_action_check" CHECK ("report_print_log"."action" IN ('Download'))
);

ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_spec_id_specifications_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specifications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_supersedes_id_coa_documents_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."coa_documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_superseded_by_users_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "coa_documents" ADD CONSTRAINT "coa_documents_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_document_id_coa_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."coa_documents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "report_print_log" ADD CONSTRAINT "report_print_log_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "report_print_log" ADD CONSTRAINT "report_print_log_printed_by_users_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "coa_documents_number_issue_version_uidx" ON "coa_documents" USING btree ("number","issue_version");
CREATE UNIQUE INDEX "coa_documents_one_issued_per_sample_uidx" ON "coa_documents" USING btree ("sample_id") WHERE "coa_documents"."status" = 'Issued';
CREATE UNIQUE INDEX "coa_documents_supersedes_id_uidx" ON "coa_documents" USING btree ("supersedes_id");
CREATE INDEX "coa_documents_sample_id_idx" ON "coa_documents" USING btree ("sample_id");
CREATE INDEX "coa_documents_spec_id_idx" ON "coa_documents" USING btree ("spec_id");
CREATE INDEX "coa_documents_issued_by_idx" ON "coa_documents" USING btree ("issued_by");
CREATE INDEX "coa_documents_superseded_by_idx" ON "coa_documents" USING btree ("superseded_by");
CREATE INDEX "coa_documents_voided_by_idx" ON "coa_documents" USING btree ("voided_by");
CREATE UNIQUE INDEX "report_runs_document_copy_uidx" ON "report_runs" USING btree ("document_id","copy_no");
CREATE UNIQUE INDEX "report_runs_one_original_uidx" ON "report_runs" USING btree ("document_id") WHERE "report_runs"."purpose" = 'Original';
CREATE INDEX "report_runs_generated_by_idx" ON "report_runs" USING btree ("generated_by");
CREATE INDEX "report_print_log_run_id_idx" ON "report_print_log" USING btree ("run_id");
CREATE INDEX "report_print_log_printed_by_idx" ON "report_print_log" USING btree ("printed_by");

-- ---- the database-level controls (src/db/protections/reports.ts installs the same statements at every start) --------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gxp_coa_documents_guard() RETURNS trigger AS $$
    DECLARE problem text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        problem := 'a certificate is never deleted (void it instead)';
      ELSIF ROW(NEW.id, NEW.sample_id, NEW.number, NEW.issue_version, NEW.label, NEW.spec_id, NEW.spec_revision, NEW.snapshot,
                NEW.snapshot_sha256, NEW.issued_by, NEW.issued_at, NEW.supersedes_id, NEW.created_at)
            IS DISTINCT FROM
            ROW(OLD.id, OLD.sample_id, OLD.number, OLD.issue_version, OLD.label, OLD.spec_id, OLD.spec_revision, OLD.snapshot,
                OLD.snapshot_sha256, OLD.issued_by, OLD.issued_at, OLD.supersedes_id, OLD.created_at) THEN
        problem := 'the number, version, sample, specification, snapshot and authorisation of a certificate never change';
      ELSIF OLD.pdf_sha256 IS NOT NULL AND ROW(NEW.pdf_sha256, NEW.original_run_id) IS DISTINCT FROM ROW(OLD.pdf_sha256, OLD.original_run_id) THEN
        problem := 'the original PDF of a certificate is recorded once';
      ELSIF OLD.status <> 'Issued' AND NEW.status <> OLD.status THEN
        problem := format('a %s certificate stays %s', OLD.status, OLD.status);
      ELSIF ROW(OLD.superseded_by_id, OLD.superseded_by, OLD.superseded_at, OLD.superseded_reason) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz, NULL::text)
            AND ROW(NEW.superseded_by_id, NEW.superseded_by, NEW.superseded_at, NEW.superseded_reason) IS DISTINCT FROM ROW(OLD.superseded_by_id, OLD.superseded_by, OLD.superseded_at, OLD.superseded_reason) THEN
        problem := 'the supersede record of a certificate never changes';
      ELSIF ROW(OLD.voided_by, OLD.voided_at, OLD.void_reason) IS DISTINCT FROM ROW(NULL::text, NULL::timestamptz, NULL::text)
            AND ROW(NEW.voided_by, NEW.voided_at, NEW.void_reason) IS DISTINCT FROM ROW(OLD.voided_by, OLD.voided_at, OLD.void_reason) THEN
        problem := 'the void record of a certificate never changes';
      ELSIF NEW.status = 'Superseded' AND (NEW.superseded_by_id IS NULL OR NEW.superseded_by IS NULL OR NEW.superseded_at IS NULL OR coalesce(btrim(NEW.superseded_reason), '') = '') THEN
        problem := 'a superseded certificate names its successor, who superseded it, when and why';
      ELSIF NEW.status = 'Voided' AND (NEW.voided_by IS NULL OR NEW.voided_at IS NULL OR coalesce(btrim(NEW.void_reason), '') = '') THEN
        problem := 'a voided certificate names who voided it, when and why';
      ELSIF NEW.status <> 'Superseded' AND ROW(NEW.superseded_by_id, NEW.superseded_by, NEW.superseded_at, NEW.superseded_reason) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz, NULL::text) THEN
        problem := 'only a superseded certificate has a supersede record';
      ELSIF NEW.status <> 'Voided' AND ROW(NEW.voided_by, NEW.voided_at, NEW.void_reason) IS DISTINCT FROM ROW(NULL::text, NULL::timestamptz, NULL::text) THEN
        problem := 'only a voided certificate has a void record';
      END IF;
      IF problem IS NOT NULL THEN
        RAISE EXCEPTION 'GxP: % on coa_documents is not permitted (controlled document): %', TG_OP, problem
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

CREATE TRIGGER gxp_coa_documents_row_guard BEFORE UPDATE OR DELETE ON coa_documents FOR EACH ROW EXECUTE FUNCTION gxp_coa_documents_guard();
CREATE TRIGGER gxp_coa_documents_truncate_guard BEFORE TRUNCATE ON coa_documents FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_report_runs_row_guard BEFORE UPDATE OR DELETE ON report_runs FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_report_runs_truncate_guard BEFORE TRUNCATE ON report_runs FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_report_print_log_row_guard BEFORE UPDATE OR DELETE ON report_print_log FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_report_print_log_truncate_guard BEFORE TRUNCATE ON report_print_log FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('COA_AUTHORISATION', 'Authorisation of Certificate of Analysis: I have reviewed the certified results against the specification and authorise this certificate for issue.', ARRAY['QA','Admin'], false, false),
	('COA_VOID', 'Withdrawal of Certificate of Analysis: I withdraw this certificate; it must no longer be used or relied on.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('coa.issue', 'Reports', 'Issue, re-issue or void a Certificate of Analysis with an e-signature (never someone who tested the sample)', 190)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

-- report.generate no longer makes a certificate: POST /reports/generate is a results preview, and the certificate is issued with coa.issue.
UPDATE "permissions" SET "description" = 'Request a results preview or a controlled copy of an issued certificate, and collect it' WHERE "code" = 'report.generate';

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'coa.issue'),
	('role-qa', 'coa.issue')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
