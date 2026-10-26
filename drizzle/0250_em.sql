-- 0250_em: the environmental monitoring programme (roadmap M32, r2-em; EU GMP Annex 1 (2022) sections 9.1-9.37, 21 CFR 211.113(b)).
--
-- What this adds, and why:
--   em_sampling_points   the site map of sampling points (room, grade), replacing free-text locations. QA maintains it (env.manage).
--   em_limit_profiles    alert and action limits per grade, method (viable or total particles) and occupancy state, with the ISO class
--                        for particles and the source each limit is taken from. Master data: Draft, then Approved by an e-signature
--                        (EM_LIMIT_APPROVAL) of someone who did not write it, then Retired when a newer approval supersedes it. Only an
--                        Approved profile judges a result (one per key: partial unique index).
--   em_results           each reading at a point, with media lot and incubation for viable methods and the organism once identified.
--                        Status, unit, grade, room and the limits used are written by the server. A count is corrected only by QA.
--   em_excursions        one per action-level result, opened in the result's transaction together with its deviation (M27 automatic
--                        opening, source em-excursion). Append-only.
--   em_batch_rooms       the room and the date window in which a batch was exposed: the batch impact of a result and the EM section
--                        of the batch dossier are read from it.
--   em_trend_flags       adverse trends found by the scheduled evaluation (3 consecutive alert-level results, 2 action-level results
--                        within 30 days, a recurring organism); one row per finding (dedupe_key), acknowledged by QA.
--   signature_meanings   EM_LIMIT_APPROVAL (QA and Admin).
--   permissions          env.manage and env.correct, granted to QA and Admin (positions 250, 251).
--   em_limit_profiles    DRAFTS only: a copy of every active env_limits row (the 0070 example viable limits, or what the site made of
--                        them), and the example total-particle limits. None of them judges anything until QA approves it.
--
-- The legacy env_records, env_limits and env_excursions tables (0070) are left as they are: the records they hold stay readable.
-- The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040, 0180 and 0210, because a
-- restore replays this file into an EMPTY database.

CREATE TABLE "em_batch_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"product_batch_id" text NOT NULL,
	"room" text NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "em_batch_rooms_window_check" CHECK ("em_batch_rooms"."from_date" <= "em_batch_rooms"."to_date")
);

CREATE TABLE "em_excursions" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"point_id" text NOT NULL,
	"room" text NOT NULL,
	"level" text NOT NULL,
	"count" integer NOT NULL,
	"limit_value" integer NOT NULL,
	"qms_record_id" text NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "em_excursions_result_id_unique" UNIQUE("result_id")
);

CREATE TABLE "em_limit_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"grade" text NOT NULL,
	"method" text NOT NULL,
	"occupancy" text NOT NULL,
	"iso_class" text,
	"unit" text NOT NULL,
	"alert_limit" integer,
	"action_limit" integer NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"origin" text DEFAULT 'entry' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"superseded_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "em_limit_profiles_status_check" CHECK ("em_limit_profiles"."status" IN ('Draft', 'Approved', 'Retired')),
	CONSTRAINT "em_limit_profiles_occupancy_check" CHECK ("em_limit_profiles"."occupancy" IN ('In operation', 'At rest')),
	CONSTRAINT "em_limit_profiles_limits_check" CHECK ("em_limit_profiles"."action_limit" >= 0 AND ("em_limit_profiles"."alert_limit" IS NULL OR ("em_limit_profiles"."alert_limit" >= 0 AND "em_limit_profiles"."alert_limit" <= "em_limit_profiles"."action_limit")))
);

CREATE TABLE "em_results" (
	"id" text PRIMARY KEY NOT NULL,
	"point_id" text NOT NULL,
	"room" text NOT NULL,
	"grade" text NOT NULL,
	"method" text NOT NULL,
	"occupancy" text NOT NULL,
	"sampled_on" text NOT NULL,
	"count" integer NOT NULL,
	"unit" text NOT NULL,
	"media_lot" text,
	"incubation_started_at" timestamp with time zone,
	"incubation_ended_at" timestamp with time zone,
	"incubation_conditions" text,
	"organism" text,
	"identified_by" text,
	"identified_at" timestamp with time zone,
	"status" text NOT NULL,
	"limit_profile_id" text NOT NULL,
	"limit_alert" integer,
	"limit_action" integer NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "em_results_status_check" CHECK ("em_results"."status" IN ('Pass', 'Alert', 'Action')),
	CONSTRAINT "em_results_count_check" CHECK ("em_results"."count" >= 0)
);

