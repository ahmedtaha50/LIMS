-- 0140_api_v1: the machine integration API, /api/v1 (roadmap M22, r2-api-v1).
--
-- What this adds, and why:
--   api_clients            one row per API client (an instrument, a chromatography data system, a middleware). A client authenticates with
--                          a bearer token of its own; only the SHA-256 of the token is stored (token_hash), with its public prefix
--                          (token_prefix) so an Administrator can tell tokens apart. Each client has its own service account (user_id: a
--                          users row with role 'Instrument', no e-mail and no password, so it cannot sign in and holds no permission of the
--                          interactive API), and every record the client writes is attributed to that account in the audit trail
--                          (21 CFR 11.10(e), ALCOA+ attributable). What a client may do is its scopes; when the client is bound to an
--                          instrument (instrument_id), the results it writes are measured on that instrument. Expiry is mandatory.
--                          Created and revoked by an Administrator with an e-signature (ADMIN_AUTHORISATION on record type ApiClient),
--                          bound to `version`; revocation is final (status 'Revoked' with its time, signer and reason).
--   api_idempotency_keys   the stored answer of each successful write made with an Idempotency-Key, per client, so a retried call writes
--                          nothing twice (a lost answer on a network is the normal case for an instrument). Written in the transaction
--                          of the write.
--
-- No existing table is changed, no row is written, and no permission or signature meaning is added: managing API clients uses the
-- existing admin.integrations.view / admin.integrations.manage permissions and the existing ADMIN_AUTHORISATION meaning.

CREATE TABLE "api_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"user_id" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"instrument_id" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "api_clients_status_check" CHECK ("api_clients"."status" IN ('Active', 'Revoked')),
	CONSTRAINT "api_clients_revoked_check" CHECK (("api_clients"."status" = 'Revoked') = ("api_clients"."revoked_at" IS NOT NULL)),
	CONSTRAINT "api_clients_scopes_check" CHECK (jsonb_typeof("api_clients"."scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_token_hash_uidx" ON "api_clients" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_token_prefix_uidx" ON "api_clients" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_name_lower_uidx" ON "api_clients" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_user_id_uidx" ON "api_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_clients_instrument_id_idx" ON "api_clients" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "api_clients_created_by_idx" ON "api_clients" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "api_clients_revoked_by_idx" ON "api_clients" USING btree ("revoked_by");--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_keys_client_id_key_uidx" ON "api_idempotency_keys" USING btree ("client_id","key");--> statement-breakpoint
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys" USING btree ("created_at");
