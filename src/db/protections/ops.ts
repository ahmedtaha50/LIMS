// Append-only operational records. Owned by r1-backup-jobs (assigned by r1-migrations when it split the registry): the backup run
// log and the restore drill results are evidence that a backup was made and proven restorable (Annex 11 s.7.2), so they are
// append-only like the audit trail (roadmap M14).
import { appendOnlyTable, type ProtectionSet } from './common';

/**
 * appendOnlyTable(), skipped while the table does not exist. A backup of an older version is restored into that version's schema
 * (docs/migrations.md, "Rolling back") and src/server/backup.ts then re-applies every statement of the registry; a plain
 * CREATE TRIGGER on a table the older schema does not have would fail the restore. Once the upgrade has created the table the
 * next start installs the triggers.
 */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const opsProtections: ProtectionSet = {
  domain: 'ops',
  statements: [
    whenTableExists('backup_runs'),
    whenTableExists('restore_drills'),
  ],
};
