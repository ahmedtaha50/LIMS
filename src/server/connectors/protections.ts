// Database-level controls of instrument data capture (roadmap M21, migration 0260_instrument_data). Owned by r2-instrument-integration;
// listed in src/db/protections.ts by the wave gate. The migration creates the same triggers, so a schema built from the migrations
// alone is guarded; these statements re-apply them after a restore.
//   append-only:  instrument_profile_revisions, result_sources, instrument_usage_log
//   instrument_files: DELETE and TRUNCATE are refused; an UPDATE may change only disposition, disposition_note and version.
import { appendOnlyTable, type ProtectionSet } from '../../db/protections/common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema. */
const whenTableExists = (table: string, statements: string[]): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${statements.join('; ')}; END IF; END $guard$`;

export const instrumentDataProtections: ProtectionSet = {
  domain: 'instrument-data',
  statements: [
    `CREATE OR REPLACE FUNCTION gxp_instrument_files_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'disposition' - 'disposition_note' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'disposition' - 'disposition_note' - 'version') THEN
        RAISE EXCEPTION 'GxP: % on % is not permitted (only the disposition of a captured file may change)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
    ...['instrument_profile_revisions', 'result_sources', 'instrument_usage_log'].map(t => whenTableExists(t, appendOnlyTable(t))),
    whenTableExists('instrument_files', appendOnlyTable('instrument_files', 'gxp_instrument_files_guard')),
  ],
};
