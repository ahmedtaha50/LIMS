/** The external-integration row (integration_settings, id 'default'). AI is off unless an administrator turned it on; the key is keystore ciphertext. */
import { eq } from 'drizzle-orm';
import { integrationSettings } from '../../db/schema';
import type { Executor } from '../core/tx';

export type IntegrationRow = typeof integrationSettings.$inferSelect;

export const AI_PROVIDER = 'google-genai';
/** Authenticated-data string of the stored API key: the ciphertext cannot be moved to another column or row. */
export const AI_KEY_CONTEXT = 'integration_settings.ai_api_key_enc:default';

export const DEFAULT_INTEGRATIONS: IntegrationRow = {
  id: 'default', externalAiEnabled: false, aiApiKeyEnc: null, aiModel: 'gemini-3.8-flash', aiRedactIdentifiers: true, version: 1, updatedBy: null, updatedAt: new Date(0),
};

export async function loadIntegrationSettings(ex: Executor): Promise<IntegrationRow> {
  const [row] = await ex.select().from(integrationSettings).where(eq(integrationSettings.id, 'default')).limit(1);
  return row ?? { ...DEFAULT_INTEGRATIONS };
}

/** What an administrator may see. Never the key, only whether one is stored. */
export const publicAiSettings = (row: IntegrationRow) => ({
  provider: AI_PROVIDER,
  enabled: row.externalAiEnabled,
  hasApiKey: !!row.aiApiKeyEnc,
  model: row.aiModel,
  redactIdentifiers: row.aiRedactIdentifiers,
  version: row.version,
  updatedAt: row.updatedBy ? row.updatedAt.toISOString() : null,
  updatedBy: row.updatedBy,
});
