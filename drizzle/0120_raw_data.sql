-- 0120_raw_data: raw-data integrity: result versions, the attachment register, review checklists (roadmap M20, r2-raw-data).
--
-- What this adds, and why (21 CFR 211.194(a), 11.10(e), ALCOA+):
--   result_versions    every value a result has held, one row per write, with a coded reason. results keeps only the latest value; its
--                      history used to exist only as free text in the audit trail. Written in the transaction of the result write
--                      (src/server/services/saveResult.ts). INITIAL_ENTRY and MIGRATED are written by the server; the correction codes
--                      come from the person (src/server/services/result-hooks/codes.ts). A REINTEGRATION needs a QA signature
--                      (REINTEGRATION_APPROVAL, entity ResultVersion) before the sample can be approved. Append-only.
--   attachments        the register of raw-data files. The bytes are not in the database: they are content-addressed files
--                      BLOB_DIR/<sha256> (src/server/blobs), re-hashed on every read and carried by the backup's blob section
--                      (src/server/backup-blobs.ts). Append-only: a file is never replaced or removed.
--   review_checklists  the reviewer's manual attestations, with the server items as evaluated when they were recorded
--                      (src/server/review.ts). Append-only. Approval re-evaluates the server items itself.
--   signature_meanings REINTEGRATION_APPROVAL (QA, Admin; reason required).
--   permissions        result.reintegration.approve (position 120), granted to QA and Admin.
--
-- Existing data: every result that holds a value gets one result_versions row (code MIGRATED) with its current value, version, flag,
-- instrument, author and time, so its history starts at the value it had at the upgrade (earlier changes stay in the audit trail).
-- No existing row is changed. Results without a value get nothing. On an empty database (a restore replays this file before the data
-- is loaded) the backfill inserts nothing. The constants are written only under the migration runner (WHERE EXISTS schema_migrations),
-- like 0020, 0040, 0100 and 0180.
-- Legacy inline attachments (results.attachment_name / attachment_data, base64 text) are left where they are: they are read as before.

CREATE TABLE "result_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"result_version" integer NOT NULL,
	"value" text,
	"previous_value" text,
	"is_oos" boolean NOT NULL,
	"change_code" text NOT NULL,
	"reason" text NOT NULL,
	"oos_id" text,
	"instrument_id" text,
	"entered_by" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_versions_change_code_check" CHECK ("result_versions"."change_code" IN ('INITIAL_ENTRY', 'MIGRATED', 'TRANSCRIPTION_ERROR', 'CALCULATION_ERROR', 'INSTRUMENT_MALFUNCTION', 'SAMPLE_PREPARATION_ERROR', 'METHOD_DEVIATION', 'REINTEGRATION'))
);

CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"result_id" text,
	"file_name" text NOT NULL,
	"media_type" text NOT NULL,
	"kind" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"description" text,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_sha256_check" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachments_bytes_check" CHECK ("attachments"."bytes" > 0)
);

CREATE TABLE "review_checklists" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"sample_version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"attestations" jsonb NOT NULL,
	"server_items_passed" boolean NOT NULL,
	"comment" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "review_checklists" ADD CONSTRAINT "review_checklists_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "review_checklists" ADD CONSTRAINT "review_checklists_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "result_versions_result_version_uidx" ON "result_versions" USING btree ("result_id","result_version");
CREATE INDEX "result_versions_sample_id_idx" ON "result_versions" USING btree ("sample_id");
CREATE INDEX "result_versions_instrument_id_idx" ON "result_versions" USING btree ("instrument_id");
CREATE INDEX "result_versions_entered_by_idx" ON "result_versions" USING btree ("entered_by");
CREATE INDEX "attachments_sample_id_idx" ON "attachments" USING btree ("sample_id");
CREATE INDEX "attachments_result_id_idx" ON "attachments" USING btree ("result_id");
CREATE INDEX "attachments_sha256_idx" ON "attachments" USING btree ("sha256");
CREATE INDEX "attachments_uploaded_by_idx" ON "attachments" USING btree ("uploaded_by");
CREATE INDEX "review_checklists_sample_id_idx" ON "review_checklists" USING btree ("sample_id");
CREATE INDEX "review_checklists_recorded_by_idx" ON "review_checklists" USING btree ("recorded_by");

-- ---- the value every entered result holds now becomes its first version ---------------------------------------------------------

INSERT INTO "result_versions" ("id", "result_id", "sample_id", "result_version", "value", "previous_value", "is_oos", "change_code", "reason", "instrument_id", "entered_by", "entered_at")
SELECT 'rv-mig-' || r."id", r."id", r."sample_id", r."version", r."value", NULL, r."is_oos", 'MIGRATED',
       'Value held by the result when result versions were introduced (migration 0120); earlier changes are in the audit trail.',
       r."instrument_id", r."entered_by", COALESCE(r."entered_at", now())
FROM "results" r
WHERE r."value" IS NOT NULL AND r."value" <> '';

-- ---- the three tables are append-only -------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_result_versions_row_guard BEFORE UPDATE OR DELETE ON result_versions FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_result_versions_truncate_guard BEFORE TRUNCATE ON result_versions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_attachments_row_guard BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_attachments_truncate_guard BEFORE TRUNCATE ON attachments FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_review_checklists_row_guard BEFORE UPDATE OR DELETE ON review_checklists FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_review_checklists_truncate_guard BEFORE TRUNCATE ON review_checklists FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('REINTEGRATION_APPROVAL', 'Reintegration approval: I have reviewed this reprocessing of the raw data against the procedure and approve the reported value.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('result.reintegration.approve', 'Samples', 'Approve a reintegrated result with an e-signature (never the person who reintegrated it)', 120)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'result.reintegration.approve'),
	('role-qa', 'result.reintegration.approve')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
