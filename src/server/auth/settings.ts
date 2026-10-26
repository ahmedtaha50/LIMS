/** The security policy row (system_settings, id 'default') with the defaults of a database that has none yet. */
import { eq } from 'drizzle-orm';
import { systemSettings } from '../../db/schema';
import type { Executor } from '../core/tx';

export type SecuritySettings = Omit<typeof systemSettings.$inferSelect, 'id' | 'updatedAt'>;

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  sessionTimeoutMinutes: 15,
  maxFailedLogins: 3,
  passwordExpiryDays: 90,
  minPasswordLength: 8,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
  passwordHistoryCount: 5,
  lockoutMinutes: 15,
  mfaRequired: false,
  sessionAbsoluteHours: 12,
  version: 1,
};

export async function loadSecuritySettings(ex: Executor): Promise<SecuritySettings> {
  const [row] = await ex.select().from(systemSettings).where(eq(systemSettings.id, 'default')).limit(1);
  if (!row) return { ...DEFAULT_SECURITY_SETTINGS };
  const { id: _id, updatedAt: _updatedAt, ...settings } = row;
  return settings;
}
