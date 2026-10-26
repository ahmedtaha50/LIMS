-- 0150_events: transactional outbox, persistent notifications and outbound subscriptions (roadmap M23, r2-events).
--
-- What this adds, and why:
--   outbox_events         one row per business event of the catalog (src/server/events/catalog.ts: result.oos_detected,
--                         batch.released, instrument.calibration_due, system.alert, each with a version). Written by emitEvent() in the
--                         SAME transaction as the change that caused it, so a change that rolls back leaves no event and nothing is
--                         announced that did not happen (the old code emitted the OOS socket message inside the result transaction, to
--                         every socket). The dispatcher claims unprocessed rows with FOR UPDATE SKIP LOCKED and fans each out once
--                         (fanned_out_at). Payloads are validated by strict schemas and never hold a result value.
--   notifications         the persistent per-user notification of an event, for every active user whose role holds the event's
--                         audience permission when it is fanned out, so a user who was not signed in sees it at the next sign-in.
--                         Notifications are not GxP records and never replace a signature; read_at is the user's own state.
--   event_subscriptions   outbound sinks configured by an Administrator: webhook (HMAC-SHA256 signed with the subscription's secret,
--                         stored as keystore ciphertext; the destination must pass the SSRF guard and the LAN allow-list), e-mail
--                         (SMTP) or a folder under the drop directory (atomic file drop for an ERP). Created, disabled and re-enabled
--                         with an e-signature (ADMIN_AUTHORISATION on record type EventSubscription) bound to `version`. A
--                         subscription's sink, target, event types and secret never change after creation (a new one is created).
--   event_deliveries      one row per (event, subscription): attempts (at most max_attempts: the first try and 5 retries with
--                         back-off), then dead letter; an Administrator can requeue a dead delivery (audited). `version` counts changes.
--
-- No existing table is changed, no row is written, and no permission or signature meaning is added: managing subscriptions uses the
-- existing admin.integrations.view / admin.integrations.manage permissions and the existing ADMIN_AUTHORISATION meaning; reading one's
-- own notifications needs no permission.

CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"type_version" integer NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"audience" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp with time zone,
	CONSTRAINT "outbox_events_payload_check" CHECK (jsonb_typeof("outbox_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"sink" text NOT NULL,
	"target" text NOT NULL,
	"secret_enc" text,
	"secret_fingerprint" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "event_subscriptions_sink_check" CHECK ("event_subscriptions"."sink" IN ('webhook', 'email', 'file')),
	CONSTRAINT "event_subscriptions_status_check" CHECK ("event_subscriptions"."status" IN ('Active', 'Disabled')),
	CONSTRAINT "event_subscriptions_event_types_check" CHECK (jsonb_typeof("event_subscriptions"."event_types") = 'array'),
	CONSTRAINT "event_subscriptions_secret_check" CHECK (("event_subscriptions"."sink" = 'webhook') = ("event_subscriptions"."secret_enc" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "event_deliveries_status_check" CHECK ("event_deliveries"."status" IN ('pending', 'sending', 'delivered', 'dead'))
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."fanned_out_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_actor_id_idx" ON "outbox_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_id_event_id_uidx" ON "notifications" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_event_id_idx" ON "notifications" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_subscriptions_name_lower_uidx" ON "event_subscriptions" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "event_subscriptions_created_by_idx" ON "event_subscriptions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "event_subscriptions_updated_by_idx" ON "event_subscriptions" USING btree ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "event_deliveries_event_id_subscription_id_uidx" ON "event_deliveries" USING btree ("event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "event_deliveries_due_idx" ON "event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_subscription_id_idx" ON "event_deliveries" USING btree ("subscription_id");
