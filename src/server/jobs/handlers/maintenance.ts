import { verifyAuditChain } from '../../audit/chain';
import { recordSecurityEvent, verifySecurityChain } from '../../audit/securityEvents';
import { purgeExpiredArtifacts } from '../artifacts';
import { PermanentJobError, type Handler } from '../types';

/** Deletes job artifacts past their retention (30 days) and audits each deletion. */
export const artifactsCleanupHandler: Handler = async (_payload, ctx) => {
  const purged = await purgeExpiredArtifacts(ctx.db);
  return { purged };
};

/**
 * audit.verify: re-checks the whole audit hash chain and the security-event chain, and records the outcome as a security event
 * (what the Verify button of the audit screen does, on a schedule, so tampering is found without anyone remembering to look).
 * A broken chain fails the job for good: it is not a transient error and must stay visible.
 */
export const auditVerifyHandler: Handler = async (_payload, ctx) => {
  const actorId = ctx.job.createdBy;
  if (!actorId) throw new PermanentJobError('The job has no owner.');
  const audit = await verifyAuditChain(ctx.db);
  const security = await verifySecurityChain(ctx.db);
  const ok = audit.isValid && security.isValid;
  await recordSecurityEvent(ctx.db, {
    type: 'AUDIT_VERIFY', outcome: ok ? 'success' : 'failure', actorId, actorRole: 'Service',
    detail: {
      scheduled: true, audit: { totalRecords: audit.totalRecords, headSequence: audit.headSequence, compromisedSequence: audit.compromisedSequence, reason: audit.reason, checkpointsAdded: audit.checkpointsAdded },
      securityEvents: { totalRecords: security.totalRecords, compromisedSequence: security.compromisedSequence, reason: security.reason },
    },
  });
  if (!ok) {
    throw new PermanentJobError(audit.isValid
      ? `The security event chain is broken at sequence ${security.compromisedSequence} (${security.reason}).`
      : `The audit trail is broken at sequence ${audit.compromisedSequence} (${audit.reason}).`);
  }
  return { auditRecords: audit.totalRecords, securityEvents: security.totalRecords };
};
