// Append-only raw-data records. Owned by r2-raw-data (migration 0120_raw_data): result versions, the attachment register and review
// checklists are written once and never changed (roadmap M20; 21 CFR 11.10(e)). The migration creates the same triggers, so a schema
// built from the migrations alone is guarded.
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const rawdataProtections: ProtectionSet = {
  domain: 'rawdata',
  statements: ['result_versions', 'attachments', 'review_checklists'].map(whenTableExists),
};
