-- 0240_stability: the stability programme (roadmap M31, r2-stability; ICH Q1A(R2) "Stability testing of new drug substances and
-- products", 21 CFR 211.166).
--
-- What this adds, and why:
--   stability_conditions    the storage condition master: set points and tolerances of temperature and relative humidity, and the role
--                           of the condition in a study (Long-term, Intermediate, Accelerated, Stress, Other). Editable configuration;
--                           seven conditions of ICH Q1A(R2) section 2.2.7 are installed (origin 'installed').
--   stability_chambers      the chambers, each holding one condition.
--   stability_protocols     the controlled protocol (product, test plan code, conditions as a snapshot, month points, pull window in
--                           days). Draft, then Approved with STABILITY_PROTOCOL_APPROVAL by someone other than the author; a change of
--                           an Approved protocol is a new revision, signed again; the earlier revision becomes Superseded.
--   stability_study_links   1:1 sidecar of stability_studies: the protocol revision, product and batch the study was started from. The
--                           columns of stability_studies are not changed, so a study written before 0240 reads back unchanged (it has
--                           no row here and stays a legacy study).
--   stability_timepoints    one per (study, condition, month point) with the due date and the pull window, the chamber, the state
--                           (Scheduled, Due, Pulled, InTesting, Complete, Missed), the pull sample, and the deviation of a missed pull.
--   signature_meanings      STABILITY_PROTOCOL_APPROVAL (QA and Admin).
--   permissions             stability.manage (draft protocols, conditions and chambers; QA, Reviewer, Admin) and stability.approve
--                           (sign a protocol; QA, Admin), positions 240 and 241.
--
-- Nothing existing is rewritten. The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020,
-- 0040, 0180 and 0210, because a restore replays this file into an EMPTY database and then loads the backed-up rows.

CREATE TABLE "stability_chambers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"condition_id" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stability_chambers_status_check" CHECK ("stability_chambers"."status" IN ('Active', 'Inactive', 'Out of Service'))
);

CREATE TABLE "stability_conditions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"temperature_c" numeric NOT NULL,
	"temperature_tolerance_c" numeric NOT NULL,
	"humidity_rh" numeric,
	"humidity_tolerance_rh" numeric,
	"status" text DEFAULT 'Active' NOT NULL,
	"origin" text DEFAULT 'entry' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stability_conditions_category_check" CHECK ("stability_conditions"."category" IN ('Long-term', 'Intermediate', 'Accelerated', 'Stress', 'Other')),
	CONSTRAINT "stability_conditions_status_check" CHECK ("stability_conditions"."status" IN ('Active', 'Inactive')),
	CONSTRAINT "stability_conditions_humidity_check" CHECK (("stability_conditions"."humidity_rh" IS NULL) = ("stability_conditions"."humidity_tolerance_rh" IS NULL)),
	CONSTRAINT "stability_conditions_tolerance_check" CHECK ("stability_conditions"."temperature_tolerance_c" >= 0 AND ("stability_conditions"."humidity_tolerance_rh" IS NULL OR "stability_conditions"."humidity_tolerance_rh" >= 0))
);

CREATE TABLE "stability_protocols" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"product_id" text NOT NULL,
	"test_plan_code" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"month_points" jsonb NOT NULL,
	"window_days" integer NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stability_protocols_status_check" CHECK ("stability_protocols"."status" IN ('Draft', 'Approved', 'Superseded')),
	CONSTRAINT "stability_protocols_window_check" CHECK ("stability_protocols"."window_days" BETWEEN 0 AND 60)
);

