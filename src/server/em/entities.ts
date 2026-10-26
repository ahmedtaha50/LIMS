/**
 * The EM record type that is e-signed (src/server/esign/registry.ts), and what its signature covers (hash version 2).
 *
 *   EmLimitProfile   the limits as approved: grade, method, occupancy, ISO class, unit, alert and action limits, source, who wrote it,
 *                    and the status as signed. None of these changes after approval (an Approved profile is frozen; a new limit is a
 *                    new profile), so a later supersession (status Retired) leaves the approval verifiable.
 */
import { eq } from 'drizzle-orm';
import { emLimitProfiles } from '../../db/schema/em';
import { asSigned, registerSignable } from '../esign';

registerSignable({
  type: 'EmLimitProfile',
  async canonical(ex, { id, change }) {
    const [p] = await ex.select().from(emLimitProfiles).where(eq(emLimitProfiles.id, id)).limit(1);
    if (!p) return null;
    return {
      id: p.id, grade: p.grade, method: p.method, occupancy: p.occupancy, isoClass: p.isoClass, unit: p.unit,
      alertLimit: p.alertLimit, actionLimit: p.actionLimit, source: p.source, origin: p.origin, createdBy: p.createdBy,
      status: asSigned(change, ['status'], p.status),
    };
  },
});
