-- 0230_reagents: reagents, reference standards and prepared solutions, with their consumption and their use on results (roadmap M30,
-- r2-reagents; 21 CFR 211.160(b)(4), 211.194(a)(2), 211.84, 211.87). The v0.1.0 table "reagents" is not changed and none of its rows is
-- touched: it stays as the legacy register (read only on the screen; nothing links a result to it).
--
-- What this adds, and why:
--   reagent_items                 the item master: code (unique ignoring case), name, category, grade, stock unit, storage, the in-use shelf
--                                 life after opening, and whether a potency must be stated at receipt (reference standards).
--   reagent_lots                  one received lot. Received into Quarantine with an e-signature (RECEIPT); released for use by a second
--                                 person (REAGENT_LOT_RELEASE, never the receiver) or rejected (REAGENT_LOT_REJECTION); opened, which sets
--                                 in_use_expiry = min(expiry_date, opening day + in-use shelf life); retested (REAGENT_LOT_RETEST, a new
--                                 retest date); then Consumed (balance 0), Disposed, Expired (scheduled job reagents.expiry) or Rejected.
--                                 The receipt fields never change, the status only moves forward and a final status freezes the row
--                                 (trigger gxp_reagent_lots_row_guard). Potency carries its basis (CHECK: both or neither).
--   prepared_solutions            a solution made in the laboratory; its expiry may not be later than any parent's (lot: expiry and
--                                 in-use expiry; solution: expiry), checked by the application and by trigger
--                                 gxp_prepared_solution_components_expiry_guard; what was prepared never changes.
--   prepared_solution_components  the lots and solutions a solution was made from and how much of each (append-only).
--   reagent_transactions          THE CONSUMPTION LEDGER: one row per receipt, preparation, consumption, use on a result and disposal,
--                                 with the running balance of the lot or solution. Append-only (UPDATE, DELETE and TRUNCATE refused), the
--                                 balance is never negative (CHECK) and must follow from the previous row (trigger
--                                 gxp_reagent_transactions_balance_guard). seq comes from the gap-free counter reagent_tx.
--   result_materials              the usage-to-result link: which lot or solution a result was measured with, at which result version, by
--                                 whom. Never deleted; a wrong link is withdrawn once, with a reason (trigger gxp_result_materials_row_guard).
--                                 The result guard reagent-lots (src/server/services/result-guards/reagent.ts) refuses to save a result
--                                 while one of its materials is expired, past its retest date, in quarantine, rejected or used up.
--   signature_meanings            REAGENT_LOT_RELEASE, REAGENT_LOT_REJECTION and REAGENT_LOT_RETEST (QA and Admin; the last two with a reason).
--   permissions                   reagent.manage (item master: QA, Reviewer, Admin), reagent.use (open, consume, prepare, link to results:
--                                 every role), reagent.approve (release, reject, retest: QA and Admin), positions 230 to 232.
--
-- Lots, solutions and ledger rows are numbered from counters (RL-000001, PS-000001, RTX-000000001), so a backup, read in primary-key
-- order, restores the ledger in its own order and the balance trigger accepts every row again.
--
-- The constants are written only under the migration runner (WHERE EXISTS schema_migrations), like 0020, 0040 and 0210, because a restore
-- replays this file into an EMPTY database.

CREATE TABLE "reagent_items" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"grade" text,
	"unit" text NOT NULL,
	"storage_condition" text,
	"in_use_shelf_life_days" integer,
	"requires_potency" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reagent_items_category_check" CHECK ("reagent_items"."category" IN ('Reagent', 'ReferenceStandard', 'WorkingStandard', 'Solvent', 'Medium', 'Other')),
	CONSTRAINT "reagent_items_status_check" CHECK ("reagent_items"."status" IN ('Active', 'Inactive')),
	CONSTRAINT "reagent_items_shelf_life_check" CHECK ("reagent_items"."in_use_shelf_life_days" IS NULL OR "reagent_items"."in_use_shelf_life_days" BETWEEN 1 AND 3650)
);

