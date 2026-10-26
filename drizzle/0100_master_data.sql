-- 0100_master_data: products, product batches, customers and the sample_context sidecar (roadmap M17, r2-master-data).
--
-- What this adds, and why:
--   products, product_batches, customers   master data that specifications, samples, the CoA and stability refer to. Before, the
--                                          material and the batch were free text typed at registration, with no manufacturing or
--                                          expiry date and no customer.
--   sample_context                         1:1 sidecar of samples: the product, batch and customer ids a sample was registered
--                                          against. The samples table is not touched: its material and batch text columns feed the
--                                          signed hashes, so registration keeps filling them (from the master rows) and every
--                                          existing signature verifies as before. Append-only (triggers below).
--   signature_meanings + MASTER_DATA_STATUS   the meaning of the e-signature that changes the status of a product or a batch.
--   permissions + master.view, master.manage, master.status, and their grants (src/lib/permissions.ts, positions 59 to 61).
--
-- Backfill (existing data only; nothing is rewritten):
--   * one product per material key (lower case, trimmed, runs of spaces collapsed: src/server/lib/specs.ts materialKey) found in
--     specifications or samples. Its name and code are the spelling of the Active specification with the latest effective date (else
--     of any specification, latest effective date first), else of the first sample. Only columns of the v0.1.0 baseline are read, so
--     the file runs whatever other migrations are present.
--   * one batch per (product, samples.batch) found in samples, with the exact text of samples.batch. Status Released or Rejected when
--     batch_releases holds that word for the batch number, otherwise Quarantine. Dates and size are unknown (NULL).
--   * one sample_context row per sample, without a customer.
--   Backfilled rows have origin 'migration', created_by NULL and created_at the time of this run: the SCHEMA_MIGRATED audit entry of
--   this run (with this file's checksum) is their record. The run aborts if any sample is left without a context (zero orphans).
--   A restore replays this file into an EMPTY database: the backfill then selects nothing, and the seeded constants are written only
--   under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040 and 0070.

CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"origin" text DEFAULT 'entry' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_code_unique" UNIQUE("code"),
	CONSTRAINT "products_status_check" CHECK ("products"."status" IN ('Active', 'Inactive'))
);

CREATE TABLE "product_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"batch_no" text NOT NULL,
	"status" text DEFAULT 'Quarantine' NOT NULL,
	"manufactured_on" text,
	"expires_on" text,
	"batch_size" text,
	"origin" text DEFAULT 'entry' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_batches_status_check" CHECK ("product_batches"."status" IN ('Quarantine', 'Released', 'Rejected', 'Recalled'))
);

CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customers_status_check" CHECK ("customers"."status" IN ('Active', 'Inactive'))
);

