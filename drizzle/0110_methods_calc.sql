-- 0110_methods_calc: methods, calculation formulas, test plans, normalised specification parameters, calculated results and system
-- suitability runs (roadmap M18, r2-methods-calc).
--
-- What this adds, and why:
--   methods, calc_formulas, test_plans   version-controlled configuration (GAMP 5 category 5): Draft -> Effective by an independent
--                                        e-signature, a new revision supersedes the Effective one. Before, a result was one typed
--                                        value with no method behind it and no server code calculated anything.
--   spec_parameters                      one row per parameter of a specification (the limit and its binding to a method, a formula,
--                                        replicates and a stage), DERIVED from specifications.parameters: the trigger below rebuilds a
--                                        specification's rows whenever its JSONB is written. The JSONB stays as it is: it is what the
--                                        specification signatures cover, and it is the rollback copy. Direct writes are refused.
--   result_inputs, sst_runs              the raw inputs and the formula revision of every calculated result, and every system
--                                        suitability run with what it invalidated. Append-only (triggers below and the protection
--                                        registry, src/db/protections/methods.ts).
--   signature_meanings + METHOD_APPROVAL, FORMULA_APPROVAL, TEST_PLAN_APPROVAL.
--   permissions + method.view, method.manage, method.approve and their grants (src/lib/permissions.ts, positions 62 to 64).
--
-- Backfill: spec_parameters for every existing specification, read exactly as the application reads the JSONB (normalizeParameters
-- in src/lib/validations/specifications.ts): the R1 shape {name, unit, limit_kind, lower, upper, decimals, text}, the v0.1.0 shape
-- {name, min, max, unit?} (RANGE, NLT, NMT or TEXT by which limits are present; decimals unknown), and anything else as an empty
-- TEXT parameter. Numbers are copied as the JSONB holds them (numeric, no rounding). specifications, results, samples, audit_trail
-- and signatures are not changed. A restore replays this file into an EMPTY database: the backfill then selects nothing, and the
-- catalog rows are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040, 0070 and 0100.

CREATE TABLE "methods" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"instrument_type" text,
	"required_training_module" text,
	"sst_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "methods_status_check" CHECK ("methods"."status" IN ('Draft', 'Effective', 'Superseded'))
);

CREATE TABLE "test_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"material" text NOT NULL,
	"purpose" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "test_plans_status_check" CHECK ("test_plans"."status" IN ('Draft', 'Effective', 'Superseded'))
);

CREATE TABLE "spec_parameters" (
	"id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"limit_kind" text NOT NULL,
	"lower" numeric,
	"upper" numeric,
	"decimals" integer,
	"text" text,
	"method_code" text,
	"formula_code" text,
	"replicates" integer,
	"stage" text
);

CREATE TABLE "calc_formulas" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"unit" text,
	"test_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "calc_formulas_status_check" CHECK ("calc_formulas"."status" IN ('Draft', 'Effective', 'Superseded'))
);

CREATE TABLE "result_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"result_version" integer NOT NULL,
	"formula_id" text NOT NULL,
	"formula_revision" integer NOT NULL,
	"expression" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"raw_value" text NOT NULL,
	"reported_value" text NOT NULL,
	"decimals" integer,
	"instrument_id" text,
	"entered_by" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sst_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"method_id" text NOT NULL,
	"method_code" text NOT NULL,
	"method_revision" integer NOT NULL,
	"outcomes" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"invalidated" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"instrument_id" text,
	"performed_by" text NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "methods" ADD CONSTRAINT "methods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "methods" ADD CONSTRAINT "methods_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "spec_parameters" ADD CONSTRAINT "spec_parameters_spec_id_specifications_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specifications"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "calc_formulas" ADD CONSTRAINT "calc_formulas_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "calc_formulas" ADD CONSTRAINT "calc_formulas_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_inputs" ADD CONSTRAINT "result_inputs_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_inputs" ADD CONSTRAINT "result_inputs_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_inputs" ADD CONSTRAINT "result_inputs_formula_id_calc_formulas_id_fk" FOREIGN KEY ("formula_id") REFERENCES "public"."calc_formulas"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_inputs" ADD CONSTRAINT "result_inputs_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_inputs" ADD CONSTRAINT "result_inputs_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sst_runs" ADD CONSTRAINT "sst_runs_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sst_runs" ADD CONSTRAINT "sst_runs_method_id_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."methods"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sst_runs" ADD CONSTRAINT "sst_runs_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sst_runs" ADD CONSTRAINT "sst_runs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "methods_code_revision_uidx" ON "methods" USING btree ("code","revision");