CREATE TABLE "reagent_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"lot_number" text NOT NULL,
	"supplier" text NOT NULL,
	"coa_reference" text,
	"received_quantity" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"expiry_date" text NOT NULL,
	"retest_date" text,
	"potency" numeric(10, 4),
	"potency_basis" text,
	"storage_location" text,
	"status" text DEFAULT 'Quarantine' NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	"opened_by" text,
	"opened_at" timestamp with time zone,
	"in_use_expiry" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reagent_lots_status_check" CHECK ("reagent_lots"."status" IN ('Quarantine', 'Approved', 'InUse', 'Consumed', 'Disposed', 'Expired', 'Rejected')),
	CONSTRAINT "reagent_lots_quantity_check" CHECK ("reagent_lots"."received_quantity" > 0),
	CONSTRAINT "reagent_lots_dates_check" CHECK ("reagent_lots"."expiry_date" ~ '^\d{4}-\d{2}-\d{2}$' AND ("reagent_lots"."retest_date" IS NULL OR ("reagent_lots"."retest_date" ~ '^\d{4}-\d{2}-\d{2}$' AND "reagent_lots"."retest_date" <= "reagent_lots"."expiry_date"))),
	CONSTRAINT "reagent_lots_in_use_expiry_check" CHECK ("reagent_lots"."in_use_expiry" IS NULL OR ("reagent_lots"."in_use_expiry" ~ '^\d{4}-\d{2}-\d{2}$' AND "reagent_lots"."in_use_expiry" <= "reagent_lots"."expiry_date")),
	CONSTRAINT "reagent_lots_potency_check" CHECK (("reagent_lots"."potency" IS NULL) = ("reagent_lots"."potency_basis" IS NULL) AND ("reagent_lots"."potency" IS NULL OR "reagent_lots"."potency" > 0)),
	CONSTRAINT "reagent_lots_potency_basis_check" CHECK ("reagent_lots"."potency_basis" IS NULL OR "reagent_lots"."potency_basis" IN ('As is', 'Dried basis', 'Anhydrous basis', 'Solvent-free basis'))
);

CREATE TABLE "prepared_solutions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"concentration" text,
	"preparation" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"expiry_date" text NOT NULL,
	"storage_condition" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"prepared_by" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "prepared_solutions_status_check" CHECK ("prepared_solutions"."status" IN ('Active', 'Consumed', 'Discarded', 'Expired')),
	CONSTRAINT "prepared_solutions_quantity_check" CHECK ("prepared_solutions"."quantity" > 0),
	CONSTRAINT "prepared_solutions_expiry_check" CHECK ("prepared_solutions"."expiry_date" ~ '^\d{4}-\d{2}-\d{2}$')
);

CREATE TABLE "reagent_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"lot_id" text,
	"solution_id" text,
	"tx_type" text NOT NULL,
	"qty_delta" numeric(14, 4) NOT NULL,
	"balance_after" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"result_id" text,
	"into_solution_id" text,
	"reason" text NOT NULL,
	"performed_by" text NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reagent_transactions_holder_check" CHECK (("reagent_transactions"."lot_id" IS NULL) <> ("reagent_transactions"."solution_id" IS NULL)),
	CONSTRAINT "reagent_transactions_type_check" CHECK ("reagent_transactions"."tx_type" IN ('Receipt', 'Prepared', 'Consumed', 'Used', 'Disposed')),
	CONSTRAINT "reagent_transactions_sign_check" CHECK (("reagent_transactions"."tx_type" IN ('Receipt', 'Prepared') AND "reagent_transactions"."qty_delta" > 0) OR ("reagent_transactions"."tx_type" IN ('Consumed', 'Used', 'Disposed') AND "reagent_transactions"."qty_delta" < 0)),
	CONSTRAINT "reagent_transactions_balance_check" CHECK ("reagent_transactions"."balance_after" >= 0)
);

CREATE TABLE "prepared_solution_components" (
	"id" text PRIMARY KEY NOT NULL,
	"solution_id" text NOT NULL,
	"lot_id" text,
	"parent_solution_id" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"transaction_id" text NOT NULL,
	CONSTRAINT "prepared_solution_components_parent_check" CHECK (("prepared_solution_components"."lot_id" IS NULL) <> ("prepared_solution_components"."parent_solution_id" IS NULL)),
	CONSTRAINT "prepared_solution_components_quantity_check" CHECK ("prepared_solution_components"."quantity" > 0)
);

