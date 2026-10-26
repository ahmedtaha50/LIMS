-- 0220_custody: sample receipt, chain of custody, storage, aliquots, retains and labels (roadmap M29, r2-custody-labels; 21 CFR
-- 211.122-211.194, EU GMP Chapter 6). A custody status parallel to the sample state: SampleState and the samples table are unchanged.
--
-- What this adds, and why:
--   storage_locations   the location tree (Site > Building > Room > Storage unit > Shelf > Box) with an optional temperature range.
--   sample_custody      the receipt of a sample (1:1 sidecar): received when and by whom, condition, seal, temperature measured on
--                       receipt against the required storage, manufacturing and expiry dates. A temperature outside the required range,
--                       a broken seal or a condition other than Intact sets the receipt deviation, which blocks Logged -> Testing until QA
--                       acknowledges it with an e-signature (CUSTODY_DEVIATION_ACK). The guard is src/server/workflow/guards/custody.ts.
--   sample_containers   the primary container made at receipt and its aliquots (parent_id: child lineage), with the current balance,
--                       location and holder. The balance is always the last balance of the container in the ledger.
--   custody_events      THE CUSTODY LEDGER. One row per receipt, aliquot (out of the parent, into the child), transfer of place or holder,
--                       consumption, retain registration and disposal. Hash-linked (prev_hash, hash; seq is gap-free), append-only
--                       (UPDATE, DELETE and TRUNCATE refused), and the database checks the arithmetic: balance_after must equal the
--                       container's previous balance plus qty_delta, and is never negative.
--   sample_retains      the retain register: a container kept until retain_until, then disposed of with an e-signature (RETAIN_DISPOSAL).
--   label_prints        every label printed (Code 128 or QR), hash-linked and append-only. A reprint carries its reason (CHECK).
--   signature_meanings  CUSTODY_DEVIATION_ACK, RETAIN_DISPOSAL (QA and Admin, reason required).
--   permissions         custody.view, custody.handle, label.print (every role), custody.locations, custody.approve (QA and Admin),
--                       positions 220 to 224.
--
-- Record ids that other rows of the same table point at (locations, containers) and the ledger ids are numbered from counters
-- (LOC-000001, CTN-000001, CE-000000001, LBL-000000001), so a backup, read in primary-key order, restores parents before children and
-- the ledger in chain order.
--
-- The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040 and 0210, because a restore
-- replays this file into an EMPTY database.

CREATE TABLE "storage_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" text,
	"temp_min" real,
	"temp_max" real,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "storage_locations_kind_check" CHECK ("storage_locations"."kind" IN ('Site', 'Building', 'Room', 'Storage unit', 'Shelf', 'Box')),
	CONSTRAINT "storage_locations_status_check" CHECK ("storage_locations"."status" IN ('Active', 'Inactive')),
	CONSTRAINT "storage_locations_temp_check" CHECK ("storage_locations"."temp_min" IS NULL OR "storage_locations"."temp_max" IS NULL OR "storage_locations"."temp_min" <= "storage_locations"."temp_max")
);

CREATE TABLE "sample_custody" (
	"sample_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"received_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"condition" text NOT NULL,
	"seal_intact" boolean NOT NULL,
	"temperature_c" real,
	"required_storage" text NOT NULL,
	"required_temp_min" real,
	"required_temp_max" real,
	"mfg_date" text,
	"exp_date" text,
	"notes" text,
	"deviation" boolean DEFAULT false NOT NULL,
	"deviation_reasons" text,
	"deviation_ack_by" text,
	"deviation_ack_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sample_custody_condition_check" CHECK ("sample_custody"."condition" IN ('Intact', 'Damaged', 'Leaking', 'Contaminated')),
	CONSTRAINT "sample_custody_required_temp_check" CHECK ("sample_custody"."required_temp_min" IS NULL OR "sample_custody"."required_temp_max" IS NULL OR "sample_custody"."required_temp_min" <= "sample_custody"."required_temp_max"),
	CONSTRAINT "sample_custody_deviation_check" CHECK ("sample_custody"."deviation" OR ("sample_custody"."deviation_ack_by" IS NULL AND "sample_custody"."deviation_ack_at" IS NULL))
);

CREATE TABLE "sample_containers" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"parent_id" text,
	"kind" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"location_id" text,
	"holder_id" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sample_containers_kind_check" CHECK ("sample_containers"."kind" IN ('Primary', 'Aliquot')),
	CONSTRAINT "sample_containers_status_check" CHECK ("sample_containers"."status" IN ('Active', 'Empty', 'Disposed')),
	CONSTRAINT "sample_containers_quantity_check" CHECK ("sample_containers"."quantity" >= 0)
);

