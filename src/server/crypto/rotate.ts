/**
 * Moves every stored secret to the keystore's current generation (roadmap M16): TOTP secrets (including pending enrolments and any
 * legacy plaintext one), the AI API key, the webhook secrets of event subscriptions (r2-events) and the directory service-account password (r3-directory). One transaction with one audit entry, so a rotation is either complete and recorded or
 * did not happen. Run after adding a generation to the key ring (`admin-cli rotate-keys`); a second run finds nothing to move.
 */
import { isNotNull, or, eq } from 'drizzle-orm';
import { directorySettings, eventSubscriptions, integrationSettings, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { AI_KEY_CONTEXT } from '../auth/integrationSettings';
import { BIND_PASSWORD_CONTEXT } from '../auth/ldap';
import { totpContext } from '../auth/totp';
import type { Db } from '../core/context';
import { subscriptionSecretContext } from '../events/dispatcher';
import { withTransaction } from '../core/tx';
import { getKeystore, type Keystore } from './keystore';

export interface RotationReport { generation: number; totpSecrets: number; pendingSecrets: number; apiKeys: number; webhookSecrets: number; bindPasswords: number }

export async function rotateStoredSecrets(db: Db, opts: { actor: string; reason: string; keystore?: Keystore }): Promise<RotationReport> {
  const ks = opts.keystore ?? getKeystore();
  /** The value in the current generation, or null when it already is. A bare value (legacy plaintext) is encrypted. */
  const moved = (value: string, context: string): string | null =>
    ks.isEncrypted(value) ? (ks.generationOf(value) === ks.current ? null : ks.reencrypt(value, context)) : ks.encrypt(value, context);

  return withTransaction(db, async tx => {
    const report: RotationReport = { generation: ks.current, totpSecrets: 0, pendingSecrets: 0, apiKeys: 0, webhookSecrets: 0, bindPasswords: 0 };

    const rows = await tx.select({ id: users.id, secret: users.totpSecret, pending: users.totpPendingSecret }).from(users)
      .where(or(isNotNull(users.totpSecret), isNotNull(users.totpPendingSecret))).for('update');
    for (const row of rows) {
      const set: Partial<typeof users.$inferInsert> = {};
      const secret = row.secret ? moved(row.secret, totpContext(row.id)) : null;
      const pending = row.pending ? moved(row.pending, totpContext(row.id)) : null;
      if (secret) { set.totpSecret = secret; report.totpSecrets++; }
      if (pending) { set.totpPendingSecret = pending; report.pendingSecrets++; }
      if (Object.keys(set).length) await tx.update(users).set(set).where(eq(users.id, row.id));
    }

    const [integration] = await tx.select().from(integrationSettings).where(eq(integrationSettings.id, 'default')).for('update');
    if (integration?.aiApiKeyEnc) {
      const key = moved(integration.aiApiKeyEnc, AI_KEY_CONTEXT);
      if (key) { await tx.update(integrationSettings).set({ aiApiKeyEnc: key }).where(eq(integrationSettings.id, 'default')); report.apiKeys++; }
    }

    const [directory] = await tx.select().from(directorySettings).where(eq(directorySettings.id, 'default')).for('update');
    if (directory?.bindPasswordEnc) {
      const bind = moved(directory.bindPasswordEnc, BIND_PASSWORD_CONTEXT);
      if (bind) { await tx.update(directorySettings).set({ bindPasswordEnc: bind }).where(eq(directorySettings.id, 'default')); report.bindPasswords++; }
    }

    const subs = await tx.select({ id: eventSubscriptions.id, secret: eventSubscriptions.secretEnc }).from(eventSubscriptions)
      .where(isNotNull(eventSubscriptions.secretEnc)).for('update');
    for (const s of subs) {
      const secret = moved(s.secret!, subscriptionSecretContext(s.id));
      if (secret) { await tx.update(eventSubscriptions).set({ secretEnc: secret }).where(eq(eventSubscriptions.id, s.id)); report.webhookSecrets++; }
    }

    await writeAudit(tx, opts.actor, 'KEY_ROTATION', 'Keystore', 'field-enc', 'generation', '', JSON.stringify(report), opts.reason);
    return report;
  });
}