CREATE TABLE "result_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"lot_id" text,
	"solution_id" text,
	"quantity" numeric(14, 4),
	"transaction_id" text,
	"result_version" integer NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" text,
	"withdrawn_at" timestamp with time zone,
	"withdraw_reason" text,
	CONSTRAINT "result_materials_material_check" CHECK (("result_materials"."lot_id" IS NULL) <> ("result_materials"."solution_id" IS NULL)),
	CONSTRAINT "result_materials_quantity_check" CHECK ("result_materials"."quantity" IS NULL OR "result_materials"."quantity" > 0),
	CONSTRAINT "result_materials_withdrawal_check" CHECK (("result_materials"."withdrawn_at" IS NULL) = ("result_materials"."withdrawn_by" IS NULL) AND ("result_materials"."withdrawn_at" IS NULL) = ("result_materials"."withdraw_reason" IS NULL))
);

ALTER TABLE "reagent_items" ADD CONSTRAINT "reagent_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_lots" ADD CONSTRAINT "reagent_lots_item_id_reagent_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."reagent_items"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_lots" ADD CONSTRAINT "reagent_lots_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_lots" ADD CONSTRAINT "reagent_lots_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_lots" ADD CONSTRAINT "reagent_lots_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_lots" ADD CONSTRAINT "reagent_lots_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solutions" ADD CONSTRAINT "prepared_solutions_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solutions" ADD CONSTRAINT "prepared_solutions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_transactions" ADD CONSTRAINT "reagent_transactions_lot_id_reagent_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."reagent_lots"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_transactions" ADD CONSTRAINT "reagent_transactions_solution_id_prepared_solutions_id_fk" FOREIGN KEY ("solution_id") REFERENCES "public"."prepared_solutions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_transactions" ADD CONSTRAINT "reagent_transactions_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_transactions" ADD CONSTRAINT "reagent_transactions_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reagent_transactions" ADD CONSTRAINT "reagent_transactions_into_solution_id_fk" FOREIGN KEY ("into_solution_id") REFERENCES "public"."prepared_solutions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solution_components" ADD CONSTRAINT "prepared_solution_components_lot_id_reagent_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."reagent_lots"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solution_components" ADD CONSTRAINT "prepared_solution_components_solution_id_fk" FOREIGN KEY ("solution_id") REFERENCES "public"."prepared_solutions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solution_components" ADD CONSTRAINT "prepared_solution_components_parent_solution_id_fk" FOREIGN KEY ("parent_solution_id") REFERENCES "public"."prepared_solutions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prepared_solution_components" ADD CONSTRAINT "prepared_solution_components_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."reagent_transactions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_lot_id_reagent_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."reagent_lots"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_solution_id_prepared_solutions_id_fk" FOREIGN KEY ("solution_id") REFERENCES "public"."prepared_solutions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_transaction_id_reagent_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."reagent_transactions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "result_materials" ADD CONSTRAINT "result_materials_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "reagent_items_code_lower_uidx" ON "reagent_items" USING btree (lower("code"));
CREATE INDEX "reagent_items_created_by_idx" ON "reagent_items" USING btree ("created_by");
CREATE INDEX "reagent_lots_item_id_idx" ON "reagent_lots" USING btree ("item_id");
CREATE INDEX "reagent_lots_status_idx" ON "reagent_lots" USING btree ("status");
CREATE INDEX "reagent_lots_received_by_idx" ON "reagent_lots" USING btree ("received_by");
CREATE INDEX "reagent_lots_released_by_idx" ON "reagent_lots" USING btree ("released_by");
CREATE INDEX "reagent_lots_opened_by_idx" ON "reagent_lots" USING btree ("opened_by");
CREATE INDEX "reagent_lots_closed_by_idx" ON "reagent_lots" USING btree ("closed_by");
CREATE INDEX "prepared_solutions_status_idx" ON "prepared_solutions" USING btree ("status");
CREATE INDEX "prepared_solutions_prepared_by_idx" ON "prepared_solutions" USING btree ("prepared_by");
CREATE INDEX "prepared_solutions_closed_by_idx" ON "prepared_solutions" USING btree ("closed_by");
CREATE UNIQUE INDEX "reagent_transactions_seq_uidx" ON "reagent_transactions" USING btree ("seq");
CREATE INDEX "reagent_transactions_lot_id_idx" ON "reagent_transactions" USING btree ("lot_id","seq");
CREATE INDEX "reagent_transactions_solution_id_idx" ON "reagent_transactions" USING btree ("solution_id","seq");
CREATE INDEX "reagent_transactions_result_id_idx" ON "reagent_transactions" USING btree ("result_id");
CREATE INDEX "reagent_transactions_into_solution_id_idx" ON "reagent_transactions" USING btree ("into_solution_id");
CREATE INDEX "reagent_transactions_performed_by_idx" ON "reagent_transactions" USING btree ("performed_by");
CREATE INDEX "prepared_solution_components_solution_id_idx" ON "prepared_solution_components" USING btree ("solution_id");
CREATE INDEX "prepared_solution_components_lot_id_idx" ON "prepared_solution_components" USING btree ("lot_id");
CREATE INDEX "prepared_solution_components_parent_solution_id_idx" ON "prepared_solution_components" USING btree ("parent_solution_id");
CREATE INDEX "prepared_solution_components_transaction_id_idx" ON "prepared_solution_components" USING btree ("transaction_id");
CREATE INDEX "result_materials_result_id_idx" ON "result_materials" USING btree ("result_id");
CREATE INDEX "result_materials_sample_id_idx" ON "result_materials" USING btree ("sample_id");
CREATE INDEX "result_materials_lot_id_idx" ON "result_materials" USING btree ("lot_id");
CREATE INDEX "result_materials_solution_id_idx" ON "result_materials" USING btree ("solution_id");
CREATE INDEX "result_materials_transaction_id_idx" ON "result_materials" USING btree ("transaction_id");
CREATE INDEX "result_materials_linked_by_idx" ON "result_materials" USING btree ("linked_by");
CREATE INDEX "result_materials_withdrawn_by_idx" ON "result_materials" USING btree ("withdrawn_by");
CREATE UNIQUE INDEX "result_materials_result_lot_uidx" ON "result_materials" USING btree ("result_id","lot_id") WHERE "result_materials"."lot_id" IS NOT NULL AND "result_materials"."withdrawn_at" IS NULL;
CREATE UNIQUE INDEX "result_materials_result_solution_uidx" ON "result_materials" USING btree ("result_id","solution_id") WHERE "result_materials"."solution_id" IS NOT NULL AND "result_materials"."withdrawn_at" IS NULL;

