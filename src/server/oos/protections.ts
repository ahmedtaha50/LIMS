// Append-only OOS records (roadmap M26, migration 0210_oos_workflow). Owned by r2-oos-workflow: a retest plan, once QA has signed it,
// and each retest recorded under it are written once and never changed or removed, so the number of retests and their values cannot be
// rewritten after the fact ("testing into compliance"). The migration creates the same triggers, so a schema built from the migrations
// alone is guarded. Listed in src/db/protections.ts by the wave gate.
import { appendOnlyTable, type ProtectionSet } from '../../db/protections/common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema. */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const oosProtections: ProtectionSet = {
  domain: 'oos',
  statements: ['oos_retest_plans', 'oos_retests'].map(whenTableExists),
};
