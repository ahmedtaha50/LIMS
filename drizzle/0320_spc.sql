-- 0320_spc: statistical process control, out-of-trend alerts and stability shelf-life trending (roadmap M39, r3-spc).
--
-- What this adds, and why:
--   spc_baselines   the control limits of one attribute (product + parameter): individuals-chart centre line, MRbar, sigma, UCL, LCL,
--                   computed by the server from the approved results of a window, with the ids of the points used, every exclusion
--                   (named and justified) and a hash of the values, so the limits are reproducible. Versioned (revision); an Approved
--                   baseline is replaced by a new revision, never edited. Signed with SPC_BASELINE_APPROVAL.
--   spc_alerts      an out-of-trend finding: a rule of the baseline's rule set violated by an approved result entered after the
--                   baseline's data window. ADVISORY: it never changes a result, a specification or a disposition. Open, then
--                   Acknowledged by QA with a note. One alert per (baseline, result, rule).
--   signature_meanings  + SPC_BASELINE_APPROVAL (QA, Admin; a reason is required).
--   permissions     spc.view (every role) and spc.manage (QA, Admin: set a baseline, evaluate, acknowledge), positions 320 and 321.
--
-- The results, samples and stability tables are not altered. The constants are written only under the migration runner (WHERE EXISTS
-- schema_migrations), like 0240 and 0300, because a restore replays this file into an EMPTY database and then loads the backed-up rows.

CREATE TABLE "spc_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"baseline_id" text NOT NULL,
	"product_id" text NOT NULL,
	"parameter" text NOT NULL,
	"result_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"batch" text NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"value" double precision NOT NULL,
	"z" double precision NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"detected_by" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledgement" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "spc_alerts_status_check" CHECK ("spc_alerts"."status" IN ('Open', 'Acknowledged')),
	CONSTRAINT "spc_alerts_severity_check" CHECK ("spc_alerts"."severity" IN ('warning', 'violation'))
);

CREATE TABLE "spc_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"parameter" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'Approved' NOT NULL,
	"rule_set" text NOT NULL,
	"n" integer NOT NULL,
	"cl" double precision NOT NULL,
	"mr_bar" double precision NOT NULL,
	"sigma" double precision NOT NULL,
	"ucl" double precision NOT NULL,
	"lcl" double precision NOT NULL,
	"data_from" timestamp with time zone NOT NULL,
	"data_to" timestamp with time zone NOT NULL,
	"result_ids" jsonb NOT NULL,
	"exclusions" jsonb NOT NULL,
	"data_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "spc_baselines_status_check" CHECK ("spc_baselines"."status" IN ('Approved', 'Superseded')),
	CONSTRAINT "spc_baselines_rule_set_check" CHECK ("spc_baselines"."rule_set" IN ('nelson', 'westgard')),
	CONSTRAINT "spc_baselines_n_check" CHECK ("spc_baselines"."n" >= 2),
	CONSTRAINT "spc_baselines_reason_check" CHECK (length(btrim("spc_baselines"."reason")) >= 5)
);

ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_baseline_id_spc_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."spc_baselines"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_detected_by_users_id_fk" FOREIGN KEY ("detected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_alerts" ADD CONSTRAINT "spc_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_baselines" ADD CONSTRAINT "spc_baselines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spc_baselines" ADD CONSTRAINT "spc_baselines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "spc_alerts_finding_uidx" ON "spc_alerts" USING btree ("baseline_id","result_id","rule");
CREATE INDEX "spc_alerts_status_idx" ON "spc_alerts" USING btree ("status","detected_at");
CREATE INDEX "spc_alerts_product_id_idx" ON "spc_alerts" USING btree ("product_id");
CREATE INDEX "spc_alerts_result_id_idx" ON "spc_alerts" USING btree ("result_id");
CREATE INDEX "spc_alerts_sample_id_idx" ON "spc_alerts" USING btree ("sample_id");
CREATE INDEX "spc_alerts_detected_by_idx" ON "spc_alerts" USING btree ("detected_by");
CREATE INDEX "spc_alerts_acknowledged_by_idx" ON "spc_alerts" USING btree ("acknowledged_by");
CREATE UNIQUE INDEX "spc_baselines_revision_uidx" ON "spc_baselines" USING btree ("product_id","parameter","revision");
CREATE UNIQUE INDEX "spc_baselines_one_approved_uidx" ON "spc_baselines" USING btree ("product_id","parameter") WHERE "spc_baselines"."status" = 'Approved';
CREATE INDEX "spc_baselines_created_by_idx" ON "spc_baselines" USING btree ("created_by");

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('SPC_BASELINE_APPROVAL', 'Control limit baseline approval: I have reviewed the data, the exclusions and the computed limits, and approve them as the reference for trending this attribute.', ARRAY['QA', 'Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('spc.view', 'Trending', 'Read control charts, baselines, out-of-trend alerts and shelf-life estimates', 320),
	('spc.manage', 'Trending', 'Set a control-limit baseline (e-signed), evaluate and acknowledge out-of-trend alerts', 321)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'spc.view'), ('role-admin', 'spc.manage'),
	('role-qa', 'spc.view'), ('role-qa', 'spc.manage'),
	('role-reviewer', 'spc.view'),
	('role-analyst', 'spc.view')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
