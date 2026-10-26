// Database-level controls of the custody records (roadmap M29, migration 0220_custody). Owned by r2-custody-labels; listed in
// src/db/protections.ts by the wave gate. The migration creates the same function and triggers, so a schema built from the migrations
// alone is guarded; this set re-installs them at every start and after a restore.
//
//   custody_events   append-only, and every inserted row must continue its container's balance: balance_after = the container's
//                    previous balance + qty_delta (never negative, by CHECK). The application computes it under a row lock; the trigger
//                    refuses a row that does not follow, whoever writes it.
//   label_prints     append-only (the label log).
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema. */
const whenTableExists = (table: string, statements: string[]): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${statements.join('; ')}; END IF; END $guard$`;

export const CUSTODY_BALANCE_FUNCTION = `CREATE OR REPLACE FUNCTION gxp_custody_balance() RETURNS trigger AS $$
    DECLARE previous numeric;
    BEGIN
      SELECT e.balance_after INTO previous FROM custody_events e WHERE e.container_id = NEW.container_id ORDER BY e.seq DESC LIMIT 1;
      IF NEW.balance_after IS DISTINCT FROM coalesce(previous, 0) + NEW.qty_delta THEN
        RAISE EXCEPTION 'GxP: the custody balance of % does not follow from its ledger (% + % is not %)', NEW.container_id, coalesce(previous, 0), NEW.qty_delta, NEW.balance_after
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`;

export const custodyProtections: ProtectionSet = {
  domain: 'custody',
  statements: [
    CUSTODY_BALANCE_FUNCTION,
    whenTableExists('custody_events', [
      'DROP TRIGGER IF EXISTS gxp_custody_events_balance_guard ON custody_events',
      'CREATE TRIGGER gxp_custody_events_balance_guard BEFORE INSERT ON custody_events FOR EACH ROW EXECUTE FUNCTION gxp_custody_balance()',
      ...appendOnlyTable('custody_events'),
    ]),
    whenTableExists('label_prints', appendOnlyTable('label_prints')),
  ],
};
