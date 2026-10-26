// Domain: display preferences (roadmap M38, migration 0350_i18n_preferences). r3-i18n owns this file; src/db/schema/index.ts re-exports it.
//   user_preferences   language ('en' | 'ar') and digit style ('latin' | 'arabic-indic') per user. A sidecar: users is not changed.
// Display only. Nothing stored, signed, audited or exported depends on these values.
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../../db/schema/identity';

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id),
  language: text('language').default('en').notNull(),
  digits: text('digits').default('latin').notNull(),
  version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check('user_preferences_language_check', sql`${t.language} IN ('en', 'ar')`),
  check('user_preferences_digits_check', sql`${t.digits} IN ('latin', 'arabic-indic')`),
]);
