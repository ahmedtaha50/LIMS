-- 0080_backup_jobs: backup v2 records (roadmap M14) and the durable job queue with its scheduler (roadmap M15).
--
-- jobs               The queue becomes durable and shareable between processes. New columns: run_at (not before), attempts and
--                    max_attempts (bounded retries), locked_by and heartbeat_at (the lease a worker holds while it runs the job; a
--                    sweeper requeues a job whose lease went stale), created_by (the owner: only the owner reads the job and its
--                    artifact), dedupe_key (one active job per key), last_error, finished_at, and the artifact columns (the result
--                    of a PDF job is a file with a checksum, kept until artifact_expires_at, not a base64 text in the row).
--                    `type` keeps its name: it is the handler key. Status vocabulary: pending -> running -> completed | failed.
-- scheduled_jobs    The schedule registry: what is due when. The scheduler compares next_due_at with the clock at every tick and at
--                    start-up, so a PC that was switched off over a due time catches up once.
-- backup_runs        One row per backup attempt, written when the attempt ends. Append-only (trigger from src/db/protections/ops.ts).
-- restore_drills     One row per restore drill (a backup restored into a scratch database and compared). Append-only.
--
-- Existing rows: a job that v0.1.0 left in 'processing' was abandoned by a crash and is marked failed (it would otherwise stay
-- 'processing' for ever); 'pending', 'completed' and 'failed' rows are left as they are. Jobs written by v0.1.0 have no owner, so no
-- user can read their stored result. Nothing here touches audit_trail or signatures.

UPDATE "jobs" SET "status" = 'failed', "result" = 'Interrupted before the upgrade to the durable job queue; request it again.' WHERE "status" = 'processing';

ALTER TABLE "jobs" ADD COLUMN "run_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;
ALTER TABLE "jobs" ADD COLUMN "locked_by" text;
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN "created_by" text;
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;
ALTER TABLE "jobs" ADD COLUMN "last_error" text;
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN "artifact_name" text;
ALTER TABLE "jobs" ADD COLUMN "artifact_mime" text;
ALTER TABLE "jobs" ADD COLUMN "artifact_sha256" text;
ALTER TABLE "jobs" ADD COLUMN "artifact_bytes" bigint;
ALTER TABLE "jobs" ADD COLUMN "artifact_expires_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN "artifact_purged_at" timestamp with time zone;

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

-- claim: the oldest due pending job (FOR UPDATE SKIP LOCKED); sweep: running jobs by heartbeat; dedupe: one active job per key;
-- created_by is a foreign key and PostgreSQL does not index those; artifact_expires_at serves the retention sweep.
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';
CREATE INDEX "jobs_running_heartbeat_idx" ON "jobs" USING btree ("heartbeat_at") WHERE "jobs"."status" = 'running';
CREATE UNIQUE INDEX "jobs_dedupe_active_uidx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('pending', 'running');
CREATE INDEX "jobs_created_by_idx" ON "jobs" USING btree ("created_by");
CREATE INDEX "jobs_artifact_expires_idx" ON "jobs" USING btree ("artifact_expires_at") WHERE "jobs"."artifact_name" IS NOT NULL AND "jobs"."artifact_purged_at" IS NULL;

CREATE TABLE "scheduled_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"cron" text NOT NULL,
	"type" text NOT NULL,
	"payload" text,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"last_job_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("next_due_at") WHERE "scheduled_jobs"."enabled";

CREATE TABLE "backup_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"file_name" text,
	"bytes" bigint,
	"sha256" text,
	"schema_version" text,
	"audit_head_sequence" integer,
	"audit_head_hash" text,
	"counts" text,
	"verified" boolean DEFAULT false NOT NULL,
	"mirror_ok" boolean,
	"mirror_sha256" text,
	"mirror_error" text,
	"error" text,
	"job_id" text,
	"created_by" text NOT NULL
);

ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "backup_runs_finished_at_idx" ON "backup_runs" USING btree ("finished_at");
CREATE INDEX "backup_runs_created_by_idx" ON "backup_runs" USING btree ("created_by");

CREATE TABLE "restore_drills" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"backup_file" text,
	"backup_sha256" text,
	"scratch_db" text,
	"passed" boolean NOT NULL,
	"chain_intact" boolean,
	"counts_match" boolean,
	"hashes_match" boolean,
	"timestamps_match" boolean,
	"tables_compared" integer,
	"detail" text,
	"error" text,
	"job_id" text,
	"created_by" text NOT NULL
);

ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "restore_drills_finished_at_idx" ON "restore_drills" USING btree ("finished_at");
CREATE INDEX "restore_drills_created_by_idx" ON "restore_drills" USING btree ("created_by");