-- ---- database-level controls (the same statements are in src/db/protections/reagents.ts, re-applied at every start) -----------

CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

-- The ledger arithmetic: a row must continue the balance of its lot or solution.
CREATE OR REPLACE FUNCTION gxp_reagent_balance() RETURNS trigger AS $$
    DECLARE previous numeric;
    BEGIN
      IF NEW.lot_id IS NOT NULL THEN
        SELECT t.balance_after INTO previous FROM reagent_transactions t WHERE t.lot_id = NEW.lot_id ORDER BY t.seq DESC LIMIT 1;
      ELSE
        SELECT t.balance_after INTO previous FROM reagent_transactions t WHERE t.solution_id = NEW.solution_id ORDER BY t.seq DESC LIMIT 1;
      END IF;
      IF NEW.balance_after IS DISTINCT FROM coalesce(previous, 0) + NEW.qty_delta THEN
        RAISE EXCEPTION 'GxP: the balance of % does not follow from its ledger (% + % is not %)', coalesce(NEW.lot_id, NEW.solution_id), coalesce(previous, 0), NEW.qty_delta, NEW.balance_after
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

-- A solution cannot outlive the lot (expiry, in-use expiry) or the solution it is made from.
CREATE OR REPLACE FUNCTION gxp_solution_component_expiry() RETURNS trigger AS $$
    DECLARE made text; parent_limit text; parent text;
    BEGIN
      SELECT s.expiry_date INTO made FROM prepared_solutions s WHERE s.id = NEW.solution_id;
      IF NEW.lot_id IS NOT NULL THEN
        SELECT least(l.expiry_date, coalesce(l.in_use_expiry, l.expiry_date)), l.id INTO parent_limit, parent FROM reagent_lots l WHERE l.id = NEW.lot_id;
      ELSE
        SELECT p.expiry_date, p.id INTO parent_limit, parent FROM prepared_solutions p WHERE p.id = NEW.parent_solution_id;
      END IF;
      IF made IS NULL OR parent_limit IS NULL OR made > parent_limit THEN
        RAISE EXCEPTION 'GxP: solution % (expiry %) cannot outlive % (expiry %)', NEW.solution_id, made, parent, parent_limit
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