CREATE TABLE "em_sampling_points" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"room" text NOT NULL,
	"description" text NOT NULL,
	"grade" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "em_sampling_points_status_check" CHECK ("em_sampling_points"."status" IN ('Active', 'Retired')),
	CONSTRAINT "em_sampling_points_grade_check" CHECK ("em_sampling_points"."grade" IN ('Grade A', 'Grade B', 'Grade C', 'Grade D'))
);

CREATE TABLE "em_trend_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"rule" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"point_id" text NOT NULL,
	"room" text NOT NULL,
	"organism" text,
	"result_ids" jsonb NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"detected_by" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledgement" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "em_trend_flags_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "em_trend_flags_rule_check" CHECK ("em_trend_flags"."rule" IN ('CONSECUTIVE_ALERTS', 'REPEATED_ACTIONS', 'RECURRING_ORGANISM')),
	CONSTRAINT "em_trend_flags_status_check" CHECK ("em_trend_flags"."status" IN ('Open', 'Acknowledged'))
);

ALTER TABLE "em_batch_rooms" ADD CONSTRAINT "em_batch_rooms_product_batch_id_product_batches_id_fk" FOREIGN KEY ("product_batch_id") REFERENCES "public"."product_batches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_batch_rooms" ADD CONSTRAINT "em_batch_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_excursions" ADD CONSTRAINT "em_excursions_result_id_em_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."em_results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_excursions" ADD CONSTRAINT "em_excursions_point_id_em_sampling_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."em_sampling_points"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_excursions" ADD CONSTRAINT "em_excursions_qms_record_id_qms_records_id_fk" FOREIGN KEY ("qms_record_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_excursions" ADD CONSTRAINT "em_excursions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_limit_profiles" ADD CONSTRAINT "em_limit_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_limit_profiles" ADD CONSTRAINT "em_limit_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_results" ADD CONSTRAINT "em_results_point_id_em_sampling_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."em_sampling_points"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_results" ADD CONSTRAINT "em_results_identified_by_users_id_fk" FOREIGN KEY ("identified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_results" ADD CONSTRAINT "em_results_limit_profile_id_em_limit_profiles_id_fk" FOREIGN KEY ("limit_profile_id") REFERENCES "public"."em_limit_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_results" ADD CONSTRAINT "em_results_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_sampling_points" ADD CONSTRAINT "em_sampling_points_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_trend_flags" ADD CONSTRAINT "em_trend_flags_point_id_em_sampling_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."em_sampling_points"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_trend_flags" ADD CONSTRAINT "em_trend_flags_detected_by_users_id_fk" FOREIGN KEY ("detected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "em_trend_flags" ADD CONSTRAINT "em_trend_flags_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "em_batch_rooms_product_batch_id_idx" ON "em_batch_rooms" USING btree ("product_batch_id");
CREATE INDEX "em_batch_rooms_room_idx" ON "em_batch_rooms" USING btree ("room","from_date");
CREATE INDEX "em_batch_rooms_created_by_idx" ON "em_batch_rooms" USING btree ("created_by");
CREATE INDEX "em_excursions_point_id_idx" ON "em_excursions" USING btree ("point_id");
CREATE INDEX "em_excursions_room_idx" ON "em_excursions" USING btree ("room");
CREATE INDEX "em_excursions_qms_record_id_idx" ON "em_excursions" USING btree ("qms_record_id");
CREATE INDEX "em_excursions_opened_by_idx" ON "em_excursions" USING btree ("opened_by");
CREATE UNIQUE INDEX "em_limit_profiles_approved_uidx" ON "em_limit_profiles" USING btree ("grade","method","occupancy") WHERE "em_limit_profiles"."status" = 'Approved';
CREATE INDEX "em_limit_profiles_created_by_idx" ON "em_limit_profiles" USING btree ("created_by");
CREATE INDEX "em_limit_profiles_approved_by_idx" ON "em_limit_profiles" USING btree ("approved_by");
CREATE INDEX "em_results_point_sampled_idx" ON "em_results" USING btree ("point_id","sampled_on");
CREATE INDEX "em_results_room_sampled_idx" ON "em_results" USING btree ("room","sampled_on");
CREATE INDEX "em_results_limit_profile_id_idx" ON "em_results" USING btree ("limit_profile_id");
CREATE INDEX "em_results_identified_by_idx" ON "em_results" USING btree ("identified_by");
CREATE INDEX "em_results_recorded_by_idx" ON "em_results" USING btree ("recorded_by");
CREATE UNIQUE INDEX "em_sampling_points_code_lower_uidx" ON "em_sampling_points" USING btree (lower("code"));
CREATE INDEX "em_sampling_points_room_idx" ON "em_sampling_points" USING btree ("room");
CREATE INDEX "em_sampling_points_created_by_idx" ON "em_sampling_points" USING btree ("created_by");
CREATE INDEX "em_trend_flags_point_id_idx" ON "em_trend_flags" USING btree ("point_id");
CREATE INDEX "em_trend_flags_status_idx" ON "em_trend_flags" USING btree ("status");
CREATE INDEX "em_trend_flags_detected_by_idx" ON "em_trend_flags" USING btree ("detected_by");
CREATE INDEX "em_trend_flags_acknowledged_by_idx" ON "em_trend_flags" USING btree ("acknowledged_by");