CREATE TABLE "stability_study_links" (
	"study_id" text PRIMARY KEY NOT NULL,
	"protocol_id" text NOT NULL,
	"product_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "stability_timepoints" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"condition_code" text NOT NULL,
	"chamber_id" text,
	"month" integer NOT NULL,
	"due_date" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"status" text DEFAULT 'Scheduled' NOT NULL,
	"sample_id" text,
	"pulled_by" text,
	"pulled_at" timestamp with time zone,
	"missed_at" timestamp with time zone,
	"deviation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stability_timepoints_status_check" CHECK ("stability_timepoints"."status" IN ('Scheduled', 'Due', 'Pulled', 'InTesting', 'Complete', 'Missed')),
	CONSTRAINT "stability_timepoints_window_check" CHECK ("stability_timepoints"."window_start" <= "stability_timepoints"."due_date" AND "stability_timepoints"."due_date" <= "stability_timepoints"."window_end"),
	CONSTRAINT "stability_timepoints_month_check" CHECK ("stability_timepoints"."month" BETWEEN 0 AND 120)
);

ALTER TABLE "stability_chambers" ADD CONSTRAINT "stability_chambers_condition_id_stability_conditions_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."stability_conditions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_chambers" ADD CONSTRAINT "stability_chambers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_conditions" ADD CONSTRAINT "stability_conditions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_protocols" ADD CONSTRAINT "stability_protocols_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_protocols" ADD CONSTRAINT "stability_protocols_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_protocols" ADD CONSTRAINT "stability_protocols_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_study_links" ADD CONSTRAINT "stability_study_links_study_id_stability_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."stability_studies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_study_links" ADD CONSTRAINT "stability_study_links_protocol_id_stability_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."stability_protocols"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_study_links" ADD CONSTRAINT "stability_study_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_study_links" ADD CONSTRAINT "stability_study_links_batch_id_product_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."product_batches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_study_links" ADD CONSTRAINT "stability_study_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_study_id_stability_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."stability_studies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_condition_id_stability_conditions_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."stability_conditions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_chamber_id_stability_chambers_id_fk" FOREIGN KEY ("chamber_id") REFERENCES "public"."stability_chambers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_pulled_by_users_id_fk" FOREIGN KEY ("pulled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stability_timepoints" ADD CONSTRAINT "stability_timepoints_deviation_id_qms_records_id_fk" FOREIGN KEY ("deviation_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "stability_chambers_code_uidx" ON "stability_chambers" USING btree (lower("code"));
CREATE INDEX "stability_chambers_condition_id_idx" ON "stability_chambers" USING btree ("condition_id");
CREATE INDEX "stability_chambers_created_by_idx" ON "stability_chambers" USING btree ("created_by");
CREATE UNIQUE INDEX "stability_conditions_code_uidx" ON "stability_conditions" USING btree (lower("code"));
CREATE INDEX "stability_conditions_created_by_idx" ON "stability_conditions" USING btree ("created_by");
CREATE UNIQUE INDEX "stability_protocols_code_revision_uidx" ON "stability_protocols" USING btree ("code","revision");
CREATE UNIQUE INDEX "stability_protocols_one_draft_uidx" ON "stability_protocols" USING btree (lower("code")) WHERE "stability_protocols"."status" = 'Draft';
CREATE UNIQUE INDEX "stability_protocols_one_approved_uidx" ON "stability_protocols" USING btree (lower("code")) WHERE "stability_protocols"."status" = 'Approved';
CREATE INDEX "stability_protocols_product_id_idx" ON "stability_protocols" USING btree ("product_id");
CREATE INDEX "stability_protocols_created_by_idx" ON "stability_protocols" USING btree ("created_by");
CREATE INDEX "stability_protocols_approved_by_idx" ON "stability_protocols" USING btree ("approved_by");
CREATE INDEX "stability_study_links_protocol_id_idx" ON "stability_study_links" USING btree ("protocol_id");
CREATE INDEX "stability_study_links_product_id_idx" ON "stability_study_links" USING btree ("product_id");
CREATE INDEX "stability_study_links_batch_id_idx" ON "stability_study_links" USING btree ("batch_id");
CREATE INDEX "stability_study_links_created_by_idx" ON "stability_study_links" USING btree ("created_by");
CREATE UNIQUE INDEX "stability_timepoints_point_uidx" ON "stability_timepoints" USING btree ("study_id","condition_id","month");
CREATE UNIQUE INDEX "stability_timepoints_sample_id_uidx" ON "stability_timepoints" USING btree ("sample_id");
CREATE INDEX "stability_timepoints_condition_id_idx" ON "stability_timepoints" USING btree ("condition_id");
CREATE INDEX "stability_timepoints_chamber_id_idx" ON "stability_timepoints" USING btree ("chamber_id");
CREATE INDEX "stability_timepoints_status_idx" ON "stability_timepoints" USING btree ("status","window_start");
CREATE INDEX "stability_timepoints_pulled_by_idx" ON "stability_timepoints" USING btree ("pulled_by");
CREATE INDEX "stability_timepoints_deviation_id_idx" ON "stability_timepoints" USING btree ("deviation_id");

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