-- A lot is never deleted, its receipt never changes, its status only moves forward, a final status freezes it.
CREATE OR REPLACE FUNCTION gxp_reagent_lot_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GxP: DELETE on reagent_lots is not permitted (lot %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.item_id, NEW.lot_number, NEW.supplier, NEW.coa_reference, NEW.received_quantity, NEW.unit, NEW.expiry_date, NEW.potency, NEW.potency_basis, NEW.received_by, NEW.received_at)
          IS DISTINCT FROM (OLD.id, OLD.item_id, OLD.lot_number, OLD.supplier, OLD.coa_reference, OLD.received_quantity, OLD.unit, OLD.expiry_date, OLD.potency, OLD.potency_basis, OLD.received_by, OLD.received_at) THEN
        RAISE EXCEPTION 'GxP: the receipt record of reagent lot % cannot be changed', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status IN ('Consumed', 'Disposed', 'Expired', 'Rejected') THEN
        RAISE EXCEPTION 'GxP: reagent lot % is % and can no longer be changed', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'Quarantine' AND NEW.status IN ('Approved', 'Expired', 'Rejected'))
          OR (OLD.status = 'Approved' AND NEW.status IN ('InUse', 'Disposed', 'Expired', 'Rejected'))
          OR (OLD.status = 'InUse' AND NEW.status IN ('Consumed', 'Disposed', 'Expired', 'Rejected'))) THEN
        RAISE EXCEPTION 'GxP: reagent lot % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (OLD.released_by IS NOT NULL AND (NEW.released_by, NEW.released_at) IS DISTINCT FROM (OLD.released_by, OLD.released_at))
          OR (OLD.opened_at IS NOT NULL AND (NEW.opened_by, NEW.opened_at, NEW.in_use_expiry) IS DISTINCT FROM (OLD.opened_by, OLD.opened_at, OLD.in_use_expiry)) THEN
        RAISE EXCEPTION 'GxP: the release or opening record of reagent lot % cannot be changed', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

-- A solution is never deleted, its preparation never changes, a final status freezes it.
CREATE OR REPLACE FUNCTION gxp_prepared_solution_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GxP: DELETE on prepared_solutions is not permitted (solution %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.name, NEW.concentration, NEW.preparation, NEW.quantity, NEW.unit, NEW.expiry_date, NEW.storage_condition, NEW.prepared_by, NEW.prepared_at)
          IS DISTINCT FROM (OLD.id, OLD.name, OLD.concentration, OLD.preparation, OLD.quantity, OLD.unit, OLD.expiry_date, OLD.storage_condition, OLD.prepared_by, OLD.prepared_at) THEN
        RAISE EXCEPTION 'GxP: the preparation record of solution % cannot be changed', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'Active' THEN
        RAISE EXCEPTION 'GxP: solution % is % and can no longer be changed', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

-- A result material link is never deleted; the only change is its one-time withdrawal.
CREATE OR REPLACE FUNCTION gxp_result_material_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
          OR (NEW.id, NEW.result_id, NEW.sample_id, NEW.lot_id, NEW.solution_id, NEW.quantity, NEW.transaction_id, NEW.result_version, NEW.linked_by, NEW.linked_at)
             IS DISTINCT FROM (OLD.id, OLD.result_id, OLD.sample_id, OLD.lot_id, OLD.solution_id, OLD.quantity, OLD.transaction_id, OLD.result_version, OLD.linked_by, OLD.linked_at) THEN
        RAISE EXCEPTION 'GxP: % on result material link % is not permitted (only a one-time withdrawal)', TG_OP, OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gxp_reagent_transactions_balance_guard ON reagent_transactions;
