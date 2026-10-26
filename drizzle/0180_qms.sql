-- 0180_qms: the quality management engine: deviations, CAPA, change control and audit findings (roadmap M27, r2-qms).
--
-- What this adds, and why:
--   qms_records               one table for the four record types (type), each with its own lifecycle (src/server/qms/states.ts):
--                             classification (Minor, Major, Critical), state, owner, due date and a per-type payload validated by a
--                             strict Zod schema (src/server/qms/schemas.ts). `version` is the optimistic-concurrency counter.
--                             origin 'manual' (a person, through the API) or 'auto:<source>' (opened in the transaction of the event that
--                             caused it: a confirmed OOS, an EM excursion, a backup or audit-chain failure). An automatic record is opened
--                             once per source (partial unique index).
--   qms_actions               the actions of a record (CAPA actions, deviation actions), each with an owner and a due date. Completing an
--                             action is e-signed (QMS_ACTION_COMPLETION) and names its evidence.
--   qms_links                 what a record is linked to: its CAPA, the records a change control affects, the batch or sample it is about,
--                             and which affected record a change control was implemented on. Append-only.
--   qms_comments              the discussion of a record. Append-only.
--   qms_effectiveness_checks  each effectiveness check of a CAPA, e-signed (QMS_EFFECTIVENESS). Append-only: a check that found the CAPA
--                             not effective stays on record next to the later one that found it effective.
--   qms_settings              one row: change_control_required. When it is on, approving a specification and approving a role change
--                             need a change control in state Approved that affects the record (409 CHANGE_REQUIRED). Changed only by an
--                             e-signature (QMS_SETTING_CHANGE). Off on installation: switching it on is a decision of the quality unit.
--   signature_meanings        seven meanings (approval, closure, rejection, emergency change, action completion, effectiveness, setting).
--   permissions               qms.view, qms.create, qms.edit, qms.approve, qms.settings and their grants (positions 180 to 184).
--
-- Record numbers (DEV-2026-0001, CAPA-2026-0001, CC-2026-0001, AF-2026-0001) come from the existing gap-free `counters` table
-- (src/server/core/tx.ts nextSequence, key qms:<prefix>:<year>), so two simultaneous creations get distinct numbers.
-- No existing table is changed and no existing row is touched. The constants are written only under the migration runner
-- (WHERE EXISTS schema_migrations), like 0020, 0040 and 0100, because a restore replays this file into an EMPTY database.

CREATE TABLE "qms_records" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"classification" text,
	"state" text NOT NULL,
	"owner_id" text,
	"due_date" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_type" text,
	"source_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qms_records_type_check" CHECK ("qms_records"."type" IN ('Deviation', 'CAPA', 'ChangeControl', 'AuditFinding')),
	CONSTRAINT "qms_records_classification_check" CHECK ("qms_records"."classification" IS NULL OR "qms_records"."classification" IN ('Minor', 'Major', 'Critical'))
);

CREATE TABLE "qms_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" text NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"evidence_ref" text,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qms_actions_status_check" CHECK ("qms_actions"."status" IN ('Open', 'Done', 'Cancelled'))
);

CREATE TABLE "qms_links" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"relation" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qms_links_relation_check" CHECK ("qms_links"."relation" IN ('capa', 'affects', 'related', 'source', 'implemented'))
);

CREATE TABLE "qms_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"author_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "qms_effectiveness_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"result" text NOT NULL,
	"evidence" text NOT NULL,
	"record_version" integer NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qms_effectiveness_checks_result_check" CHECK ("qms_effectiveness_checks"."result" IN ('Effective', 'Not effective'))
);

CREATE TABLE "qms_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"change_control_required" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);

