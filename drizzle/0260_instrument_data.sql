-- 0260_instrument_data: instrument data capture: mapping profiles, captured files, staged rows, result sources, usage log
-- (roadmap M21, r2-instrument-integration).
--
-- What this adds, and why (21 CFR 211.68 and 211.194(a), 11.10(e), EU GMP Annex 11 s.5 and s.7, ALCOA+: original, attributable, accurate):
--   instrument_profiles           configuration of one capture path: the instrument, the folder an instrument exports to, a file-name
--                                 pattern, the parser and its column mapping. A mapping decides which number becomes which result, so it
--                                 is approved with an e-signature (INSTRUMENT_PROFILE_APPROVAL, never by the person who wrote it) and
--                                 only an Approved profile is watched. Editing an Approved profile makes it Draft again.
--   instrument_profile_revisions  the content of a profile at every version, append-only: a signature on a profile covers the revision
--                                 it was made on, and stays verifiable after a later edit.
--   instrument_files              one row per captured file. The bytes are in the blob store (BLOB_DIR/<sha256>, never altered); the
--                                 sha256 is unique, so the same content is refused the second time. parse_status Parsed or Failed
--                                 (with a readable error). Only disposition (Pending, Processed, Error: where the file went), its
--                                 note and the version counter may change afterwards; deletes and every other change are refused by trigger.
--   instrument_import_rows        the values parsed from a file, staged. Nothing becomes a result until a named analyst accepts the row
--                                 (Pending -> Accepted through saveResult, or Rejected with a reason). A sample with a Pending row
--                                 naming it cannot move to Pending Review (transition guard unaccepted-imports).
--   result_sources                sidecar of results: which captured file and row a result version came from, who accepted it.
--                                 Append-only.
--   instrument_usage_log          one row per capture and per accepted value, per instrument. Append-only.
--   signature_meanings            INSTRUMENT_PROFILE_APPROVAL (QA, Admin).
--   permissions                   instrument.profile.manage (QA, Admin), instrument.profile.approve (QA, Admin), positions 260 and 261.
--
-- The CDS (chromatography data system) stays the system of record for raw chromatographic data: only the summary values it exports
-- are staged here, and the exported file is kept as received. No existing row is changed. The constants are written only under the
-- migration runner (WHERE EXISTS schema_migrations), like 0020, 0040 and 0230, because a restore replays this file into an EMPTY database.

CREATE TABLE "instrument_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"name" text NOT NULL,
	"parser" text NOT NULL,
	"watch_dir" text NOT NULL,
	"glob" text DEFAULT '*' NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "instrument_profiles_parser_check" CHECK ("instrument_profiles"."parser" IN ('generic-csv', 'balance-text', 'ph-csv', 'hplc-summary-csv')),
	CONSTRAINT "instrument_profiles_status_check" CHECK ("instrument_profiles"."status" IN ('Draft', 'Approved', 'Retired')),
	CONSTRAINT "instrument_profiles_approval_check" CHECK (("instrument_profiles"."status" = 'Approved') = ("instrument_profiles"."approved_by" IS NOT NULL))
);

CREATE TABLE "instrument_profile_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "instrument_files" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"file_name" text NOT NULL,
	"source" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"parse_status" text NOT NULL,
	"parse_error" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"disposition" text DEFAULT 'Pending' NOT NULL,
	"disposition_note" text,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "instrument_files_source_check" CHECK ("instrument_files"."source" IN ('watch', 'upload')),
	CONSTRAINT "instrument_files_parse_status_check" CHECK ("instrument_files"."parse_status" IN ('Parsed', 'Failed')),
	CONSTRAINT "instrument_files_disposition_check" CHECK ("instrument_files"."disposition" IN ('Pending', 'Processed', 'Error')),
	CONSTRAINT "instrument_files_sha256_check" CHECK ("instrument_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "instrument_files_bytes_check" CHECK ("instrument_files"."bytes" > 0)
);

CREATE TABLE "instrument_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"sample_ref" text,
	"parameter" text NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'Pending' NOT NULL,
	"result_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "instrument_import_rows_state_check" CHECK ("instrument_import_rows"."state" IN ('Pending', 'Accepted', 'Rejected')),
	CONSTRAINT "instrument_import_rows_decision_check" CHECK (("instrument_import_rows"."state" = 'Pending') = ("instrument_import_rows"."decided_by" IS NULL))
);

CREATE TABLE "result_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"result_version" integer NOT NULL,
	"source" text NOT NULL,
	"file_id" text NOT NULL,
	"import_row_id" text NOT NULL,
	"sha256" text NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_sources_source_check" CHECK ("result_sources"."source" IN ('instrument')),
	CONSTRAINT "result_sources_sha256_check" CHECK ("result_sources"."sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "instrument_usage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"event" text NOT NULL,
	"file_id" text,
	"sample_id" text,
	"result_id" text,
	"user_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_usage_log_event_check" CHECK ("instrument_usage_log"."event" IN ('DataCaptured', 'ResultAccepted'))
);