-- ---- excursions are append-only (the same statements as src/server/em/protections.ts) ------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_em_excursions_row_guard BEFORE UPDATE OR DELETE ON em_excursions FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_em_excursions_truncate_guard BEFORE TRUNCATE ON em_excursions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('EM_LIMIT_APPROVAL', 'Approval of environmental monitoring limits: I have checked these alert and action limits against their cited source and approve them for judging the results of this site.', ARRAY['QA','Admin'], false, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('env.manage', 'Environmental', 'Maintain sampling points, batch room windows and limit profiles (approval with an e-signature); acknowledge adverse trends', 250),
	('env.correct', 'Environmental', 'Correct a recorded environmental monitoring result, with a reason', 251)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'env.manage'),
	('role-admin', 'env.correct'),
	('role-qa', 'env.manage'),
	('role-qa', 'env.correct')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

-- Drafts from the viable limits the site already has (0070), in operation. QA reviews and approves each one before it is used.
INSERT INTO "em_limit_profiles" ("id", "grade", "method", "occupancy", "iso_class", "unit", "alert_limit", "action_limit", "source", "status", "origin")
SELECT 'EML-' || l."id", l."grade", l."sample_type", 'In operation', NULL, l."unit", l."alert_limit", l."action_limit",
       l."source" || ' (copied from env_limits ' || l."id" || ' by migration 0250; a draft until QA approves it)', 'Draft', 'migration'
FROM "env_limits" l
WHERE l."active" AND EXISTS (SELECT 1 FROM "schema_migrations");

-- Drafts of the total-particle limits (particles per m3, per particle size and occupancy state). Where Annex 1 gives no limit (Grade A and
-- B at 5.0 um, Grade D in operation) there is no draft: the site sets its own.
INSERT INTO "em_limit_profiles" ("id", "grade", "method", "occupancy", "iso_class", "unit", "alert_limit", "action_limit", "source", "status", "origin")
SELECT v."id", v."grade", v."method", v."occupancy", v."iso_class", 'particles/m3', NULL, v."action_limit",
       'EU GMP Annex 1 (2022) Table 5, maximum total particle concentration (ISO 14644-1 class limit); example value written by migration 0250, not site-approved: verify against the current text before approval',
       'Draft', 'migration'
FROM (VALUES
	('EML-PART-A-REST-05', 'Grade A', 'Particles 0.5 um', 'At rest', 'ISO 5', 3520),
	('EML-PART-A-OPER-05', 'Grade A', 'Particles 0.5 um', 'In operation', 'ISO 5', 3520),
	('EML-PART-B-REST-05', 'Grade B', 'Particles 0.5 um', 'At rest', 'ISO 5', 3520),
	('EML-PART-B-OPER-05', 'Grade B', 'Particles 0.5 um', 'In operation', 'ISO 7', 352000),
	('EML-PART-B-OPER-50', 'Grade B', 'Particles 5.0 um', 'In operation', 'ISO 7', 2930),
	('EML-PART-C-REST-05', 'Grade C', 'Particles 0.5 um', 'At rest', 'ISO 7', 352000),
	('EML-PART-C-REST-50', 'Grade C', 'Particles 5.0 um', 'At rest', 'ISO 7', 2930),
	('EML-PART-C-OPER-05', 'Grade C', 'Particles 0.5 um', 'In operation', 'ISO 8', 3520000),
	('EML-PART-C-OPER-50', 'Grade C', 'Particles 5.0 um', 'In operation', 'ISO 8', 29300),
	('EML-PART-D-REST-05', 'Grade D', 'Particles 0.5 um', 'At rest', 'ISO 8', 3520000),
	('EML-PART-D-REST-50', 'Grade D', 'Particles 5.0 um', 'At rest', 'ISO 8', 29300)
) AS v("id", "grade", "method", "occupancy", "iso_class", "action_limit")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
