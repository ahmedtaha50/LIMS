// Append-only quality records. Owned by r2-qms (migration 0180_qms): links, comments and effectiveness checks of the QMS are written
// once and never changed (roadmap M27). The migration creates the same triggers, so a schema built from the migrations alone is guarded.
import { appendOnlyTable, type ProtectionSet } from './common';

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const qmsProtections: ProtectionSet = {
  domain: 'qms',
  statements: ['qms_links', 'qms_comments', 'qms_effectiveness_checks'].map(whenTableExists),
};
