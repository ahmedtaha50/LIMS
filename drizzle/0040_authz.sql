-- 0040_authz: server-enforced permission matrix and role-change ledger (roadmap M09, 21 CFR Part 11.10(d)(g), EU GMP Annex 11 s.12.1).
--
-- What this adds, and why:
--   roles, permissions, role_permissions   the matrix: which permission codes a role holds. users.role (free text) names the role in
--                                          force; every API route is bound to one permission code (src/server/authz/routeTable.ts) and
--                                          a role the matrix does not know holds nothing. The rows installed below are the default
--                                          matrix of src/lib/permissions.ts: what the handlers enforced before, with one tightening
--                                          (approving a specification is Admin and QA).
--   sod_rules                              the independence rules (who counts as an author of a record), read from the audit trail.
--   user_roles                             the ledger of role changes: request, the two e-signatures with their meaning and the record
--                                          version each signer saw, and the decision. A role is granted or removed by two people.
--
-- Nothing here touches users, audit_trail or signatures, and no existing row changes.
--
-- The seed rows are written with WHERE EXISTS (SELECT 1 FROM schema_migrations). The migration runner has journaled the earlier
-- files by the time it executes this one, so a new installation or an upgrade installs them. A restore builds an empty database from
-- the same SQL with an EMPTY journal (src/server/boot/schemaSql.ts) and then loads the backup's own rows, which include these
-- tables: seeding there would collide with them (this is why 0002_counters seeds only from existing data). The matrix rows are
-- changed by a later migration, and tests/api/authz-matrix.test.ts fails when the catalog and the migrated tables disagree.

CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"position" integer NOT NULL
);

CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);

CREATE TABLE "role_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"permission_code" text NOT NULL
);

CREATE TABLE "sod_rules" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"entity" text NOT NULL,
	"author_actions" text[] NOT NULL
);

CREATE TABLE "user_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"previous_role" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_reason" text NOT NULL,
	"request_meaning" text NOT NULL,
	"request_record_version" integer NOT NULL,
	"request_signature_hash" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"decision_meaning" text,
	"decision_record_version" integer,
	"decision_signature_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "user_roles_status_check" CHECK ("user_roles"."status" IN ('Pending', 'Approved', 'Rejected', 'Cancelled'))
);

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "role_permissions_role_id_permission_code_idx" ON "role_permissions" USING btree ("role_id","permission_code");
CREATE INDEX "role_permissions_permission_code_idx" ON "role_permissions" USING btree ("permission_code");
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" USING btree ("user_id");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" USING btree ("role_id");
CREATE INDEX "user_roles_requested_at_idx" ON "user_roles" USING btree ("requested_at");
CREATE UNIQUE INDEX "user_roles_one_pending_per_user_idx" ON "user_roles" USING btree ("user_id") WHERE "user_roles"."status" = 'Pending';

