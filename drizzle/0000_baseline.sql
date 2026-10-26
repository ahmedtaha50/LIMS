-- 0000_baseline: the schema of B-Pharma LIMS v0.1.0, exactly as its installer (desktop/schema.sql) created it.
--
-- This is generated drizzle-kit output of src/db/schema.ts at commit cc95dbb and is frozen: never edit it, add a new migration.
-- An installation that has no schema_migrations journal is accepted as "v0.1.0" only if its structural fingerprint equals the one
-- below (src/server/boot/structure.ts); the journal is then started at this migration without executing it.
--
-- baseline-structure-sha256: 978487bd23cf05fbc018cd24be33740f0175bfb3c25374c7bddd499f0f4b9cab

CREATE TABLE "audit_trail" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" integer NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"timestamp_str" text,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"reason" text NOT NULL,
	"hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	CONSTRAINT "audit_trail_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "batch_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"batch" text NOT NULL,
	"material_name" text NOT NULL,
	"material_type" text NOT NULL,
	"lot_number" text NOT NULL,
	"manufacturer" text NOT NULL,
	"coa_number" text NOT NULL,
	"coa_status" text NOT NULL,
	"quantity_dispensed" text NOT NULL,
	"potency_assay" text,
	"loss_on_drying" text,
	"dispensed_by" text,
	"verified_by" text,
	"dispensed_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"batch" text NOT NULL,
	"status" text NOT NULL,
	"disposition_recommendation" text,
	"released_by" text,
	"released_at" timestamp,
	"meaning" text,
	"content_hash" text,
	"signature_id" text,
	"audit_entry_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "batch_releases_batch_unique" UNIQUE("batch")
);
--> statement-breakpoint
CREATE TABLE "env_records" (
	"id" text PRIMARY KEY NOT NULL,
	"location" text NOT NULL,
	"grade" text NOT NULL,
	"date" text NOT NULL,
	"viable_count" integer NOT NULL,
	"non_viable_count" integer NOT NULL,
	"status" text NOT NULL,
	"tested_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"calibration_due_date" text NOT NULL,
	"last_calibration_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"payload" text,
	"result" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_notebook" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"sample_id" text,
	"content" text NOT NULL,
	"experiment_type" text,
	"status" text DEFAULT 'Draft' NOT NULL,
	"entered_by" text NOT NULL,
	"entered_at" timestamp DEFAULT now() NOT NULL,
	"signed_at" timestamp,
	"signed_by" text,
	"signature_meaning" text,
	"content_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"pharmacopeia" text
);
--> statement-breakpoint
CREATE TABLE "notebook_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oos_investigations" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"result_id" text NOT NULL,
	"parameter" text NOT NULL,
	"date_raised" text NOT NULL,
	"status" text NOT NULL,
	"assigned_to" text,
	"root_cause" text,
	"conclusion" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reagents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lot_number" text NOT NULL,
	"expiry_date" text NOT NULL,
	"status" text NOT NULL,
	"quantity" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"parameter" text NOT NULL,
	"value" text,
	"spec_min" real,
	"spec_max" real,
	"is_oos" boolean DEFAULT false NOT NULL,
	"entered_by" text,
	"entered_at" timestamp,
	"instrument_id" text,
	"attachment_name" text,
	"attachment_data" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" text PRIMARY KEY NOT NULL,
	"material" text NOT NULL,
	"batch" text NOT NULL,
	"state" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"signer_id" text NOT NULL,
	"meaning" text NOT NULL,
	"reason" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"record_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"audit_entry_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specifications" (
	"id" text PRIMARY KEY NOT NULL,
	"material" text NOT NULL,
	"version" integer NOT NULL,
	"effective_date" text NOT NULL,
	"status" text NOT NULL,
	"parameters" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stability_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"batch" text NOT NULL,
	"condition" text NOT NULL,
	"pull_points" jsonb NOT NULL,
	"start_date" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"session_timeout_minutes" integer DEFAULT 15 NOT NULL,
	"max_failed_logins" integer DEFAULT 3 NOT NULL,
	"password_expiry_days" integer DEFAULT 90 NOT NULL,
	"min_password_length" integer DEFAULT 8 NOT NULL,
	"require_uppercase" boolean DEFAULT true NOT NULL,
	"require_numbers" boolean DEFAULT true NOT NULL,
	"require_symbols" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_records" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"module_name" text NOT NULL,
	"status" text NOT NULL,
	"completed_at" timestamp,
	"certified_by" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp DEFAULT now(),
	"email" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp,
	"has_completed_software_training" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
ALTER TABLE "batch_materials" ADD CONSTRAINT "batch_materials_dispensed_by_users_id_fk" FOREIGN KEY ("dispensed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_materials" ADD CONSTRAINT "batch_materials_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_releases" ADD CONSTRAINT "batch_releases_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_records" ADD CONSTRAINT "env_records_tested_by_users_id_fk" FOREIGN KEY ("tested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_notebook" ADD CONSTRAINT "lab_notebook_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_notebook" ADD CONSTRAINT "lab_notebook_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_notebook" ADD CONSTRAINT "lab_notebook_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_templates" ADD CONSTRAINT "notebook_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oos_investigations" ADD CONSTRAINT "oos_investigations_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oos_investigations" ADD CONSTRAINT "oos_investigations_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oos_investigations" ADD CONSTRAINT "oos_investigations_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;