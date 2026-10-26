-- 0310_directory: directory (LDAP / Active Directory) sign-on (roadmap M41, r3-directory).
--
-- What this adds, and why:
--   directory_settings     one row ('default'): the connection (LDAPS, or StartTLS on ldap://), the CA that must vouch for the server,
--                          the service account used for the search, and the search base. The bind password is keystore ciphertext
--                          (bind_password_enc), never clear. local_accounts_allowed = false closes local sign-in for every account except
--                          the break-glass ones while the directory is on. No row = directory sign-on is off, which is the state of every
--                          installation until an Administrator turns it on.
--   directory_accounts     a sidecar to users (one row per account that is not a plain local account): kind 'ldap' = the password
--                          is verified by the directory (users.password_hash stays empty); kind 'break-glass' = a flagged local
--                          Administrator that may sign in with its local password only while the directory cannot be reached.
--                          external_id is the immutable directory identifier (objectGUID, hex) the account is matched on.
--   directory_group_roles  the group-to-role mapping. A row is Draft until QA approves it with an e-signature (DIRECTORY_MAPPING),
--                          Approved rows are the only ones used at sign-in, Retired rows are kept. The Administrator role cannot be
--                          mapped (CHECK): it is granted by the two-person flow only.
--   signature_meanings     + DIRECTORY_MAPPING (QA only).
--   permissions            + directory.view (Admin, QA), directory.manage (Admin), directory.approve (QA).
-- users is not touched. Nothing here changes an existing account: all accounts stay local until they are provisioned by a directory
-- sign-in or flagged as break-glass by an Administrator.

CREATE TABLE "directory_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"url" text,
	"security" text DEFAULT 'ldaps' NOT NULL,
	"ca_pem" text,
	"bind_dn" text,
	"bind_password_enc" text,
	"base_dn" text,
	"group_attribute" text DEFAULT 'memberOf' NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"local_accounts_allowed" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_settings_security_check" CHECK ("directory_settings"."security" IN ('ldaps', 'starttls')),
	CONSTRAINT "directory_settings_url_check" CHECK ("directory_settings"."url" IS NULL OR ("directory_settings"."security" = 'ldaps' AND "directory_settings"."url" ~ '^ldaps://[^/ ]+$') OR ("directory_settings"."security" = 'starttls' AND "directory_settings"."url" ~ '^ldap://[^/ ]+$')),
	CONSTRAINT "directory_settings_timeout_check" CHECK ("directory_settings"."timeout_ms" BETWEEN 1000 AND 60000),
	CONSTRAINT "directory_settings_enabled_check" CHECK (NOT "directory_settings"."enabled" OR ("directory_settings"."url" IS NOT NULL AND "directory_settings"."bind_dn" IS NOT NULL AND "directory_settings"."bind_password_enc" IS NOT NULL AND "directory_settings"."base_dn" IS NOT NULL))
);

CREATE TABLE "directory_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"external_id" text,
	"dn" text,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "directory_accounts_kind_check" CHECK ("directory_accounts"."kind" IN ('ldap', 'break-glass')),
	CONSTRAINT "directory_accounts_external_check" CHECK (("directory_accounts"."kind" = 'ldap') = ("directory_accounts"."external_id" IS NOT NULL))
);

CREATE TABLE "directory_group_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"group_dn" text NOT NULL,
	"group_dn_norm" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"retired_by" text,
	"retired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "directory_group_roles_status_check" CHECK ("directory_group_roles"."status" IN ('Draft', 'Approved', 'Retired')),
	CONSTRAINT "directory_group_roles_role_check" CHECK ("directory_group_roles"."role" <> 'Admin'),
	CONSTRAINT "directory_group_roles_reason_check" CHECK (length(btrim("directory_group_roles"."reason")) >= 5)
);

ALTER TABLE "directory_settings" ADD CONSTRAINT "directory_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "directory_accounts" ADD CONSTRAINT "directory_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "directory_accounts" ADD CONSTRAINT "directory_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "directory_group_roles" ADD CONSTRAINT "directory_group_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "directory_group_roles" ADD CONSTRAINT "directory_group_roles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "directory_group_roles" ADD CONSTRAINT "directory_group_roles_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "directory_settings_updated_by_idx" ON "directory_settings" USING btree ("updated_by");
CREATE INDEX "directory_accounts_created_by_idx" ON "directory_accounts" USING btree ("created_by");
CREATE UNIQUE INDEX "directory_accounts_external_id_uidx" ON "directory_accounts" USING btree ("external_id") WHERE "directory_accounts"."external_id" IS NOT NULL;
CREATE INDEX "directory_group_roles_created_by_idx" ON "directory_group_roles" USING btree ("created_by");
CREATE INDEX "directory_group_roles_approved_by_idx" ON "directory_group_roles" USING btree ("approved_by");
CREATE INDEX "directory_group_roles_retired_by_idx" ON "directory_group_roles" USING btree ("retired_by");
CREATE UNIQUE INDEX "directory_group_roles_live_group_uidx" ON "directory_group_roles" USING btree ("group_dn_norm") WHERE "directory_group_roles"."status" IN ('Draft', 'Approved');

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('DIRECTORY_MAPPING', 'Directory group mapping decision: I have reviewed this directory group to LIMS role mapping and approve or retire it. Members of the group receive the role at their next sign-in.', ARRAY['QA'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('directory.view', 'Directory', 'Read the directory sign-on settings, group mappings and directory accounts', 310),
	('directory.manage', 'Directory', 'Change the directory connection, propose group mappings, flag break-glass accounts and test the connection', 311),
	('directory.approve', 'Directory', 'Approve or retire a directory group to role mapping with an e-signature', 312)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'directory.view'), ('role-admin', 'directory.manage'), ('role-admin', 'directory.approve'),
	('role-qa', 'directory.view'), ('role-qa', 'directory.approve')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
