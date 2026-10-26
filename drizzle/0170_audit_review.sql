-- 0170_audit_review: audit-trail review and tamper evidence (roadmap M35, r2-audit-tamper).
--
-- What this adds, and why:
--   audit_reviews            a signed review (AUDIT_REVIEW) of the audit trail: of the rows about one batch (scope 'batch', scope_id the
--                            batch) or of a range of sequences (scope 'range'). from_sequence..to_sequence is the range the reviewer saw;
--                            exception_count how many of its rows were exceptions (src/server/audit/review.ts). Append-only: a review is
--                            a signed record, a later review is a new row. The release interlock counts a batch's rows not inside any
--                            review.
--   audit_review_settings    one row: required_for_release. When it is on, a batch is released only when every audit row about it is
--                            covered by a signed review. Changed only by an e-signature (AUDIT_REVIEW_SETTING). Off on installation:
--                            switching it on is a decision of the quality unit.
--   audit_anchors            the register of the anchor files written (sequence, hash and seal of the head, the file's name and HMAC).
--                            The file on the second path is the evidence; this register only lets a missing file be noticed.
--                            Append-only.
--   clock_state              one row: the latest time the clock guard has seen (the watermark).
--   clock_anomalies          each time the clock was found earlier than the watermark by more than the tolerance. While one is not
--                            acknowledged, signing is refused (423 CLOCK_ANOMALY), except the acknowledgement itself (CLOCK_ANOMALY_ACK,
--                            Administrators). `version` is the optimistic-concurrency counter of the acknowledgement.
--   signature_meanings       AUDIT_REVIEW, AUDIT_REVIEW_SETTING, CLOCK_ANOMALY_ACK.
--   permissions              audit.review, audit.review.settings, clock.acknowledge and their grants (positions 170 to 172).
--
-- No existing table is changed and no existing row is touched. The constants are written only under the migration runner
-- (WHERE EXISTS schema_migrations), like 0020, 0040, 0100 and 0180, because a restore replays this file into an EMPTY database.

CREATE TABLE "audit_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"from_sequence" integer NOT NULL,
	"to_sequence" integer NOT NULL,
	"rows_reviewed" integer NOT NULL,
	"exception_count" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"reviewer_id" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "audit_reviews_scope_check" CHECK ("audit_reviews"."scope" IN ('batch', 'range')),
	CONSTRAINT "audit_reviews_scope_id_check" CHECK (("audit_reviews"."scope" = 'batch') = ("audit_reviews"."scope_id" IS NOT NULL)),
	CONSTRAINT "audit_reviews_range_check" CHECK ("audit_reviews"."from_sequence" >= 1 AND "audit_reviews"."from_sequence" <= "audit_reviews"."to_sequence")
);

CREATE TABLE "audit_review_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"required_for_release" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);

CREATE TABLE "audit_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" integer NOT NULL,
	"hash" text NOT NULL,
	"seal" text,
	"security_sequence" integer,
	"security_hash" text,
	"anchored_at" timestamp with time zone NOT NULL,
	"file_name" text NOT NULL,
	"key_generation" integer NOT NULL,
	"hmac" text NOT NULL,
	"created_by" text
);

CREATE TABLE "clock_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "clock_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"behind_ms" bigint NOT NULL,
	"source" text NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"ack_reason" text,
	"version" integer DEFAULT 1 NOT NULL
);

ALTER TABLE "audit_reviews" ADD CONSTRAINT "audit_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "audit_review_settings" ADD CONSTRAINT "audit_review_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "clock_anomalies" ADD CONSTRAINT "clock_anomalies_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "audit_reviews_scope_idx" ON "audit_reviews" USING btree ("scope","scope_id");
CREATE INDEX "audit_reviews_reviewer_id_idx" ON "audit_reviews" USING btree ("reviewer_id");
CREATE INDEX "audit_review_settings_updated_by_idx" ON "audit_review_settings" USING btree ("updated_by");
CREATE INDEX "audit_anchors_sequence_idx" ON "audit_anchors" USING btree ("sequence");
CREATE INDEX "clock_anomalies_open_idx" ON "clock_anomalies" USING btree ("acknowledged_at");
CREATE INDEX "clock_anomalies_acknowledged_by_idx" ON "clock_anomalies" USING btree ("acknowledged_by");

-- ---- reviews and the anchor register are append-only ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_audit_reviews_row_guard BEFORE UPDATE OR DELETE ON audit_reviews FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_audit_reviews_truncate_guard BEFORE TRUNCATE ON audit_reviews FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_audit_anchors_row_guard BEFORE UPDATE OR DELETE ON audit_anchors FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_audit_anchors_truncate_guard BEFORE TRUNCATE ON audit_anchors FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "audit_review_settings" ("id", "required_for_release")
SELECT 'default', false
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('AUDIT_REVIEW', 'Audit trail review: I have reviewed the audit trail entries in this scope, including every exception listed, and I am satisfied that they are complete and acceptable or that every concern has been raised.', ARRAY['QA','Admin'], false, false),
	('AUDIT_REVIEW_SETTING', 'Audit trail review setting: I authorise this change to whether a signed audit trail review is required before batch release.', ARRAY['QA','Admin'], true, false),
	('CLOCK_ANOMALY_ACK', 'Clock anomaly acknowledgement: I have checked the system clock, corrected it where needed, and assessed the records written while it was wrong.', ARRAY['Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('audit.review', 'Audit', 'Sign an audit trail review of a batch or of a range of entries', 170),
	('audit.review.settings', 'Audit', 'Switch the audit-trail-review-before-release requirement on or off with an e-signature', 171),
	('clock.acknowledge', 'Audit', 'Acknowledge a clock anomaly with an e-signature, which lifts the signing block', 172)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'audit.review'),
	('role-admin', 'audit.review.settings'),
	('role-admin', 'clock.acknowledge'),
	('role-qa', 'audit.review'),
	('role-qa', 'audit.review.settings')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
