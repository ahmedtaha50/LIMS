// Domain: the validated-scope register (roadmap M37, migration 0300_qualified_modules). r2-validation owns this file.
//
//   qualified_modules   one row per module whose scope QA has declared; 'NotQualified' makes writes to the module answer
//                       403 MODULE_NOT_QUALIFIED. A module without a row is undeclared. The history is the audit trail and the signatures.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const qualifiedModules = pgTable('qualified_modules', {
  id: text('id').primaryKey(), // the module key (src/server/qualified.ts MODULES)
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  evidenceRef: text('evidence_ref'),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(1).notNull(),
}, (t) => [
  index('qualified_modules_updated_by_idx').on(t.updatedBy),
  check('qualified_modules_status_check', sql`${t.status} IN ('Qualified', 'NotQualified')`),
  check('qualified_modules_reason_check', sql`length(btrim(${t.reason})) >= 5`),
]);
