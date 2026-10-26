-- 0010_identity: identity and authentication (roadmap M05) and controlled AI egress (roadmap M16).
--
-- What this adds, and why:
--   users                  must_change_password   first sign-in and administrator reset force a new password
--                          login_failed_attempts, login_locked_until
--                                                 the SIGN-IN lockout, separate from failed_attempts / locked_at, which stay the SIGNING lockout:
--                                                 a lock set by wrong e-signature passwords used to block sign-in for ever (login rejected any non-null locked_at)
--                          totp_pending_secret    enrolment in progress (ciphertext, like totp_secret)
--                          totp_last_step         newest accepted TOTP step: the replay guard
--                          totp_enrolled_at, version
--                          lower(email) is unique (no two accounts differing only in case)
--   system_settings        password_history_count, lockout_minutes, mfa_required, session_absolute_hours, version
--   sessions               one row per sign-in; idle and absolute timeout, logout and revocation are decided from it
--   password_history       the hashes behind "not one of the last N passwords"
--   auth_challenges        single-use second-step challenges (MFA, enrolment)
--   recovery_codes         one-time MFA recovery codes (salted scrypt hashes)
--   integration_settings   external AI switch (off by default) and the encrypted API key
--
-- Existing rows: every new column has a default that keeps today's behaviour; the current password hash of each user becomes the first
-- password_history row. Plaintext TOTP secrets already in users.totp_secret are not touched here (SQL has no access to the key); the
-- application reads them and rewrites them as ciphertext the first time they are used, and `admin-cli rotate-keys` rewrites any that remain.
-- Nothing here rewrites audit_trail or signatures.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0010_identity: two users share an e-mail address that differs only in letter case. Correct one of them, then run the migration again.';
  END IF;
END $$;

CREATE TABLE "auth_challenges" (
	"jti" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);

CREATE TABLE "integration_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"external_ai_enabled" boolean DEFAULT false NOT NULL,
	"ai_api_key_enc" text,
	"ai_model" text DEFAULT 'gemini-3.8-flash' NOT NULL,
	"ai_redact_identifiers" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "password_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);

CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"auth_method" text NOT NULL
);

ALTER TABLE "system_settings" ADD COLUMN "password_history_count" integer DEFAULT 5 NOT NULL;
ALTER TABLE "system_settings" ADD COLUMN "lockout_minutes" integer DEFAULT 15 NOT NULL;
ALTER TABLE "system_settings" ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL;
ALTER TABLE "system_settings" ADD COLUMN "session_absolute_hours" integer DEFAULT 12 NOT NULL;
ALTER TABLE "system_settings" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;

ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN "login_failed_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "login_locked_until" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN "totp_pending_secret" text;
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;
ALTER TABLE "users" ADD COLUMN "totp_enrolled_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;

ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

-- Every foreign key above is looked up by user: sign-in history checks, session revocation, recovery code scan.
CREATE INDEX "auth_challenges_user_id_idx" ON "auth_challenges" USING btree ("user_id");
CREATE INDEX "password_history_user_id_idx" ON "password_history" USING btree ("user_id");
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes" USING btree ("user_id");
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
CREATE UNIQUE INDEX "users_email_lower_uidx" ON "users" USING btree (lower("email"));

-- The password in force today is the first entry of each user's history.
INSERT INTO password_history (id, user_id, password_hash, created_at)
SELECT 'pwh-' || substr(md5(id || password_hash), 1, 16), id, password_hash, COALESCE(password_changed_at, created_at)
FROM users WHERE password_hash IS NOT NULL;