CREATE TABLE "custody_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"container_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"event_type" text NOT NULL,
	"qty_delta" numeric(14, 4) NOT NULL,
	"balance_after" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"from_location_id" text,
	"to_location_id" text,
	"from_holder_id" text,
	"to_holder_id" text,
	"related_container_id" text,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "custody_events_type_check" CHECK ("custody_events"."event_type" IN ('Receipt', 'Aliquot out', 'Aliquot in', 'Transfer', 'Consume', 'Retain', 'Dispose')),
	CONSTRAINT "custody_events_balance_check" CHECK ("custody_events"."balance_after" >= 0)
);

CREATE TABLE "sample_retains" (
	"id" text PRIMARY KEY NOT NULL,
	"sample_id" text NOT NULL,
	"container_id" text NOT NULL,
	"retain_until" text NOT NULL,
	"status" text DEFAULT 'Retained' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disposed_by" text,
	"disposed_at" timestamp with time zone,
	"disposal_method" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sample_retains_status_check" CHECK ("sample_retains"."status" IN ('Retained', 'Disposed')),
	CONSTRAINT "sample_retains_disposed_check" CHECK (("sample_retains"."status" = 'Disposed') = ("sample_retains"."disposed_at" IS NOT NULL AND "sample_retains"."disposed_by" IS NOT NULL AND "sample_retains"."disposal_method" IS NOT NULL))
);

