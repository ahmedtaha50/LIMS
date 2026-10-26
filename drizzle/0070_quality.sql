-- 0070_quality: calibration history, environmental limits and excursions, a version on instruments, the VERIFICATION meaning
-- (roadmap M13, r1-quality-fixes).
--
-- instruments          + version (optimistic concurrency, and the record version a calibration signature is bound to).
-- calibration_history  One row per signed calibration: who, when, the due date before and after, the status before and after,
--                      the instrument version it produced and the reason. Append-only (UPDATE, DELETE and TRUNCATE are refused by
--                      the triggers below, which use the shared refusal function of src/db/protections/common.ts).
-- env_limits           Environmental monitoring limits per cleanroom grade and sample type: the alert limit (optional, the site
--                      sets it from its own trend data) and the action limit. Site data, not code: QA approves and edits the rows.
-- env_records          + sample_type, and the limits the record was judged against (limit_alert, limit_action), so a later edit of
--                      the limits table does not change what an old result was compared with.
-- env_excursions       One row per action-level result: opened in the same transaction as the record, never closed by an edit of
--                      the count (closing it is an investigation decision, not a recount).
-- signature_meanings   + VERIFICATION: a second person verifies what someone else recorded (a dispensing against its CoA).
--
-- Seeded rows (env_limits, signature_meanings) are written only under the migration runner (WHERE EXISTS schema_migrations),
-- like 0020 and 0040: a restore replays this file into an empty database and then loads the rows of the backup.
--
-- The env_limits seed is the example table the roadmap gives for EU GMP Annex 1 (2022): maximum action limits for viable
-- particles, Grade A "no growth" (stored as 0: any count above 0 is an action-level result), no alert limits. They are examples:
-- approved_by is NULL until the site's QA approves its own limits, and the source column says so.
--
-- Existing rows: nothing is rewritten. Instruments start at version 1; environmental records keep their status text (a v0.1.0
-- record may say 'Action Level' or carry the grade 'A') and have no sample type until a QA edit gives them one.

ALTER TABLE "instruments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;

CREATE TABLE "calibration_history" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"performed_by" text NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_due_date" text NOT NULL,
	"new_due_date" text NOT NULL,
	"status_before" text NOT NULL,
	"status_after" text NOT NULL,
	"instrument_version" integer NOT NULL,
	"reason" text NOT NULL
);

ALTER TABLE "calibration_history" ADD CONSTRAINT "calibration_history_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "calibration_history" ADD CONSTRAINT "calibration_history_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "calibration_history_instrument_version_uidx" ON "calibration_history" USING btree ("instrument_id","instrument_version");
CREATE INDEX "calibration_history_performed_by_idx" ON "calibration_history" USING btree ("performed_by");

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_calibration_history_row_guard BEFORE UPDATE OR DELETE ON calibration_history FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_calibration_history_truncate_guard BEFORE TRUNCATE ON calibration_history FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

CREATE TABLE "env_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"grade" text NOT NULL,
	"sample_type" text NOT NULL,
	"unit" text NOT NULL,
	"alert_limit" integer,
	"action_limit" integer NOT NULL,
	"source" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);

ALTER TABLE "env_limits" ADD CONSTRAINT "env_limits_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "env_limits_active_uidx" ON "env_limits" USING btree ("grade","sample_type") WHERE "env_limits"."active";

ALTER TABLE "env_records" ADD COLUMN "sample_type" text;
ALTER TABLE "env_records" ADD COLUMN "limit_alert" integer;
ALTER TABLE "env_records" ADD COLUMN "limit_action" integer;

CREATE TABLE "env_excursions" (
	"id" text PRIMARY KEY NOT NULL,
	"env_record_id" text NOT NULL,
	"level" text NOT NULL,
	"grade" text NOT NULL,
	"sample_type" text NOT NULL,
	"viable_count" integer NOT NULL,
	"limit_value" integer NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);

ALTER TABLE "env_excursions" ADD CONSTRAINT "env_excursions_env_record_id_env_records_id_fk" FOREIGN KEY ("env_record_id") REFERENCES "public"."env_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "env_excursions" ADD CONSTRAINT "env_excursions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "env_excursions_env_record_id_idx" ON "env_excursions" USING btree ("env_record_id");
CREATE INDEX "env_excursions_opened_by_idx" ON "env_excursions" USING btree ("opened_by");

INSERT INTO "env_limits" ("id", "grade", "sample_type", "unit", "alert_limit", "action_limit", "source")
SELECT v.id, v.grade, v.sample_type, v.unit, NULL, v.action_limit,
       'EU GMP Annex 1 (2022) example maximum action limit for viable particles, as given in the roadmap; not site-approved'
FROM (VALUES
	('ENVLIM-A-AIR', 'Grade A', 'Air', 'CFU/m3', 0),
	('ENVLIM-A-SETTLE', 'Grade A', 'Settle plate', 'CFU/4 hours', 0),
	('ENVLIM-A-CONTACT', 'Grade A', 'Contact plate', 'CFU/plate', 0),
	('ENVLIM-A-GLOVE', 'Grade A', 'Glove print', 'CFU/glove', 0),
	('ENVLIM-B-AIR', 'Grade B', 'Air', 'CFU/m3', 10),
	('ENVLIM-B-SETTLE', 'Grade B', 'Settle plate', 'CFU/4 hours', 5),
	('ENVLIM-B-CONTACT', 'Grade B', 'Contact plate', 'CFU/plate', 5),
	('ENVLIM-B-GLOVE', 'Grade B', 'Glove print', 'CFU/glove', 5),
	('ENVLIM-C-AIR', 'Grade C', 'Air', 'CFU/m3', 100),
	('ENVLIM-C-SETTLE', 'Grade C', 'Settle plate', 'CFU/4 hours', 50),
	('ENVLIM-C-CONTACT', 'Grade C', 'Contact plate', 'CFU/plate', 25),
	('ENVLIM-D-AIR', 'Grade D', 'Air', 'CFU/m3', 200),
	('ENVLIM-D-SETTLE', 'Grade D', 'Settle plate', 'CFU/4 hours', 100),
	('ENVLIM-D-CONTACT', 'Grade D', 'Contact plate', 'CFU/plate', 50)
) AS v(id, grade, sample_type, unit, action_limit)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT 'VERIFICATION', 'Verification: I independently checked this record against its source and confirm that it is correct.', ARRAY['Reviewer','QA','Admin'], false, false
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