ALTER TABLE "instrument_profiles" ADD CONSTRAINT "instrument_profiles_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_profiles" ADD CONSTRAINT "instrument_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_profiles" ADD CONSTRAINT "instrument_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_profile_revisions" ADD CONSTRAINT "instrument_profile_revisions_profile_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."instrument_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_profile_revisions" ADD CONSTRAINT "instrument_profile_revisions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_files" ADD CONSTRAINT "instrument_files_profile_id_instrument_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."instrument_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_files" ADD CONSTRAINT "instrument_files_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_files" ADD CONSTRAINT "instrument_files_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_import_rows" ADD CONSTRAINT "instrument_import_rows_file_id_instrument_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."instrument_files"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_import_rows" ADD CONSTRAINT "instrument_import_rows_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_import_rows" ADD CONSTRAINT "instrument_import_rows_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_sources" ADD CONSTRAINT "result_sources_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_sources" ADD CONSTRAINT "result_sources_file_id_instrument_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."instrument_files"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_sources" ADD CONSTRAINT "result_sources_import_row_id_instrument_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."instrument_import_rows"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_sources" ADD CONSTRAINT "result_sources_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_usage_log" ADD CONSTRAINT "instrument_usage_log_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_usage_log" ADD CONSTRAINT "instrument_usage_log_file_id_instrument_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."instrument_files"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_usage_log" ADD CONSTRAINT "instrument_usage_log_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_usage_log" ADD CONSTRAINT "instrument_usage_log_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "instrument_usage_log" ADD CONSTRAINT "instrument_usage_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "instrument_profiles_name_uidx" ON "instrument_profiles" USING btree ("name");
CREATE INDEX "instrument_profiles_instrument_id_idx" ON "instrument_profiles" USING btree ("instrument_id");
CREATE INDEX "instrument_profiles_created_by_idx" ON "instrument_profiles" USING btree ("created_by");
CREATE INDEX "instrument_profiles_approved_by_idx" ON "instrument_profiles" USING btree ("approved_by");
CREATE UNIQUE INDEX "instrument_profile_revisions_version_uidx" ON "instrument_profile_revisions" USING btree ("profile_id","version");
CREATE INDEX "instrument_profile_revisions_changed_by_idx" ON "instrument_profile_revisions" USING btree ("changed_by");
CREATE UNIQUE INDEX "instrument_files_sha256_uidx" ON "instrument_files" USING btree ("sha256");
CREATE INDEX "instrument_files_profile_id_idx" ON "instrument_files" USING btree ("profile_id");
CREATE INDEX "instrument_files_instrument_id_idx" ON "instrument_files" USING btree ("instrument_id");
CREATE INDEX "instrument_files_received_by_idx" ON "instrument_files" USING btree ("received_by");
CREATE INDEX "instrument_import_rows_file_id_idx" ON "instrument_import_rows" USING btree ("file_id");
CREATE INDEX "instrument_import_rows_sample_state_idx" ON "instrument_import_rows" USING btree ("sample_ref","state");
CREATE INDEX "instrument_import_rows_result_id_idx" ON "instrument_import_rows" USING btree ("result_id");
CREATE INDEX "instrument_import_rows_decided_by_idx" ON "instrument_import_rows" USING btree ("decided_by");
CREATE UNIQUE INDEX "result_sources_result_version_uidx" ON "result_sources" USING btree ("result_id","result_version");
CREATE UNIQUE INDEX "result_sources_import_row_uidx" ON "result_sources" USING btree ("import_row_id");
CREATE INDEX "result_sources_file_id_idx" ON "result_sources" USING btree ("file_id");
CREATE INDEX "result_sources_accepted_by_idx" ON "result_sources" USING btree ("accepted_by");
CREATE INDEX "instrument_usage_log_instrument_at_idx" ON "instrument_usage_log" USING btree ("instrument_id","at");
CREATE INDEX "instrument_usage_log_file_id_idx" ON "instrument_usage_log" USING btree ("file_id");
CREATE INDEX "instrument_usage_log_sample_id_idx" ON "instrument_usage_log" USING btree ("sample_id");
CREATE INDEX "instrument_usage_log_result_id_idx" ON "instrument_usage_log" USING btree ("result_id");
CREATE INDEX "instrument_usage_log_user_id_idx" ON "instrument_usage_log" USING btree ("user_id");

-- ---- append-only tables, and the file register whose only mutable part is where the file went ----------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gxp_instrument_files_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'disposition' - 'disposition_note' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'disposition' - 'disposition_note' - 'version') THEN
    RAISE EXCEPTION 'GxP: % on % is not permitted (only the disposition of a captured file may change)', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gxp_instrument_profile_revisions_row_guard BEFORE UPDATE OR DELETE ON instrument_profile_revisions FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_instrument_profile_revisions_truncate_guard BEFORE TRUNCATE ON instrument_profile_revisions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_result_sources_row_guard BEFORE UPDATE OR DELETE ON result_sources FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_result_sources_truncate_guard BEFORE TRUNCATE ON result_sources FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_instrument_usage_log_row_guard BEFORE UPDATE OR DELETE ON instrument_usage_log FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_instrument_usage_log_truncate_guard BEFORE TRUNCATE ON instrument_usage_log FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_instrument_files_row_guard BEFORE UPDATE OR DELETE ON instrument_files FOR EACH ROW EXECUTE FUNCTION gxp_instrument_files_guard();
CREATE TRIGGER gxp_instrument_files_truncate_guard BEFORE TRUNCATE ON instrument_files FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) -------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('INSTRUMENT_PROFILE_APPROVAL', 'Approval of instrument data mapping: I have reviewed the instrument, the folder, the parser and the column mapping of this profile, and approve it for the capture of results.', ARRAY['QA','Admin'], false, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('instrument.profile.manage', 'Equipment', 'Define and edit the capture profiles of instruments (folder, parser, mapping); an edit of an approved profile needs a new approval', 260),
	('instrument.profile.approve', 'Equipment', 'Approve a capture profile with an e-signature (never the person who wrote or last edited it)', 261)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'instrument.profile.manage'), ('role-admin', 'instrument.profile.approve'),
	('role-qa', 'instrument.profile.manage'), ('role-qa', 'instrument.profile.approve')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
