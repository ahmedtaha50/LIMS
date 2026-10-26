/**
 * The signable record type of the stability programme (roadmap M31): StabilityProtocol, signed STABILITY_PROTOCOL_APPROVAL. The
 * signature covers the protocol as approved: code, title, revision, product, test plan code, the condition snapshot, the month points
 * and the window, and the status as signed (asSigned, so the later move to Superseded does not break it). An Approved revision is never
 * edited (src/server/stability/protocols.ts), so the content does not change after the signature.
 */
import { eq } from 'drizzle-orm';
import { stabilityProtocols } from '../../db/schema/stability';
import { asSigned, getSignable, registerSignable } from '../esign';

if (!getSignable('StabilityProtocol')) {
  registerSignable({
    type: 'StabilityProtocol',
    async canonical(ex, { id, change }) {
      const [row] = await ex.select().from(stabilityProtocols).where(eq(stabilityProtocols.id, id)).limit(1);
      if (!row) return null;
      return {
        id: row.id, code: row.code, title: row.title, revision: row.revision, productId: row.productId, testPlanCode: row.testPlanCode,
        conditions: row.conditions, monthPoints: row.monthPoints, windowDays: row.windowDays, status: asSigned(change, ['status'], row.status),
      };
    },
  });
}
