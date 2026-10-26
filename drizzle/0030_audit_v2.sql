-- 0030_audit_v2 (roadmap M08): audit trail v2, checkpoints and the security event log.
--
-- audit_trail gains the who/where snapshot of each action (actor_name, actor_role, session_id, app_version), the hash version and
-- algorithm that say how the row is verified, and `seal`, which covers the snapshot (src/server/audit/hash.ts). Every column is
-- nullable or has a constant default, so no existing row is rewritten (PostgreSQL stores the default without touching the rows,
-- and the append-only trigger never fires): rows written before this migration read hash_version 1, hash_alg 'sha256', no seal,
-- and keep verifying exactly as they did. The link hash of new rows is computed with the old formula, so the older verifiers
-- (the backup check, the signature check, the traceability check) still accept them.
--
-- audit_checkpoints: (sequence, hash, seal) at every 5,000th sequence, where bounded verification starts. Append-only.
-- security_events: its own hash chain for sign-in, lockout, refusal, export and configuration events. Append-only.
-- The triggers for both tables are installed by the protection registry (src/db/protections/audit.ts) before this migration commits.
--
-- Indexes: audit_trail(action) and audit_trail(timestamp) serve the filters of GET /audit and its export;
-- the entity and user filters already have one (0003).

ALTER TABLE "audit_trail" ADD COLUMN "actor_name" text;
ALTER TABLE "audit_trail" ADD COLUMN "actor_role" text;
ALTER TABLE "audit_trail" ADD COLUMN "session_id" text;
ALTER TABLE "audit_trail" ADD COLUMN "app_version" text;
ALTER TABLE "audit_trail" ADD COLUMN "hash_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "audit_trail" ADD COLUMN "hash_alg" text DEFAULT 'sha256' NOT NULL;
ALTER TABLE "audit_trail" ADD COLUMN "seal" text;

CREATE INDEX "audit_trail_action_idx" ON "audit_trail" USING btree ("action");
CREATE INDEX "audit_trail_timestamp_idx" ON "audit_trail" USING btree ("timestamp");

CREATE TABLE "audit_checkpoints" (
	"sequence" integer PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"seal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" integer NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"timestamp_str" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"actor_role" text,
	"session_id" text,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"detail" text DEFAULT '' NOT NULL,
	"app_version" text,
	"hash_version" integer DEFAULT 1 NOT NULL,
	"hash_alg" text DEFAULT 'sha256' NOT NULL,
	"hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	CONSTRAINT "security_events_sequence_unique" UNIQUE("sequence")
);

CREATE INDEX "security_events_event_type_idx" ON "security_events" USING btree ("event_type");
CREATE INDEX "security_events_actor_id_idx" ON "security_events" USING btree ("actor_id");
CREATE INDEX "security_events_timestamp_idx" ON "security_events" USING btree ("timestamp");
