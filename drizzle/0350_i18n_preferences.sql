-- 0350_i18n_preferences: the display language and digit style of each user (roadmap M38, r3-i18n).
--
-- What this adds, and why:
--   user_preferences   one optional row per user: language ('en' or 'ar') and digits ('latin' or 'arabic-indic'). It is a sidecar to users
--                      (users is not touched). No row means the defaults: English, Latin digits. The Electron build serves the interface on a
--                      random port, so the browser's localStorage is lost at every launch; the server copy is what makes the choice stick.
--
-- These are display preferences ONLY. No GxP record, signature, audit entry, CSV or PDF value depends on them: stored data, the audit
-- trail and every export stay in canonical English with Latin digits and ISO timestamps whatever a user chooses here. A change is still
-- written to the audit trail (entity UserPreference) in the same transaction, and uses the usual version check.

CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"digits" text DEFAULT 'latin' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_language_check" CHECK ("user_preferences"."language" IN ('en', 'ar')),
	CONSTRAINT "user_preferences_digits_check" CHECK ("user_preferences"."digits" IN ('latin', 'arabic-indic'))
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
