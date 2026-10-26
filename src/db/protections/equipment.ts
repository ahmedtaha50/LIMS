// Append-only equipment records. Owned by r1-quality-fixes (migration 0070): one calibration_history row per signed calibration
// (roadmap M13). The migration creates the same triggers, so a schema built from the migrations alone is guarded as well.
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const equipmentProtections: ProtectionSet = {
  domain: 'equipment',
  statements: [whenTableExists('calibration_history')],
};