CREATE UNIQUE INDEX "methods_one_draft_uidx" ON "methods" USING btree (lower("code")) WHERE "methods"."status" = 'Draft';
CREATE UNIQUE INDEX "methods_one_effective_uidx" ON "methods" USING btree (lower("code")) WHERE "methods"."status" = 'Effective';
CREATE INDEX "methods_created_by_idx" ON "methods" USING btree ("created_by");
CREATE INDEX "methods_approved_by_idx" ON "methods" USING btree ("approved_by");
CREATE UNIQUE INDEX "test_plans_code_revision_uidx" ON "test_plans" USING btree ("code","revision");
CREATE UNIQUE INDEX "test_plans_one_draft_uidx" ON "test_plans" USING btree (lower("code")) WHERE "test_plans"."status" = 'Draft';
CREATE UNIQUE INDEX "test_plans_one_effective_uidx" ON "test_plans" USING btree (lower("code")) WHERE "test_plans"."status" = 'Effective';
CREATE INDEX "test_plans_material_idx" ON "test_plans" USING btree ("material");
CREATE INDEX "test_plans_created_by_idx" ON "test_plans" USING btree ("created_by");
CREATE INDEX "test_plans_approved_by_idx" ON "test_plans" USING btree ("approved_by");
CREATE UNIQUE INDEX "spec_parameters_spec_position_uidx" ON "spec_parameters" USING btree ("spec_id","position");
CREATE INDEX "spec_parameters_method_code_idx" ON "spec_parameters" USING btree ("method_code");
CREATE INDEX "spec_parameters_formula_code_idx" ON "spec_parameters" USING btree ("formula_code");
CREATE UNIQUE INDEX "calc_formulas_code_revision_uidx" ON "calc_formulas" USING btree ("code","revision");
CREATE UNIQUE INDEX "calc_formulas_one_draft_uidx" ON "calc_formulas" USING btree (lower("code")) WHERE "calc_formulas"."status" = 'Draft';
CREATE UNIQUE INDEX "calc_formulas_one_effective_uidx" ON "calc_formulas" USING btree (lower("code")) WHERE "calc_formulas"."status" = 'Effective';
CREATE INDEX "calc_formulas_created_by_idx" ON "calc_formulas" USING btree ("created_by");
CREATE INDEX "calc_formulas_approved_by_idx" ON "calc_formulas" USING btree ("approved_by");
CREATE UNIQUE INDEX "result_inputs_result_version_uidx" ON "result_inputs" USING btree ("result_id","result_version");
CREATE INDEX "result_inputs_sample_id_idx" ON "result_inputs" USING btree ("sample_id");
CREATE INDEX "result_inputs_formula_id_idx" ON "result_inputs" USING btree ("formula_id");
CREATE INDEX "result_inputs_instrument_id_idx" ON "result_inputs" USING btree ("instrument_id");
CREATE INDEX "result_inputs_entered_by_idx" ON "result_inputs" USING btree ("entered_by");
CREATE INDEX "sst_runs_sample_id_idx" ON "sst_runs" USING btree ("sample_id");
CREATE INDEX "sst_runs_method_id_idx" ON "sst_runs" USING btree ("method_id");
CREATE INDEX "sst_runs_instrument_id_idx" ON "sst_runs" USING btree ("instrument_id");
CREATE INDEX "sst_runs_performed_by_idx" ON "sst_runs" USING btree ("performed_by");

