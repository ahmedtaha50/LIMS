// Domain: external integrations (roadmap M16). r1-identity owns this file. It is re-exported from identity.ts.
import { pgTable, text, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

/**
 * One row, id 'default'. External AI is off unless an administrator turns it on with their password; the API key is stored
 * as keystore ciphertext (src/server/crypto/keystore.ts) and is never returned by any route.
 */
export const integrationSettings = pgTable('integration_settings', {
  id: text('id').primaryKey(),
  externalAiEnabled: boolean('external_ai_enabled').default(false).notNull(),
  aiApiKeyEnc: text('ai_api_key_enc'),
  aiModel: text('ai_model').default('gemini-3.8-flash').notNull(),
  aiRedactIdentifiers: boolean('ai_redact_identifiers').default(true).notNull(),
  version: integer('version').default(1).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
