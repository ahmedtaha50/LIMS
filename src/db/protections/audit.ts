// Append-only audit trail, its checkpoints and the security events. Moved out of src/db/protections.ts by r1-migrations; r1-audit owns this file.
import { appendOnlyTable, type ProtectionSet } from './common';

/**
 * appendOnlyTable(), skipped while the table does not exist. A backup of an older version is restored into that version's
 * schema (docs/migrations.md, "Rolling back") and src/server/backup.ts then re-applies every statement of the registry; a plain
 * CREATE TRIGGER on a table the older schema does not have would fail the restore. Once the upgrade has created the table the
 * next start installs the triggers.
 */
const whenTableExists = (table: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table).join('; ')}; END IF; END $guard$`;

export const auditProtections: ProtectionSet = {
  domain: 'audit',
  statements: [
    ...appendOnlyTable('audit_trail'),
    whenTableExists('audit_checkpoints'),
    whenTableExists('security_events'),
    // 0170_audit_review (r2-audit-tamper): the signed audit-trail reviews and the anchor register.
    whenTableExists('audit_reviews'),
    whenTableExists('audit_anchors'),
  ],
};
