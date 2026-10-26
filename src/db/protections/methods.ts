// Append-only run records of calculations and system suitability. Owned by r2-methods-calc (migration 0110_methods_calc): a
// result_inputs row (the raw inputs and the formula revision of one calculated result) and an sst_runs row (one system suitability
// run and what it invalidated) are written once and never changed (roadmap M18). The migration creates the same triggers, so a
// schema built from the migrations alone is guarded as well.
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const methodsProtections: ProtectionSet = {
  domain: 'methods',
  statements: [whenTableExists('result_inputs'), whenTableExists('sst_runs')],
};