CREATE TRIGGER gxp_reagent_transactions_balance_guard BEFORE INSERT ON reagent_transactions FOR EACH ROW EXECUTE FUNCTION gxp_reagent_balance();
DROP TRIGGER IF EXISTS gxp_reagent_transactions_row_guard ON reagent_transactions;
CREATE TRIGGER gxp_reagent_transactions_row_guard BEFORE UPDATE OR DELETE ON reagent_transactions FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_reagent_transactions_truncate_guard ON reagent_transactions;
CREATE TRIGGER gxp_reagent_transactions_truncate_guard BEFORE TRUNCATE ON reagent_transactions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_prepared_solution_components_expiry_guard ON prepared_solution_components;
CREATE TRIGGER gxp_prepared_solution_components_expiry_guard BEFORE INSERT ON prepared_solution_components FOR EACH ROW EXECUTE FUNCTION gxp_solution_component_expiry();
DROP TRIGGER IF EXISTS gxp_prepared_solution_components_row_guard ON prepared_solution_components;
CREATE TRIGGER gxp_prepared_solution_components_row_guard BEFORE UPDATE OR DELETE ON prepared_solution_components FOR EACH ROW EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_prepared_solution_components_truncate_guard ON prepared_solution_components;
CREATE TRIGGER gxp_prepared_solution_components_truncate_guard BEFORE TRUNCATE ON prepared_solution_components FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_reagent_lots_row_guard ON reagent_lots;
CREATE TRIGGER gxp_reagent_lots_row_guard BEFORE UPDATE OR DELETE ON reagent_lots FOR EACH ROW EXECUTE FUNCTION gxp_reagent_lot_guard();
DROP TRIGGER IF EXISTS gxp_reagent_lots_truncate_guard ON reagent_lots;
CREATE TRIGGER gxp_reagent_lots_truncate_guard BEFORE TRUNCATE ON reagent_lots FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_prepared_solutions_row_guard ON prepared_solutions;
CREATE TRIGGER gxp_prepared_solutions_row_guard BEFORE UPDATE OR DELETE ON prepared_solutions FOR EACH ROW EXECUTE FUNCTION gxp_prepared_solution_guard();
DROP TRIGGER IF EXISTS gxp_prepared_solutions_truncate_guard ON prepared_solutions;
CREATE TRIGGER gxp_prepared_solutions_truncate_guard BEFORE TRUNCATE ON prepared_solutions FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();
DROP TRIGGER IF EXISTS gxp_result_materials_row_guard ON result_materials;
CREATE TRIGGER gxp_result_materials_row_guard BEFORE UPDATE OR DELETE ON result_materials FOR EACH ROW EXECUTE FUNCTION gxp_result_material_guard();
DROP TRIGGER IF EXISTS gxp_result_materials_truncate_guard ON result_materials;
CREATE TRIGGER gxp_result_materials_truncate_guard BEFORE TRUNCATE ON result_materials FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation();

-- ---- constants (only under the migration runner) ------------------------------------------------------------------------------

INSERT INTO "signature_meanings" ("code", "text", "allowed_roles", "requires_reason", "training_exempt")
SELECT v.* FROM (VALUES
	('REAGENT_LOT_RELEASE', 'Material release: I have reviewed the receipt record and the certificate of analysis of this lot, and I release it from quarantine for laboratory use.', ARRAY['QA','Admin'], false, false),
	('REAGENT_LOT_REJECTION', 'Material rejection: this lot is rejected and must not be used for any test.', ARRAY['QA','Admin'], true, false),
	('REAGENT_LOT_RETEST', 'Material retest: this lot was retested against its specification and remains suitable for use until the new retest date.', ARRAY['QA','Admin'], true, false)
) AS v(code, text, allowed_roles, requires_reason, training_exempt)
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
	('reagent.manage', 'Equipment', 'Define and edit reagent and reference standard items (the item master)', 230),
	('reagent.use', 'Equipment', 'Open a released lot, record consumption, prepare and discard solutions, and record the lots used for a result', 231),
	('reagent.approve', 'Equipment', 'Release a received lot from quarantine, reject it or record its retest, with an e-signature (never the receiver)', 232)
) AS v("code", "category", "description", "position")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");

INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
	('role-admin', 'reagent.manage'), ('role-admin', 'reagent.use'), ('role-admin', 'reagent.approve'),
	('role-qa', 'reagent.manage'), ('role-qa', 'reagent.use'), ('role-qa', 'reagent.approve'),
	('role-reviewer', 'reagent.manage'), ('role-reviewer', 'reagent.use'),
	('role-analyst', 'reagent.use')
) AS v("role_id", "permission_code")
WHERE EXISTS (SELECT 1 FROM "schema_migrations");
