-- 0210_oos_workflow: the OOS investigation workflow (roadmap M26, r2-oos-workflow; FDA guidance "Investigating Out-of-Specification
-- (OOS) Test Results for Pharmaceutical Production", 21 CFR 211.192).
--
-- What this adds, and why:
--   oos_investigations (columns)  due_date (the due date of the current phase; null until it is first set, read as date_raised plus the
--                                 Phase I period), phase2_started_at, the assignable cause recorded by the investigator (category from
--                                 the coded OOS reasons, description, who and when) and its confirmation by QA, which invalidates the
--                                 original result (invalidated_by, invalidated_at; signed OOS_INVALIDATION). All nullable: no existing
--                                 row is rewritten.
--   oos_settings                  one row: the retest analyst must differ from the analyst of the original result (on), the largest
--                                 number of retests a plan may authorise (2), the Phase I and Phase II periods in calendar days (10, 30).
--                                 Changed only by an e-signature (OOS_SETTING_CHANGE).
--   oos_checklist_templates       the investigation checklists, versioned per code. Two are installed: OOS-PHASE-I (the laboratory
--                                 investigation) and OOS-PHASE-II (the full-scale investigation).
--   oos_tasks                     the tasks of an investigation (from a template or added by hand), each with owner, due date, status
--                                 and the finding that completes it. A template is applied once per investigation (partial unique index).
--   oos_retest_plans              the retest authorisation: one per investigation, signed by QA (OOS_RETEST_AUTHORISATION) before any
--                                 retest, with its basis (an assignable cause confirmed in Phase I, or the Phase II protocol), its
--                                 justification and the maximum number of retests. Append-only.
--   oos_retests                   each retest, numbered within its plan (unique), with its value and evaluation against the limit of the
--                                 original result, the analyst and the instrument. Append-only.
--   signature_meanings            OOS_INVALIDATION, OOS_RETEST_AUTHORISATION, OOS_SETTING_CHANGE (QA and Admin).
--   permissions                   oos.approve, oos.settings and their grants to QA and Admin (positions 210, 211).
--
-- The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040 and 0180, because a restore
-- replays this file into an EMPTY database.

ALTER TABLE "oos_investigations" ADD COLUMN "due_date" text;
ALTER TABLE "oos_investigations" ADD COLUMN "phase2_started_at" timestamp with time zone;
ALTER TABLE "oos_investigations" ADD COLUMN "assignable_cause_category" text;
ALTER TABLE "oos_investigations" ADD COLUMN "assignable_cause" text;
ALTER TABLE "oos_investigations" ADD COLUMN "assignable_cause_by" text;
ALTER TABLE "oos_investigations" ADD COLUMN "assignable_cause_at" timestamp with time zone;
ALTER TABLE "oos_investigations" ADD COLUMN "invalidated_by" text;
ALTER TABLE "oos_investigations" ADD COLUMN "invalidated_at" timestamp with time zone;
ALTER TABLE "oos_investigations" ADD CONSTRAINT "oos_investigations_assignable_cause_by_users_id_fk" FOREIGN KEY ("assignable_cause_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_investigations" ADD CONSTRAINT "oos_investigations_invalidated_by_users_id_fk" FOREIGN KEY ("invalidated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "oos_investigations_assignable_cause_by_idx" ON "oos_investigations" USING btree ("assignable_cause_by");
CREATE INDEX "oos_investigations_invalidated_by_idx" ON "oos_investigations" USING btree ("invalidated_by");

CREATE TABLE "oos_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"retest_analyst_must_differ" boolean DEFAULT true NOT NULL,
	"max_retests" integer DEFAULT 2 NOT NULL,
	"phase1_due_days" integer DEFAULT 10 NOT NULL,
	"phase2_due_days" integer DEFAULT 30 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "oos_settings_max_retests_check" CHECK ("oos_settings"."max_retests" BETWEEN 1 AND 10),
	CONSTRAINT "oos_settings_due_days_check" CHECK ("oos_settings"."phase1_due_days" BETWEEN 1 AND 365 AND "oos_settings"."phase2_due_days" BETWEEN 1 AND 365)
);

CREATE TABLE "oos_checklist_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"items" jsonb NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oos_checklist_templates_phase_check" CHECK ("oos_checklist_templates"."phase" IN ('Phase I', 'Phase II'))
);

CREATE TABLE "oos_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"oos_id" text NOT NULL,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"template_id" text,
	"item_key" text,
	"owner_id" text,
	"due_date" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"finding" text,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "oos_tasks_status_check" CHECK ("oos_tasks"."status" IN ('Open', 'Done', 'Not applicable')),
	CONSTRAINT "oos_tasks_phase_check" CHECK ("oos_tasks"."phase" IN ('Phase I', 'Phase II'))
);

