// Database-level controls of the reagent inventory (roadmap M30, migration 0230_reagents). Owned by r2-reagents; listed in
// src/db/protections.ts by the wave gate. The migration creates the same functions and triggers, so a schema built from the migrations
// alone is guarded; this set re-installs them at every start and after a restore.
//
//   reagent_transactions          THE CONSUMPTION LEDGER: append-only, and every inserted row must continue the balance of its lot or
//                                 solution: balance_after = the holder's previous balance + qty_delta (never negative, by CHECK). The
//                                 application computes it under a row lock; the trigger refuses a row that does not follow, whoever
//                                 writes it.
//   prepared_solution_components  append-only, and a solution may not expire after the lot (its expiry and in-use expiry) or the
//                                 solution it is made from.
//   reagent_lots                  never deleted; the receipt (what was received, its dates and potency, by whom) never changes; the
//                                 status only moves forward; a final status (Consumed, Disposed, Expired, Rejected) freezes the row.
//   prepared_solutions            never deleted; what was prepared never changes; a final status freezes the row.
//   result_materials              never deleted; the only change is the one-time withdrawal of a link (by whom, when, why).
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema. */
const whenTableExists = (table: string, statements: string[]): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${statements.join('; ')}; END IF; END $guard$`;

const rowGuard = (table: string, fn: string, events = 'UPDATE OR DELETE') => [
  `DROP TRIGGER IF EXISTS gxp_${table}_row_guard ON ${table}`,
  `CREATE TRIGGER gxp_${table}_row_guard BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  `DROP TRIGGER IF EXISTS gxp_${table}_truncate_guard ON ${table}`,
  `CREATE TRIGGER gxp_${table}_truncate_guard BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation()`,
];

export const REAGENT_FUNCTIONS: string[] = [
  `CREATE OR REPLACE FUNCTION gxp_reagent_balance() RETURNS trigger AS $$
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
    $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION gxp_solution_component_expiry() RETURNS trigger AS $$
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
    $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION gxp_reagent_lot_guard() RETURNS trigger AS $$
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
    $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION gxp_prepared_solution_guard() RETURNS trigger AS $$
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
    $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION gxp_result_material_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
          OR (NEW.id, NEW.result_id, NEW.sample_id, NEW.lot_id, NEW.solution_id, NEW.quantity, NEW.transaction_id, NEW.result_version, NEW.linked_by, NEW.linked_at)
             IS DISTINCT FROM (OLD.id, OLD.result_id, OLD.sample_id, OLD.lot_id, OLD.solution_id, OLD.quantity, OLD.transaction_id, OLD.result_version, OLD.linked_by, OLD.linked_at) THEN
        RAISE EXCEPTION 'GxP: % on result material link % is not permitted (only a one-time withdrawal)', TG_OP, OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
];

export const reagentsProtections: ProtectionSet = {
  domain: 'reagents',
  statements: [
    ...REAGENT_FUNCTIONS,
    whenTableExists('reagent_transactions', [
      'DROP TRIGGER IF EXISTS gxp_reagent_transactions_balance_guard ON reagent_transactions',
      'CREATE TRIGGER gxp_reagent_transactions_balance_guard BEFORE INSERT ON reagent_transactions FOR EACH ROW EXECUTE FUNCTION gxp_reagent_balance()',
      ...appendOnlyTable('reagent_transactions'),
    ]),
    whenTableExists('prepared_solution_components', [
      'DROP TRIGGER IF EXISTS gxp_prepared_solution_components_expiry_guard ON prepared_solution_components',
      'CREATE TRIGGER gxp_prepared_solution_components_expiry_guard BEFORE INSERT ON prepared_solution_components FOR EACH ROW EXECUTE FUNCTION gxp_solution_component_expiry()',
      ...appendOnlyTable('prepared_solution_components'),
    ]),
    whenTableExists('reagent_lots', rowGuard('reagent_lots', 'gxp_reagent_lot_guard')),
    whenTableExists('prepared_solutions', rowGuard('prepared_solutions', 'gxp_prepared_solution_guard')),
    whenTableExists('result_materials', rowGuard('result_materials', 'gxp_result_material_guard')),
  ],
};