-- Default matrix (scripts/authz/generate-seed.ts prints this block from src/lib/permissions.ts).
INSERT INTO "roles" ("id", "name", "description", "is_system", "requires_approval")
SELECT v.* FROM (VALUES
  ('role-admin', 'Admin', 'System administration: accounts, security policy, integrations, backup. Holds every permission.', true, true),
  ('role-qa', 'QA', 'Quality assurance: approvals, release, audit review, training certification.', true, true),
  ('role-reviewer', 'Reviewer', 'Independent review of analytical results.', true, false),
  ('role-analyst', 'Analyst', 'Bench work: registering samples, entering results, notebook and records.', true, false)
) AS v("id", "name", "description", "is_system", "requires_approval")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
  ('sample.view', 'Samples', 'Read samples, their results, signatures and notebook', 1),
  ('sample.register', 'Samples', 'Register a sample, or import several', 2),
  ('sample.transition', 'Samples', 'Move a sample through submit, review, approve or reject (the allowed roles of each step are enforced by the workflow)', 3),
  ('sample.notebook.add', 'Samples', 'Add a signed observation to a sample notebook', 4),
  ('result.enter', 'Samples', 'Enter or correct a result value', 5),
  ('oos.view', 'OOS', 'Read OOS investigations', 6),
  ('oos.open', 'OOS', 'Open an OOS investigation', 7),
  ('oos.edit', 'OOS', 'Edit an open OOS investigation (root cause, assignee)', 8),
  ('oos.close', 'OOS', 'Close an OOS investigation with an e-signature', 9),
  ('spec.view', 'Specifications', 'Read specifications', 10),
  ('spec.create', 'Specifications', 'Create a draft specification', 11),
  ('spec.edit', 'Specifications', 'Edit the parameters of a draft specification', 12),
  ('spec.approve', 'Specifications', 'Approve a specification for use (master data approval; never the author)', 13),
  ('trace.view', 'Batch records', 'Read batch traceability dossiers', 14),
  ('trace.dispense', 'Batch records', 'Record a dispensed raw material on a batch', 15),
  ('batch.release', 'Batch records', 'Authorise batch release with an e-signature', 16),
  ('record.verify', 'Batch records', 'Verify signatures and the audit chain of a record', 17),
  ('eln.view', 'Notebook', 'Read notebook worksheets and templates', 18),
  ('eln.create', 'Notebook', 'Create a worksheet or a template', 19),
  ('eln.edit', 'Notebook', 'Edit an unsigned worksheet', 20),
  ('eln.sign', 'Notebook', 'Sign and lock a worksheet', 21),
  ('instrument.view', 'Equipment', 'Read instruments', 22),
  ('instrument.register', 'Equipment', 'Register an instrument', 23),
  ('instrument.calibrate', 'Equipment', 'Record a calibration', 24),
  ('reagent.view', 'Equipment', 'Read reagents', 25),
  ('reagent.receive', 'Equipment', 'Receive a reagent into stock', 26),
  ('env.view', 'Environmental', 'Read environmental monitoring records', 27),
  ('env.record', 'Environmental', 'Record an environmental monitoring result', 28),
  ('env.edit', 'Environmental', 'Correct an environmental monitoring record', 29),
  ('stability.view', 'Stability', 'Read stability studies', 30),
  ('stability.create', 'Stability', 'Create a stability study', 31),
  ('stability.edit', 'Stability', 'Edit a stability study', 32),
  ('report.view', 'Reports', 'Read the dashboard, batch reports, trends and metrics', 33),
  ('report.generate', 'Reports', 'Generate a Certificate of Analysis and collect it', 34),
  ('training.view', 'Training', 'Read the training matrix', 35),
  ('training.certify', 'Training', 'Certify another user as trained in the software', 36),
  ('ai.use', 'AI', 'Use the AI assistance (off unless an Administrator enabled it)', 37),
  ('audit.view', 'Audit', 'Read the audit trail and its head', 38),
  ('audit.verify', 'Audit', 'Verify the audit chain', 39),
  ('audit.export', 'Audit', 'Export the audit trail', 40),
  ('audit.history.view', 'Audit', 'Read the change history of a record', 41),
  ('security.view', 'Audit', 'Read security events', 42),
  ('security.verify', 'Audit', 'Verify the security-event chain', 43),
  ('admin.users.view', 'Administration', 'List user accounts', 44),
  ('admin.users.manage', 'Administration', 'Create, deactivate and reset accounts', 45),
  ('admin.settings.view', 'Administration', 'Read the security policies', 46),
  ('admin.settings.manage', 'Administration', 'Change the security policies', 47),
  ('admin.integrations.view', 'Administration', 'Read the external integration settings', 48),
  ('admin.integrations.manage', 'Administration', 'Change the external integration settings', 49),
  ('admin.broadcast', 'Administration', 'Send a system-wide alert', 50),
  ('admin.activity.view', 'Administration', 'Read the usage heat-map', 51),
  ('admin.backup.run', 'Administration', 'Make, verify and drill backups', 52),
  ('admin.backup.view', 'Administration', 'Read the backup status', 53),
  ('admin.jobs.view', 'Administration', 'Read the job queue and the scheduler', 54),
  ('system.info.view', 'Administration', 'Read the version and schema information', 55),
  ('authz.view', 'Authorisation', 'Read the permission matrix and the role-change requests', 56),
  ('authz.role.request', 'Authorisation', 'Request a change of a user role (first signature)', 57),
  ('authz.role.approve', 'Authorisation', 'Approve or reject a requested role change (second, independent signature)', 58)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
  ('role-admin', 'sample.view'),
  ('role-admin', 'sample.register'),
  ('role-admin', 'sample.transition'),
  ('role-admin', 'sample.notebook.add'),
  ('role-admin', 'result.enter'),
  ('role-admin', 'oos.view'),
  ('role-admin', 'oos.open'),
  ('role-admin', 'oos.edit'),
  ('role-admin', 'oos.close'),
  ('role-admin', 'spec.view'),
  ('role-admin', 'spec.create'),
  ('role-admin', 'spec.edit'),
  ('role-admin', 'spec.approve'),
  ('role-admin', 'trace.view'),
  ('role-admin', 'trace.dispense'),
  ('role-admin', 'batch.release'),
  ('role-admin', 'record.verify'),
  ('role-admin', 'eln.view'),
  ('role-admin', 'eln.create'),
  ('role-admin', 'eln.edit'),
  ('role-admin', 'eln.sign'),
  ('role-admin', 'instrument.view'),
  ('role-admin', 'instrument.register'),
  ('role-admin', 'instrument.calibrate'),
  ('role-admin', 'reagent.view'),
  ('role-admin', 'reagent.receive'),
  ('role-admin', 'env.view'),
  ('role-admin', 'env.record'),
  ('role-admin', 'env.edit'),
  ('role-admin', 'stability.view'),
  ('role-admin', 'stability.create'),
  ('role-admin', 'stability.edit'),
  ('role-admin', 'report.view'),
  ('role-admin', 'report.generate'),
  ('role-admin', 'training.view'),
  ('role-admin', 'training.certify'),
  ('role-admin', 'ai.use'),
  ('role-admin', 'audit.view'),
  ('role-admin', 'audit.verify'),
  ('role-admin', 'audit.export'),
  ('role-admin', 'audit.history.view'),
  ('role-admin', 'security.view'),
  ('role-admin', 'security.verify'),
  ('role-admin', 'admin.users.view'),
  ('role-admin', 'admin.users.manage'),
  ('role-admin', 'admin.settings.view'),
  ('role-admin', 'admin.settings.manage'),
  ('role-admin', 'admin.integrations.view'),
  ('role-admin', 'admin.integrations.manage'),
  ('role-admin', 'admin.broadcast'),
  ('role-admin', 'admin.activity.view'),
  ('role-admin', 'admin.backup.run'),
  ('role-admin', 'admin.backup.view'),
  ('role-admin', 'admin.jobs.view'),
  ('role-admin', 'system.info.view'),
  ('role-admin', 'authz.view'),
  ('role-admin', 'authz.role.request'),
  ('role-admin', 'authz.role.approve'),
  ('role-qa', 'sample.view'),
  ('role-qa', 'sample.transition'),
  ('role-qa', 'sample.notebook.add'),
  ('role-qa', 'result.enter'),
  ('role-qa', 'oos.view'),
  ('role-qa', 'oos.open'),
  ('role-qa', 'oos.edit'),
  ('role-qa', 'spec.view'),
  ('role-qa', 'spec.create'),
  ('role-qa', 'spec.edit'),
  ('role-qa', 'trace.view'),
  ('role-qa', 'trace.dispense'),
  ('role-qa', 'record.verify'),
  ('role-qa', 'eln.view'),
  ('role-qa', 'eln.create'),
  ('role-qa', 'eln.edit'),
  ('role-qa', 'eln.sign'),
  ('role-qa', 'instrument.view'),
  ('role-qa', 'instrument.register'),
  ('role-qa', 'instrument.calibrate'),
  ('role-qa', 'reagent.view'),
  ('role-qa', 'reagent.receive'),
  ('role-qa', 'env.view'),
  ('role-qa', 'env.record'),
  ('role-qa', 'env.edit'),
  ('role-qa', 'stability.view'),
  ('role-qa', 'stability.create'),
  ('role-qa', 'stability.edit'),
  ('role-qa', 'report.view'),
  ('role-qa', 'report.generate'),
  ('role-qa', 'training.view'),
  ('role-qa', 'ai.use'),
  ('role-qa', 'system.info.view'),
  ('role-qa', 'oos.close'),
  ('role-qa', 'spec.approve'),
  ('role-qa', 'batch.release'),
  ('role-qa', 'training.certify'),
  ('role-qa', 'audit.view'),
  ('role-qa', 'audit.verify'),
  ('role-qa', 'audit.export'),
  ('role-qa', 'security.view'),
  ('role-qa', 'security.verify'),
  ('role-qa', 'admin.users.view'),
  ('role-qa', 'admin.backup.view'),
  ('role-qa', 'admin.jobs.view'),
  ('role-qa', 'authz.view'),
  ('role-qa', 'authz.role.approve'),
  ('role-qa', 'audit.history.view'),
  ('role-reviewer', 'sample.view'),
  ('role-reviewer', 'sample.transition'),
  ('role-reviewer', 'sample.notebook.add'),
  ('role-reviewer', 'result.enter'),
  ('role-reviewer', 'oos.view'),
  ('role-reviewer', 'oos.open'),
  ('role-reviewer', 'oos.edit'),
  ('role-reviewer', 'spec.view'),
  ('role-reviewer', 'spec.create'),
  ('role-reviewer', 'spec.edit'),
  ('role-reviewer', 'trace.view'),
  ('role-reviewer', 'trace.dispense'),
  ('role-reviewer', 'record.verify'),
  ('role-reviewer', 'eln.view'),
  ('role-reviewer', 'eln.create'),
  ('role-reviewer', 'eln.edit'),
  ('role-reviewer', 'eln.sign'),
  ('role-reviewer', 'instrument.view'),
  ('role-reviewer', 'instrument.register'),
  ('role-reviewer', 'instrument.calibrate'),
  ('role-reviewer', 'reagent.view'),
  ('role-reviewer', 'reagent.receive'),
  ('role-reviewer', 'env.view'),
  ('role-reviewer', 'env.record'),
  ('role-reviewer', 'env.edit'),
  ('role-reviewer', 'stability.view'),
  ('role-reviewer', 'stability.create'),
  ('role-reviewer', 'stability.edit'),
  ('role-reviewer', 'report.view'),
  ('role-reviewer', 'report.generate'),
  ('role-reviewer', 'training.view'),
  ('role-reviewer', 'ai.use'),
  ('role-reviewer', 'system.info.view'),
  ('role-reviewer', 'audit.history.view'),
  ('role-analyst', 'sample.view'),
  ('role-analyst', 'sample.transition'),
  ('role-analyst', 'sample.notebook.add'),
  ('role-analyst', 'result.enter'),
  ('role-analyst', 'oos.view'),
  ('role-analyst', 'oos.open'),
  ('role-analyst', 'oos.edit'),
  ('role-analyst', 'spec.view'),
  ('role-analyst', 'spec.create'),
  ('role-analyst', 'spec.edit'),
  ('role-analyst', 'trace.view'),
  ('role-analyst', 'trace.dispense'),
  ('role-analyst', 'record.verify'),
  ('role-analyst', 'eln.view'),
  ('role-analyst', 'eln.create'),
  ('role-analyst', 'eln.edit'),
  ('role-analyst', 'eln.sign'),
  ('role-analyst', 'instrument.view'),
  ('role-analyst', 'instrument.register'),
  ('role-analyst', 'instrument.calibrate'),
  ('role-analyst', 'reagent.view'),
  ('role-analyst', 'reagent.receive'),
  ('role-analyst', 'env.view'),
  ('role-analyst', 'env.record'),
  ('role-analyst', 'env.edit'),
  ('role-analyst', 'stability.view'),
  ('role-analyst', 'stability.create'),
  ('role-analyst', 'stability.edit'),
  ('role-analyst', 'report.view'),
  ('role-analyst', 'report.generate'),
  ('role-analyst', 'training.view'),
  ('role-analyst', 'ai.use'),
  ('role-analyst', 'system.info.view'),
  ('role-analyst', 'sample.register')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "sod_rules" ("code", "description", "entity", "author_actions")
SELECT v.* FROM (VALUES
  ('spec.approve', 'The person who approves a specification must not have created or edited it.', 'Specification', ARRAY['Create', 'Update']::text[]),
  ('role.grant', 'The person who approves a role change must be neither the person who requested it nor the person it is for.', 'UserRole', ARRAY['RoleChangeRequested']::text[])
) AS v("code", "description", "entity", "author_actions")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
