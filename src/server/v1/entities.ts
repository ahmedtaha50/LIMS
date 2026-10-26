/**
 * ApiClient as a signable record type (roadmap M22, r1-esign registry). Creating and revoking a client are e-signed by an Administrator
 * (ADMIN_AUTHORISATION). The signature covers what the client is allowed to be: its name, service account, token (prefix and hash),
 * scopes, instrument and expiry, none of which change after creation, and its status as the signed action set it (asSigned), so the
 * creation signature still verifies after the client is revoked.
 */
import { eq } from 'drizzle-orm';
import { apiClients } from '../../db/schema/api-clients';
import { asSigned, registerSignable } from '../esign';

registerSignable({
  type: 'ApiClient',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(apiClients).where(eq(apiClients.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, name: row.name, description: row.description, userId: row.userId, tokenPrefix: row.tokenPrefix, tokenHash: row.tokenHash,
      scopes: [...row.scopes].sort(), instrumentId: row.instrumentId, expiresAt: row.expiresAt.toISOString(), createdBy: row.createdBy,
      status: asSigned(change, ['status'], row.status),
    };
  },
});