ALTER TABLE "qms_records" ADD CONSTRAINT "qms_records_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_records" ADD CONSTRAINT "qms_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_actions" ADD CONSTRAINT "qms_actions_record_id_qms_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_actions" ADD CONSTRAINT "qms_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_actions" ADD CONSTRAINT "qms_actions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_actions" ADD CONSTRAINT "qms_actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_links" ADD CONSTRAINT "qms_links_record_id_qms_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_links" ADD CONSTRAINT "qms_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_comments" ADD CONSTRAINT "qms_comments_record_id_qms_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_comments" ADD CONSTRAINT "qms_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_effectiveness_checks" ADD CONSTRAINT "qms_effectiveness_checks_record_id_qms_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."qms_records"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_effectiveness_checks" ADD CONSTRAINT "qms_effectiveness_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qms_settings" ADD CONSTRAINT "qms_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "qms_records_type_state_idx" ON "qms_records" USING btree ("type","state");
CREATE INDEX "qms_records_owner_id_idx" ON "qms_records" USING btree ("owner_id");
CREATE INDEX "qms_records_created_by_idx" ON "qms_records" USING btree ("created_by");
CREATE UNIQUE INDEX "qms_records_auto_source_uidx" ON "qms_records" USING btree ("type","source_type","source_id") WHERE "qms_records"."origin" <> 'manual';
CREATE INDEX "qms_actions_record_id_idx" ON "qms_actions" USING btree ("record_id");
CREATE INDEX "qms_actions_owner_id_idx" ON "qms_actions" USING btree ("owner_id");
CREATE INDEX "qms_actions_completed_by_idx" ON "qms_actions" USING btree ("completed_by");
CREATE INDEX "qms_actions_created_by_idx" ON "qms_actions" USING btree ("created_by");
CREATE UNIQUE INDEX "qms_links_record_relation_target_uidx" ON "qms_links" USING btree ("record_id","relation","target_type","target_id");
CREATE INDEX "qms_links_target_idx" ON "qms_links" USING btree ("target_type","target_id");
CREATE INDEX "qms_links_created_by_idx" ON "qms_links" USING btree ("created_by");
CREATE INDEX "qms_comments_record_id_idx" ON "qms_comments" USING btree ("record_id");
CREATE INDEX "qms_comments_author_id_idx" ON "qms_comments" USING btree ("author_id");
CREATE INDEX "qms_effectiveness_checks_record_id_idx" ON "qms_effectiveness_checks" USING btree ("record_id");
CREATE INDEX "qms_effectiveness_checks_checked_by_idx" ON "qms_effectiveness_checks" USING btree ("checked_by");
CREATE INDEX "qms_settings_updated_by_idx" ON "qms_settings" USING btree ("updated_by");

-- ---- links, comments and effectiveness checks are append-only -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_qms_links_row_guard BEFORE UPDATE OR DELETE ON qms_links FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_qms_links_truncate_guard BEFORE TRUNCATE ON qms_links FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_qms_comments_row_guard BEFORE UPDATE OR DELETE ON qms_comments FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_qms_comments_truncate_guard BEFORE TRUNCATE ON qms_comments FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_qms_effectiveness_checks_row_guard BEFORE UPDATE OR DELETE ON qms_effectiveness_checks FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_qms_effectiveness_checks_truncate_guard BEFORE TRUNCATE ON qms_effectiveness_checks FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "qms_settings" ("id", "change_control_required")
SELECT 'default', false
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('QMS_APPROVAL', 'Quality approval: I have reviewed this quality record (investigation, action plan or change) and approve it.', ARRAY['QA','Admin'], false, false),
	('QMS_CLOSURE', 'Quality closure: I confirm that the actions are complete, verified effective where required, and close this record.', ARRAY['QA','Admin'], true, false),
	('QMS_REJECTION', 'Quality rejection: I have reviewed this quality record and reject or cancel it.', ARRAY['QA','Admin'], true, false),
	('QMS_EMERGENCY_CHANGE', 'Emergency change authorisation: I authorise this change before the full review because waiting would put product or patients at risk; it must be reviewed retrospectively.', ARRAY['QA','Admin'], true, false),
	('QMS_ACTION_COMPLETION', 'Action completion: I performed this action and the evidence referenced is complete and accurate.', ARRAY['Analyst','Reviewer','QA','Admin'], false, false),
	('QMS_EFFECTIVENESS', 'Effectiveness verification: I have checked the evidence against the effectiveness criteria and record the result.', ARRAY['QA','Admin'], false, false),
	('QMS_SETTING_CHANGE', 'Quality system setting: I authorise this change to how change control is enforced.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('qms.view', 'Quality management', 'Read deviations, CAPA, change controls and audit findings', 180),
	('qms.create', 'Quality management', 'Raise a deviation, CAPA, change control or audit finding', 181),
	('qms.edit', 'Quality management', 'Edit an open quality record, move it through its unsigned steps, add actions, links and comments', 182),
	('qms.approve', 'Quality management', 'Triage, approve, close or reject a quality record with an e-signature; verify effectiveness', 183),
	('qms.settings', 'Quality management', 'Switch the change-control requirement on or off with an e-signature', 184)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'qms.view'),
	('role-admin', 'qms.create'),
	('role-admin', 'qms.edit'),
	('role-admin', 'qms.approve'),
	('role-admin', 'qms.settings'),
	('role-qa', 'qms.view'),
	('role-qa', 'qms.create'),
	('role-qa', 'qms.edit'),
	('role-qa', 'qms.approve'),
	('role-qa', 'qms.settings'),
	('role-reviewer', 'qms.view'),
	('role-reviewer', 'qms.create'),
	('role-reviewer', 'qms.edit'),
	('role-analyst', 'qms.view'),
	('role-analyst', 'qms.create'),
	('role-analyst', 'qms.edit')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
