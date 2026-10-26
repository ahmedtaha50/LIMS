// Append-only EM records (roadmap M32, migration 0250_em). Owned by r2-em: an excursion, once opened with its deviation, is never changed
// or removed; what happens next is the deviation's lifecycle (M27). The migration creates the same triggers, so a schema built from the
// migrations alone is guarded. Listed in src/db/protections.ts by the wave gate.
import { appendOnlyTable, type ProtectionSet } from '../../db/protections/common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema. */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const emProtections: ProtectionSet = {
  domain: 'em',
  statements: ['em_excursions'].map(whenTableExists),
};