CREATE TABLE "sample_context" (
	"sample_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"customer_id" text,
	"origin" text DEFAULT 'registration' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_context" ADD CONSTRAINT "sample_context_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_context" ADD CONSTRAINT "sample_context_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_context" ADD CONSTRAINT "sample_context_batch_id_product_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."product_batches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_context" ADD CONSTRAINT "sample_context_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sample_context" ADD CONSTRAINT "sample_context_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "products_name_lower_uidx" ON "products" USING btree (lower("name"));
CREATE INDEX "products_created_by_idx" ON "products" USING btree ("created_by");
CREATE UNIQUE INDEX "product_batches_product_batch_uidx" ON "product_batches" USING btree ("product_id","batch_no");
CREATE INDEX "product_batches_batch_no_idx" ON "product_batches" USING btree ("batch_no");
CREATE INDEX "product_batches_created_by_idx" ON "product_batches" USING btree ("created_by");
CREATE UNIQUE INDEX "customers_code_lower_uidx" ON "customers" USING btree (lower("code"));
CREATE INDEX "customers_created_by_idx" ON "customers" USING btree ("created_by");
CREATE INDEX "sample_context_product_id_idx" ON "sample_context" USING btree ("product_id");
CREATE INDEX "sample_context_batch_id_idx" ON "sample_context" USING btree ("batch_id");
CREATE INDEX "sample_context_customer_id_idx" ON "sample_context" USING btree ("customer_id");
CREATE INDEX "sample_context_created_by_idx" ON "sample_context" USING btree ("created_by");

-- ---- backfill ------------------------------------------------------------------------------------------------------------------

INSERT INTO "products" ("id", "code", "name", "status", "origin")
SELECT DISTINCT ON (m.key) 'PRD-' || upper(substr(md5(m.key), 1, 12)), m.name, m.name, 'Active', 'migration'
FROM (
	SELECT lower(btrim(regexp_replace("material", '\s+', ' ', 'g'))) AS key, btrim("material") AS name, 0 AS src,
		CASE "status" WHEN 'Active' THEN 0 ELSE 1 END AS rank, "effective_date" AS ord, "id" AS tiebreak
	FROM "specifications"
	UNION ALL
	SELECT lower(btrim(regexp_replace("material", '\s+', ' ', 'g'))), btrim("material"), 1, 0, to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), "id"
	FROM "samples"
) AS m
ORDER BY m.key, m.src, m.rank, CASE WHEN m.src = 0 THEN m.ord END DESC, CASE WHEN m.src = 1 THEN m.ord END ASC, m.tiebreak;

INSERT INTO "product_batches" ("id", "product_id", "batch_no", "status", "origin")
SELECT DISTINCT ON (p."id", s."batch")
	'PB-' || upper(substr(md5(p."id" || '|' || s."batch"), 1, 12)), p."id", s."batch",
	CASE r."status" WHEN 'Released' THEN 'Released' WHEN 'Rejected' THEN 'Rejected' ELSE 'Quarantine' END,
	'migration'
FROM "samples" s
JOIN "products" p ON lower(btrim(regexp_replace(p."name", '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(s."material", '\s+', ' ', 'g')))
LEFT JOIN "batch_releases" r ON r."batch" = s."batch"
ORDER BY p."id", s."batch";

INSERT INTO "sample_context" ("sample_id", "product_id", "batch_id", "origin")
SELECT s."id", p."id", b."id", 'migration'
FROM "samples" s
JOIN "products" p ON lower(btrim(regexp_replace(p."name", '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(s."material", '\s+', ' ', 'g')))
JOIN "product_batches" b ON b."product_id" = p."id" AND b."batch_no" = s."batch";

DO $$
DECLARE
	orphans integer;
BEGIN
	SELECT count(*) INTO orphans FROM "samples" s WHERE NOT EXISTS (SELECT 1 FROM "sample_context" c WHERE c."sample_id" = s."id");
	IF orphans > 0 THEN
		RAISE EXCEPTION '0100_master_data: % sample(s) could not be mapped to a product and a batch; nothing was changed', orphans;
	END IF;
END $$;

-- ---- the sidecar is append-only ------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;
CREATE TRIGGER gxp_sample_context_row_guard BEFORE UPDATE OR DELETE ON sample_context FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
CREATE TRIGGER gxp_sample_context_truncate_guard BEFORE TRUNCATE ON sample_context FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- catalog rows (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('MASTER_DATA_STATUS', 'Master data status decision: I have reviewed this product or batch record and authorise the change of its status.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('master.view', 'Master data', 'Read products, batches and customers', 59),
	('master.manage', 'Master data', 'Create and edit products, batches and customers', 60),
	('master.status', 'Master data', 'Change the status of a product or a batch with an e-signature', 61)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'master.view'),
	('role-admin', 'master.manage'),
	('role-admin', 'master.status'),
	('role-qa', 'master.view'),
	('role-qa', 'master.manage'),
	('role-qa', 'master.status'),
	('role-reviewer', 'master.view'),
	('role-analyst', 'master.view')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