-- ICH Q1A(R2) 2.2.7: general case (long term 25 C/60 % RH or 30 C/65 % RH, intermediate 30 C/65 % RH, accelerated 40 C/75 % RH),
-- products for a refrigerator (long term 5 C +/- 3 C, accelerated 25 C/60 % RH) and for a freezer (long term -20 C +/- 5 C).
INSERT INTO "stability_conditions" ("id", "code", "name", "category", "temperature_c", "temperature_tolerance_c", "humidity_rh", "humidity_tolerance_rh", "status", "origin")
SELECT v.* FROM (VALUES
	('STC-LT-25-60', 'LT-25-60', 'Long term 25 °C ± 2 °C / 60 % RH ± 5 % RH', 'Long-term', 25::numeric, 2::numeric, 60::numeric, 5::numeric, 'Active', 'installed'),
	('STC-LT-30-65', 'LT-30-65', 'Long term 30 °C ± 2 °C / 65 % RH ± 5 % RH', 'Long-term', 30, 2, 65, 5, 'Active', 'installed'),
	('STC-INT-30-65', 'INT-30-65', 'Intermediate 30 °C ± 2 °C / 65 % RH ± 5 % RH', 'Intermediate', 30, 2, 65, 5, 'Active', 'installed'),
	('STC-ACC-40-75', 'ACC-40-75', 'Accelerated 40 °C ± 2 °C / 75 % RH ± 5 % RH', 'Accelerated', 40, 2, 75, 5, 'Active', 'installed'),
	('STC-LT-5', 'LT-5', 'Long term (refrigerator) 5 °C ± 3 °C', 'Long-term', 5, 3, NULL, NULL, 'Active', 'installed'),
	('STC-ACC-25-60', 'ACC-25-60', 'Accelerated (refrigerated product) 25 °C ± 2 °C / 60 % RH ± 5 % RH', 'Accelerated', 25, 2, 60, 5, 'Active', 'installed'),
	('STC-LT-M20', 'LT-M20', 'Long term (freezer) -20 °C ± 5 °C', 'Long-term', -20, 5, NULL, NULL, 'Active', 'installed')
) AS v("id", "code", "name", "category", "temperature_c", "temperature_tolerance_c", "humidity_rh", "humidity_tolerance_rh", "status", "origin")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('STABILITY_PROTOCOL_APPROVAL', 'Stability protocol approval: I have reviewed this protocol revision (conditions, pull points, pull window and test plan) and I approve it for use.', ARRAY['QA','Admin'], false, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('stability.manage', 'Stability', 'Draft and revise stability protocols; maintain storage conditions and chambers', 240),
	('stability.approve', 'Stability', 'Approve a stability protocol revision with an e-signature', 241)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'stability.manage'),
	('role-admin', 'stability.approve'),
	('role-qa', 'stability.manage'),
	('role-qa', 'stability.approve'),
	('role-reviewer', 'stability.manage')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
