// Append-only master data records. Owned by r2-master-data (migration 0100_master_data): the sample_context sidecar is written once,
// in the registration's transaction, and never changed (roadmap M17). The migration creates the same triggers, so a schema built
// from the migrations alone is guarded as well.
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const masterProtections: ProtectionSet = {
  domain: 'master',
  statements: [whenTableExists('sample_context')],
};