CREATE TABLE "label_prints" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"code" text NOT NULL,
	"symbology" text NOT NULL,
	"copies" integer NOT NULL,
	"is_reprint" boolean NOT NULL,
	"reason" text,
	"printed_by" text NOT NULL,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "label_prints_entity_type_check" CHECK ("label_prints"."entity_type" IN ('Sample', 'Container', 'Location')),
	CONSTRAINT "label_prints_symbology_check" CHECK ("label_prints"."symbology" IN ('code128', 'qr')),
	CONSTRAINT "label_prints_copies_check" CHECK ("label_prints"."copies" BETWEEN 1 AND 50),
	CONSTRAINT "label_prints_reprint_reason_check" CHECK (NOT "label_prints"."is_reprint" OR length(btrim(coalesce("label_prints"."reason", ''))) >= 5)
);

ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_parent_id_storage_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_custody" ADD CONSTRAINT "sample_custody_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_custody" ADD CONSTRAINT "sample_custody_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_custody" ADD CONSTRAINT "sample_custody_deviation_ack_by_users_id_fk" FOREIGN KEY ("deviation_ack_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_containers" ADD CONSTRAINT "sample_containers_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_containers" ADD CONSTRAINT "sample_containers_parent_id_sample_containers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sample_containers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_containers" ADD CONSTRAINT "sample_containers_location_id_storage_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_containers" ADD CONSTRAINT "sample_containers_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_containers" ADD CONSTRAINT "sample_containers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_container_id_sample_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."sample_containers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_from_location_id_storage_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_to_location_id_storage_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_from_holder_id_users_id_fk" FOREIGN KEY ("from_holder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_to_holder_id_users_id_fk" FOREIGN KEY ("to_holder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_related_container_id_sample_containers_id_fk" FOREIGN KEY ("related_container_id") REFERENCES "public"."sample_containers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_retains" ADD CONSTRAINT "sample_retains_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_retains" ADD CONSTRAINT "sample_retains_container_id_sample_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."sample_containers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_retains" ADD CONSTRAINT "sample_retains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_retains" ADD CONSTRAINT "sample_retains_disposed_by_users_id_fk" FOREIGN KEY ("disposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_printed_by_users_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "storage_locations_code_lower_uidx" ON "storage_locations" USING btree (lower("code"));
CREATE INDEX "storage_locations_parent_id_idx" ON "storage_locations" USING btree ("parent_id");
CREATE INDEX "storage_locations_created_by_idx" ON "storage_locations" USING btree ("created_by");
CREATE INDEX "sample_custody_received_by_idx" ON "sample_custody" USING btree ("received_by");
CREATE INDEX "sample_custody_deviation_ack_by_idx" ON "sample_custody" USING btree ("deviation_ack_by");
CREATE INDEX "sample_containers_sample_id_idx" ON "sample_containers" USING btree ("sample_id");
CREATE INDEX "sample_containers_parent_id_idx" ON "sample_containers" USING btree ("parent_id");
CREATE INDEX "sample_containers_location_id_idx" ON "sample_containers" USING btree ("location_id");
CREATE INDEX "sample_containers_holder_id_idx" ON "sample_containers" USING btree ("holder_id");
CREATE INDEX "sample_containers_created_by_idx" ON "sample_containers" USING btree ("created_by");
CREATE UNIQUE INDEX "custody_events_seq_uidx" ON "custody_events" USING btree ("seq");
CREATE INDEX "custody_events_container_id_idx" ON "custody_events" USING btree ("container_id");
CREATE INDEX "custody_events_sample_id_idx" ON "custody_events" USING btree ("sample_id");
CREATE INDEX "custody_events_from_location_id_idx" ON "custody_events" USING btree ("from_location_id");
CREATE INDEX "custody_events_to_location_id_idx" ON "custody_events" USING btree ("to_location_id");
CREATE INDEX "custody_events_from_holder_id_idx" ON "custody_events" USING btree ("from_holder_id");
CREATE INDEX "custody_events_to_holder_id_idx" ON "custody_events" USING btree ("to_holder_id");
CREATE INDEX "custody_events_related_container_id_idx" ON "custody_events" USING btree ("related_container_id");
CREATE INDEX "custody_events_actor_id_idx" ON "custody_events" USING btree ("actor_id");
CREATE UNIQUE INDEX "sample_retains_container_id_uidx" ON "sample_retains" USING btree ("container_id");
CREATE INDEX "sample_retains_sample_id_idx" ON "sample_retains" USING btree ("sample_id");
CREATE INDEX "sample_retains_created_by_idx" ON "sample_retains" USING btree ("created_by");
CREATE INDEX "sample_retains_disposed_by_idx" ON "sample_retains" USING btree ("disposed_by");
CREATE UNIQUE INDEX "label_prints_seq_uidx" ON "label_prints" USING btree ("seq");
CREATE INDEX "label_prints_entity_idx" ON "label_prints" USING btree ("entity_type","entity_id");
CREATE INDEX "label_prints_printed_by_idx" ON "label_prints" USING btree ("printed_by");

-- ---- the ledger's arithmetic, and the append-only ledgers (the same statements as src/db/protections/custody.ts) ---------------

CREATE OR REPLACE FUNCTION gxp_custody_balance() RETURNS trigger AS $$
    DECLARE previous numeric;
    BEGIN
      SELECT e.balance_after INTO previous FROM custody_events e WHERE e.container_id = NEW.container_id ORDER BY e.seq DESC LIMIT 1;
      IF NEW.balance_after IS DISTINCT FROM coalesce(previous, 0) + NEW.qty_delta THEN
        RAISE EXCEPTION 'GxP: the custody balance of % does not follow from its ledger (% + % is not %)', NEW.container_id, coalesce(previous, 0), NEW.qty_delta, NEW.balance_after
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_custody_events_balance_guard BEFORE INSERT ON custody_events FOR EACH ROW EXECUTE FUNCTION gxp_custody_balance();
CREATE TRIGGER gxp_custody_events_row_guard BEFORE UPDATE OR DELETE ON custody_events FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_custody_events_truncate_guard BEFORE TRUNCATE ON custody_events FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_label_prints_row_guard BEFORE UPDATE OR DELETE ON label_prints FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_label_prints_truncate_guard BEFORE TRUNCATE ON label_prints FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('CUSTODY_DEVIATION_ACK', 'Receipt deviation acknowledgement: I have assessed the condition of this sample on receipt and I accept it for testing.', ARRAY['QA','Admin'], true, false),
	('RETAIN_DISPOSAL', 'Disposal of a retained sample: I confirm that its retention period has ended and I authorise its disposal.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('custody.view', 'Custody', 'Read sample receipts, containers, the custody ledger, storage locations, the retain register and the label log', 220),
	('custody.handle', 'Custody', 'Record a sample receipt, make aliquots, transfer, consume and register retains', 221),
	('custody.locations', 'Custody', 'Define and change storage locations', 222),
	('custody.approve', 'Custody', 'Acknowledge a receipt deviation and dispose of a retained sample with an e-signature', 223),
	('label.print', 'Custody', 'Print sample, container and location labels (a reprint needs a reason)', 224)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'custody.view'), ('role-admin', 'custody.handle'), ('role-admin', 'custody.locations'), ('role-admin', 'custody.approve'), ('role-admin', 'label.print'),
	('role-qa', 'custody.view'), ('role-qa', 'custody.handle'), ('role-qa', 'custody.locations'), ('role-qa', 'custody.approve'), ('role-qa', 'label.print'),
	('role-reviewer', 'custody.view'), ('role-reviewer', 'custody.handle'), ('role-reviewer', 'label.print'),
	('role-analyst', 'custody.view'), ('role-analyst', 'custody.handle'), ('role-analyst', 'label.print')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