-- ---- spec_parameters: derived from specifications.parameters -------------------------------------------------------------------

-- A JSON number as numeric, exactly as written; anything else NULL.
CREATE OR REPLACE FUNCTION lims_json_numeric(j jsonb) RETURNS numeric AS $$
	SELECT CASE WHEN jsonb_typeof(j) = 'number' THEN (j #>> '{}')::numeric END
$$ LANGUAGE sql IMMUTABLE;

-- A JSON whole number (1 and 1.0 alike) as integer; anything else NULL.
CREATE OR REPLACE FUNCTION lims_json_int(j jsonb) RETURNS integer AS $$
	SELECT CASE WHEN jsonb_typeof(j) = 'number' AND (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric)
		AND abs((j #>> '{}')::numeric) < 2147483648 THEN (j #>> '{}')::numeric::integer END
$$ LANGUAGE sql IMMUTABLE;

-- A non-empty JSON string; anything else NULL.
CREATE OR REPLACE FUNCTION lims_json_text(j jsonb) RETURNS text AS $$
	SELECT CASE WHEN jsonb_typeof(j) = 'string' AND (j #>> '{}') <> '' THEN j #>> '{}' END
$$ LANGUAGE sql IMMUTABLE;

-- The rows of one specification, read like normalizeParameters(): see the header.
CREATE OR REPLACE FUNCTION spec_parameters_rebuild(p_spec_id text, p_parameters jsonb) RETURNS void AS $$
BEGIN
	DELETE FROM "spec_parameters" WHERE "spec_id" = p_spec_id;
	IF jsonb_typeof(p_parameters) IS DISTINCT FROM 'array' THEN
		RETURN;
	END IF;
	INSERT INTO "spec_parameters" ("id", "spec_id", "position", "name", "unit", "limit_kind", "lower", "upper", "decimals", "text",
		"method_code", "formula_code", "replicates", "stage")
	SELECT p_spec_id || '#' || x.i, p_spec_id, x.i::integer,
		COALESCE(CASE WHEN jsonb_typeof(x.e->'name') = 'string' THEN x.e->>'name' END, ''),
		COALESCE(CASE WHEN jsonb_typeof(x.e->'unit') = 'string' THEN x.e->>'unit' END, ''),
		CASE WHEN x.known THEN x.e->>'limit_kind'
			WHEN lims_json_numeric(x.e->'min') IS NOT NULL AND lims_json_numeric(x.e->'max') IS NOT NULL THEN 'RANGE'
			WHEN lims_json_numeric(x.e->'min') IS NOT NULL THEN 'NLT'
			WHEN lims_json_numeric(x.e->'max') IS NOT NULL THEN 'NMT'
			ELSE 'TEXT' END,
		lims_json_numeric(CASE WHEN x.known THEN x.e->'lower' ELSE x.e->'min' END),
		lims_json_numeric(CASE WHEN x.known THEN x.e->'upper' ELSE x.e->'max' END),
		CASE WHEN x.known THEN lims_json_int(x.e->'decimals') END,
		CASE WHEN x.known THEN lims_json_text(x.e->'text') END,
		lims_json_text(x.e->'method_code'),
		lims_json_text(x.e->'formula_code'),
		lims_json_int(x.e->'replicates'),
		lims_json_text(x.e->'stage')
	FROM (
		SELECT a.e, a.i,
			jsonb_typeof(a.e->'limit_kind') = 'string' AND (a.e->>'limit_kind') IN ('RANGE', 'NMT', 'NLT', 'TEXT', 'PRESENCE') AS known
		FROM jsonb_array_elements(p_parameters) WITH ORDINALITY AS a(e, i)
	) AS x;
END;
$$ LANGUAGE plpgsql;

SELECT spec_parameters_rebuild("id", "parameters") FROM "specifications";

DO $$
DECLARE
	expected integer;
	got integer;
BEGIN
	SELECT COALESCE(sum(jsonb_array_length("parameters")), 0) INTO expected FROM "specifications" WHERE jsonb_typeof("parameters") = 'array';
	SELECT count(*) INTO got FROM "spec_parameters";
	IF expected <> got THEN
		RAISE EXCEPTION '0110_methods_calc: % specification parameter(s) in the JSONB but % row(s) in spec_parameters; nothing was changed', expected, got;
	END IF;
END $$;

-- Rebuilt in the statement that writes the JSONB (so in its transaction).
CREATE OR REPLACE FUNCTION spec_parameters_sync() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' OR NEW."parameters" IS DISTINCT FROM OLD."parameters" THEN
		PERFORM spec_parameters_rebuild(NEW."id", NEW."parameters");
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER spec_parameters_sync AFTER INSERT OR UPDATE OF "parameters" ON "specifications" FOR EACH ROW EXECUTE FUNCTION spec_parameters_sync();

-- Only the rebuild (a statement issued from a trigger: pg_trigger_depth() > 1) and the cascade of a deleted specification write
-- these rows. A direct INSERT of a row that is already there, identical, is skipped: that is a restore, which loads the
-- specifications (and so rebuilds their rows) before it loads this table. Every other direct write is refused.
CREATE OR REPLACE FUNCTION spec_parameters_guard() RETURNS trigger AS $$
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	END IF;
	IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM "spec_parameters" p WHERE p."id" = NEW."id"
		AND (p.*)::text = (NEW.*)::text) THEN
		RETURN NULL;
	END IF;
	RAISE EXCEPTION 'GxP: % on spec_parameters is not permitted: the rows are derived from specifications.parameters, and the parameters of a specification change only while it is a Draft (PUT /specifications/:id)', TG_OP
		USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER spec_parameters_guard BEFORE INSERT OR UPDATE OR DELETE ON "spec_parameters" FOR EACH ROW EXECUTE FUNCTION spec_parameters_guard();
CREATE TRIGGER spec_parameters_truncate_guard BEFORE TRUNCATE ON "spec_parameters" FOR EACH STATEMENT EXECUTE FUNCTION spec_parameters_guard();

-- ---- the run records are append-only -------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_result_inputs_row_guard BEFORE UPDATE OR DELETE ON result_inputs FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_result_inputs_truncate_guard BEFORE TRUNCATE ON result_inputs FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_sst_runs_row_guard BEFORE UPDATE OR DELETE ON sst_runs FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_sst_runs_truncate_guard BEFORE TRUNCATE ON sst_runs FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- catalog rows (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('METHOD_APPROVAL', 'Method approval: I have reviewed this revision of the analytical method and approve it for GMP testing.', ARRAY['QA','Admin'], false, false),
	('FORMULA_APPROVAL', 'Calculation approval: I have reviewed this revision of the calculation and its test cases and approve it for GMP results.', ARRAY['QA','Admin'], false, false),
	('TEST_PLAN_APPROVAL', 'Test plan approval: I have reviewed this revision of the test plan and approve it for use.', ARRAY['QA','Admin'], false, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('method.view', 'Methods', 'Read methods, calculation formulas, test plans and system suitability runs', 62),
	('method.manage', 'Methods', 'Draft and edit methods, calculation formulas and test plans', 63),
	('method.approve', 'Methods', 'Approve a method, a calculation formula or a test plan for use (never the author)', 64)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'method.view'),
	('role-admin', 'method.manage'),
	('role-admin', 'method.approve'),
	('role-qa', 'method.view'),
	('role-qa', 'method.manage'),
	('role-qa', 'method.approve'),
	('role-reviewer', 'method.view'),
	('role-reviewer', 'method.manage'),
	('role-analyst', 'method.view')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
