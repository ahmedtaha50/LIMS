/**
 * The OOS workflow records that are e-signed (src/server/esign/registry.ts), and what a signature on each covers (hash version 2).
 *
 *   OOSInvalidation   QA's confirmation of the assignable cause, which invalidates the original result (OOS_INVALIDATION): the
 *                     investigation, the result it invalidates, the cause as recorded and who recorded and confirmed it. These columns
 *                     are written once (the cause is frozen once confirmed) and never change afterwards.
 *   OOSRetestPlan     the retest authorisation (OOS_RETEST_AUTHORISATION): the plan row, append-only.
 *   OOSSettings       a change of the workflow settings (OOS_SETTING_CHANGE): the change as the audit entry recorded it (an event on a row
 *                     that keeps changing; the audit chain protects it).
 * The closure keeps the r1 type `OOS` (src/server/esign/entities.ts); its decision is in the closure's audit entry.
 */
import { eq } from 'drizzle-orm';
import { oosInvestigations, oosRetestPlans, oosSettings } from '../../db/schema/oos';
import { registerSignable } from '../esign';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

registerSignable({
  type: 'OOSInvalidation',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(oosInvestigations).where(eq(oosInvestigations.id, id)).limit(1);
    if (!row || !row.invalidatedAt) return null;
    return {
      id: row.id, sampleId: row.sampleId, resultId: row.resultId, parameter: row.parameter,
      assignableCauseCategory: row.assignableCauseCategory, assignableCause: row.assignableCause, assignableCauseBy: row.assignableCauseBy,
      assignableCauseAt: iso(row.assignableCauseAt), invalidatedBy: row.invalidatedBy, invalidatedAt: iso(row.invalidatedAt),
    };
  },
});

registerSignable({
  type: 'OOSRetestPlan',
  async canonical(ex, { id }) {
    const [row] = await ex.select().from(oosRetestPlans).where(eq(oosRetestPlans.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, oosId: row.oosId, retestOf: row.retestOf, basis: row.basis, justification: row.justification, maxRetests: row.maxRetests,
      approvedBy: row.approvedBy, approvedAt: iso(row.approvedAt),
    };
  },
});

registerSignable({
  type: 'OOSSettings',
  async canonical(ex, { id, change }) {
    if (!change) return null;
    const [row] = await ex.select({ id: oosSettings.id }).from(oosSettings).where(eq(oosSettings.id, id)).limit(1);
    if (!row) return null;
    return { id, event: { action: change.action, field: change.field, oldValue: change.oldValue, newValue: change.newValue } };
  },
});
