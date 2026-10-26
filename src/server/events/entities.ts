/**
 * EventSubscription as a signable record type (roadmap M23, r1-esign registry). Creating, disabling and re-enabling a subscription
 * are e-signed by an Administrator (ADMIN_AUTHORISATION). The signature covers what the subscription is: its name, sink, target, event
 * types and the fingerprint of its secret (never the secret), none of which change after creation, and the status as the signed
 * action set it (asSigned), so the creation signature still verifies after the subscription is disabled.
 */
import { eq } from 'drizzle-orm';
import { eventSubscriptions } from '../../db/schema/events';
import { asSigned, registerSignable } from '../esign';

registerSignable({
  type: 'EventSubscription',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, name: row.name, sink: row.sink, target: row.target, eventTypes: [...row.eventTypes].sort(),
      secretFingerprint: row.secretFingerprint, createdBy: row.createdBy, status: asSigned(change, ['status'], row.status),
    };
  },
});