CREATE TABLE "oos_retest_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"oos_id" text NOT NULL,
	"retest_of" text NOT NULL,
	"basis" text NOT NULL,
	"justification" text NOT NULL,
	"max_retests" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oos_retest_plans_oos_id_unique" UNIQUE("oos_id"),
	CONSTRAINT "oos_retest_plans_basis_check" CHECK ("oos_retest_plans"."basis" IN ('Assignable cause', 'Phase II protocol')),
	CONSTRAINT "oos_retest_plans_max_retests_check" CHECK ("oos_retest_plans"."max_retests" >= 1)
);

CREATE TABLE "oos_retests" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"oos_id" text NOT NULL,
	"retest_of" text NOT NULL,
	"seq" integer NOT NULL,
	"value" text NOT NULL,
	"is_oos" boolean NOT NULL,
	"analyst_id" text NOT NULL,
	"instrument_id" text,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "oos_settings" ADD CONSTRAINT "oos_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_checklist_templates" ADD CONSTRAINT "oos_checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_tasks" ADD CONSTRAINT "oos_tasks_oos_id_oos_investigations_id_fk" FOREIGN KEY ("oos_id") REFERENCES "public"."oos_investigations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_tasks" ADD CONSTRAINT "oos_tasks_template_id_oos_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."oos_checklist_templates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_tasks" ADD CONSTRAINT "oos_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_tasks" ADD CONSTRAINT "oos_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_tasks" ADD CONSTRAINT "oos_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retest_plans" ADD CONSTRAINT "oos_retest_plans_oos_id_oos_investigations_id_fk" FOREIGN KEY ("oos_id") REFERENCES "public"."oos_investigations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retest_plans" ADD CONSTRAINT "oos_retest_plans_retest_of_results_id_fk" FOREIGN KEY ("retest_of") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retest_plans" ADD CONSTRAINT "oos_retest_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retests" ADD CONSTRAINT "oos_retests_plan_id_oos_retest_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."oos_retest_plans"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retests" ADD CONSTRAINT "oos_retests_oos_id_oos_investigations_id_fk" FOREIGN KEY ("oos_id") REFERENCES "public"."oos_investigations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retests" ADD CONSTRAINT "oos_retests_retest_of_results_id_fk" FOREIGN KEY ("retest_of") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retests" ADD CONSTRAINT "oos_retests_analyst_id_users_id_fk" FOREIGN KEY ("analyst_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "oos_retests" ADD CONSTRAINT "oos_retests_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "oos_settings_updated_by_idx" ON "oos_settings" USING btree ("updated_by");
CREATE UNIQUE INDEX "oos_checklist_templates_code_version_uidx" ON "oos_checklist_templates" USING btree ("code","version");
CREATE INDEX "oos_checklist_templates_created_by_idx" ON "oos_checklist_templates" USING btree ("created_by");
CREATE INDEX "oos_tasks_oos_id_idx" ON "oos_tasks" USING btree ("oos_id");
CREATE UNIQUE INDEX "oos_tasks_template_item_uidx" ON "oos_tasks" USING btree ("oos_id","template_id","item_key") WHERE "oos_tasks"."template_id" IS NOT NULL;
CREATE INDEX "oos_tasks_template_id_idx" ON "oos_tasks" USING btree ("template_id");
CREATE INDEX "oos_tasks_owner_id_idx" ON "oos_tasks" USING btree ("owner_id");
CREATE INDEX "oos_tasks_completed_by_idx" ON "oos_tasks" USING btree ("completed_by");
CREATE INDEX "oos_tasks_created_by_idx" ON "oos_tasks" USING btree ("created_by");
CREATE INDEX "oos_retest_plans_retest_of_idx" ON "oos_retest_plans" USING btree ("retest_of");
CREATE INDEX "oos_retest_plans_approved_by_idx" ON "oos_retest_plans" USING btree ("approved_by");
CREATE UNIQUE INDEX "oos_retests_plan_seq_uidx" ON "oos_retests" USING btree ("plan_id","seq");
CREATE INDEX "oos_retests_oos_id_idx" ON "oos_retests" USING btree ("oos_id");
CREATE INDEX "oos_retests_retest_of_idx" ON "oos_retests" USING btree ("retest_of");
CREATE INDEX "oos_retests_analyst_id_idx" ON "oos_retests" USING btree ("analyst_id");
CREATE INDEX "oos_retests_instrument_id_idx" ON "oos_retests" USING btree ("instrument_id");

