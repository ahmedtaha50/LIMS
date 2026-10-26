-- 0270_worklists: worklists and batch runs (roadmap M33, r2-worklists; 21 CFR 211.25 and 211.160(b), EU GMP Annex 11 section 12).
--
-- What this adds, and why:
--   worklists       one run of one method on at most one instrument, planned for a date (WL-<year>-<n>, from the gap-free counter
--                   worklist:<year>). Draft while it is planned; Released when the run is fixed (membership is then frozen: a change
--                   needs a reason and is audited); Completed or Cancelled. The method of a worklist never changes.
--   worklist_items  the run sequence: a Sample item (one result of one sample and the analyst who runs it) or a Standard, Blank, SST
--                   or Control injection (a label only). Never deleted: removed with a reason. While its worklist is Released a Sample
--                   item is the ASSIGNMENT of its result, enforced by the result guard `assignment` (only the assignee may enter it).
--                   CHECKs: a Sample item names its sample, result and assignee; any other item names none of the first two and has a
--                   label; Removed goes with who, when and why. The same result cannot be on one worklist twice while Active.
--   permissions     worklist.view (every role) and worklist.manage (Analyst, QA, Admin), positions 270 and 271.
--
-- The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040, 0210 and 0220, because a
-- restore replays this file into an EMPTY database.

CREATE TABLE "worklists" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"method_code" text NOT NULL,
	"instrument_id" text,
	"planned_date" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "worklists_status_check" CHECK ("worklists"."status" IN ('Draft', 'Released', 'Completed', 'Cancelled')),
	CONSTRAINT "worklists_planned_date_check" CHECK ("worklists"."planned_date" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "worklists_closed_check" CHECK (("worklists"."status" IN ('Completed', 'Cancelled')) = ("worklists"."closed_at" IS NOT NULL AND "worklists"."closed_by" IS NOT NULL))
);

CREATE TABLE "worklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"worklist_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"sample_id" text,
	"result_id" text,
	"label" text,
	"assignee_id" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" text,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "worklist_items_kind_check" CHECK ("worklist_items"."kind" IN ('Sample', 'Standard', 'Blank', 'SST', 'Control')),
	CONSTRAINT "worklist_items_status_check" CHECK ("worklist_items"."status" IN ('Active', 'Removed')),
	CONSTRAINT "worklist_items_sample_check" CHECK ("worklist_items"."kind" <> 'Sample' OR ("worklist_items"."sample_id" IS NOT NULL AND "worklist_items"."result_id" IS NOT NULL AND "worklist_items"."assignee_id" IS NOT NULL)),
	CONSTRAINT "worklist_items_other_check" CHECK ("worklist_items"."kind" = 'Sample' OR ("worklist_items"."sample_id" IS NULL AND "worklist_items"."result_id" IS NULL AND length(btrim(coalesce("worklist_items"."label", ''))) > 0)),
	CONSTRAINT "worklist_items_removed_check" CHECK (("worklist_items"."status" = 'Removed') = ("worklist_items"."removed_at" IS NOT NULL AND "worklist_items"."removed_by" IS NOT NULL AND length(btrim(coalesce("worklist_items"."removed_reason", ''))) > 0))
);

ALTER TABLE "worklists" ADD CONSTRAINT "worklists_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklists" ADD CONSTRAINT "worklists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklists" ADD CONSTRAINT "worklists_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklists" ADD CONSTRAINT "worklists_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_worklist_id_worklists_id_fk" FOREIGN KEY ("worklist_id") REFERENCES "public"."worklists"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "worklist_items" ADD CONSTRAINT "worklist_items_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "worklists_status_planned_date_idx" ON "worklists" USING btree ("status","planned_date");
CREATE INDEX "worklists_instrument_id_idx" ON "worklists" USING btree ("instrument_id");
CREATE INDEX "worklists_created_by_idx" ON "worklists" USING btree ("created_by");
CREATE INDEX "worklists_released_by_idx" ON "worklists" USING btree ("released_by");
CREATE INDEX "worklists_closed_by_idx" ON "worklists" USING btree ("closed_by");
CREATE UNIQUE INDEX "worklist_items_result_uidx" ON "worklist_items" USING btree ("worklist_id","result_id") WHERE "worklist_items"."status" = 'Active' AND "worklist_items"."result_id" IS NOT NULL;
CREATE INDEX "worklist_items_worklist_position_idx" ON "worklist_items" USING btree ("worklist_id","position");
CREATE INDEX "worklist_items_result_id_idx" ON "worklist_items" USING btree ("result_id");
CREATE INDEX "worklist_items_sample_id_idx" ON "worklist_items" USING btree ("sample_id");
CREATE INDEX "worklist_items_assignee_id_idx" ON "worklist_items" USING btree ("assignee_id");
CREATE INDEX "worklist_items_added_by_idx" ON "worklist_items" USING btree ("added_by");
CREATE INDEX "worklist_items_removed_by_idx" ON "worklist_items" USING btree ("removed_by");

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('worklist.view', 'Worklists', 'Read worklists, the workload view and the run-sequence export', 270),
	('worklist.manage', 'Worklists', 'Plan, release, change, complete and cancel worklists; assign analysts; request the bench sheet', 271)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'worklist.view'), ('role-admin', 'worklist.manage'),
	('role-qa', 'worklist.view'), ('role-qa', 'worklist.manage'),
	('role-reviewer', 'worklist.view'),
	('role-analyst', 'worklist.view'), ('role-analyst', 'worklist.manage')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
