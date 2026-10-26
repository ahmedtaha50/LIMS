-- 0300_qualified_modules: the validated-scope register (roadmap M37, r2-validation).
--
-- What this adds, and why:
--   qualified_modules   one row per functional module whose scope QA has declared: 'Qualified' (its operational qualification is
--                       executed and accepted) or 'NotQualified' (writes to the module are refused with 403 MODULE_NOT_QUALIFIED).
--                       A module without a row is undeclared and behaves as before. No row is written here: a declaration is a
--                       decision of QA, made with an e-signature (meaning MODULE_QUALIFICATION), audited in the same transaction.
--   signature_meanings  + MODULE_QUALIFICATION (QA only).
--   permissions         + validation.view (every role) and validation.scope (QA, Admin).
-- The history of the flag is the audit trail and the signatures; the row holds only the current state.

CREATE TABLE "qualified_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_ref" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qualified_modules_status_check" CHECK ("qualified_modules"."status" IN ('Qualified', 'NotQualified')),
	CONSTRAINT "qualified_modules_reason_check" CHECK (length(btrim("qualified_modules"."reason")) >= 5)
);

ALTER TABLE "qualified_modules" ADD CONSTRAINT "qualified_modules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "qualified_modules_updated_by_idx" ON "qualified_modules" USING btree ("updated_by");

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('MODULE_QUALIFICATION', 'Module qualification decision: I have reviewed the qualification evidence of this module and declare whether it is qualified for GxP use.', ARRAY['QA'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('validation.view', 'Validation', 'Read the validated-scope register (which modules are qualified)', 300),
	('validation.scope', 'Validation', 'Declare a module Qualified or NotQualified with an e-signature', 301)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'validation.view'), ('role-admin', 'validation.scope'),
	('role-qa', 'validation.view'), ('role-qa', 'validation.scope'),
	('role-reviewer', 'validation.view'),
	('role-analyst', 'validation.view')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