-- ---- retest plans and retests are append-only (the same statements as src/server/oos/protections.ts) ---------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_oos_retest_plans_row_guard BEFORE UPDATE OR DELETE ON oos_retest_plans FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_oos_retest_plans_truncate_guard BEFORE TRUNCATE ON oos_retest_plans FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_oos_retests_row_guard BEFORE UPDATE OR DELETE ON oos_retests FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_oos_retests_truncate_guard BEFORE TRUNCATE ON oos_retests FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "oos_settings" ("id", "retest_analyst_must_differ", "max_retests", "phase1_due_days", "phase2_due_days")
SELECT 'default', true, 2, 10, 30
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "oos_checklist_templates" ("id", "code", "phase", "title", "items", "version")
SELECT v.* FROM (VALUES
	('OOSCT-OOS-PHASE-I-1', 'OOS-PHASE-I', 'Phase I', 'Phase I laboratory investigation', '[
		{"key": "analyst-method", "text": "Interview the analyst: the method was understood and followed as written"},
		{"key": "calculations", "text": "Verify calculations, dilution factors and data transcription"},
		{"key": "instrument", "text": "Verify the instrument: calibration and maintenance status, system suitability of the run"},
		{"key": "standards-reagents", "text": "Verify reference standards, reagents and solutions: identity, preparation, expiry and storage"},
		{"key": "sample-prep", "text": "Verify sample identity, handling and preparation: weighing, dilution, glassware"},
		{"key": "raw-data", "text": "Review the raw data: chromatograms, integration and the audit trail of the run"},
		{"key": "retained-solutions", "text": "Examine retained test and standard solutions before they are discarded, where available"}
	]'::jsonb, 1),
	('OOSCT-OOS-PHASE-II-1', 'OOS-PHASE-II', 'Phase II', 'Phase II full-scale investigation', '[
		{"key": "batch-record", "text": "Review the batch production record and the manufacturing deviations of the batch"},
		{"key": "process", "text": "Review the process, equipment and environmental conditions during manufacture"},
		{"key": "materials", "text": "Review the raw materials and components used in the batch"},
		{"key": "history", "text": "Review the historical results and trends of the product"},
		{"key": "other-batches", "text": "Identify other batches and products that may be affected"},
		{"key": "impact", "text": "Write the product impact assessment and the proposed batch disposition"}
	]'::jsonb, 1)
) AS v("id", "code", "phase", "title", "items", "version")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('OOS_INVALIDATION', 'Invalidation of an OOS result: I have reviewed the laboratory investigation, I confirm the assignable cause and I invalidate the original result.', ARRAY['QA','Admin'], true, false),
	('OOS_RETEST_AUTHORISATION', 'Retest authorisation: I authorise the retests of this plan, their justification and their maximum number, before any retest is performed.', ARRAY['QA','Admin'], false, false),
	('OOS_SETTING_CHANGE', 'OOS workflow setting: I authorise this change to the retest and due-date rules of OOS investigations.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('oos.approve', 'OOS', 'Confirm an assignable cause (invalidate an OOS result) and authorise retests with an e-signature', 210),
	('oos.settings', 'OOS', 'Change the OOS retest and due-date rules with an e-signature; add checklist templates', 211)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'oos.approve'),
	('role-admin', 'oos.settings'),
	('role-qa', 'oos.approve'),
	('role-qa', 'oos.settings')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
