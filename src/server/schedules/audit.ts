/**
 * The schedules and job handlers of the tamper evidence (roadmap M35). r2-audit-tamper owns this file; SCHEDULES
 * (./index.ts) and the handler registry (src/server/jobs/handlers/index.ts) list them.
 *
 *   audit.anchor   daily 00:20: an anchor of the audit and security-event heads, to the second path (src/server/audit/anchors.ts),
 *                  then a verification of every anchor so far. A mismatch fails the job for good, so it stays visible.
 *   audit.clock    every 5 minutes: the clock guard (src/server/audit/clockGuard.ts). A set-back fails the job for good.
 */
import { anchorDirectory, verifyAnchors, writeAnchor } from '../audit/anchors';
import { checkClock } from '../audit/clockGuard';
import { PermanentJobError, type Handler } from '../jobs/types';
import type { ScheduleDef } from './index';

export const AUDIT_SCHEDULES: ScheduleDef[] = [
  { name: 'audit.anchor', cron: '20 0 * * *', type: 'audit.anchor', description: 'Daily anchor of the audit trail head to the second path (AUDIT_ANCHOR_DIR or the backup mirror), then a check of every anchor against the database.' },
  { name: 'audit.clock', cron: '*/5 * * * *', type: 'audit.clock', description: 'Clock guard: a clock found earlier than records already written blocks signing until an Administrator acknowledges it.' },
];

const owner = (createdBy: string | null) => {
  if (!createdBy) throw new PermanentJobError('The job has no owner.');
  return createdBy;
};

export const auditAnchorHandler: Handler = async (_payload, ctx) => {
  const actorId = owner(ctx.job.createdBy);
  const { dir } = anchorDirectory();
  if (!dir) throw new PermanentJobError('No folder for audit anchors is configured: set AUDIT_ANCHOR_DIR (or BACKUP_MIRROR_DIR).');
  const { anchor } = await writeAnchor(ctx.db, { dir, actorId });
  const v = await verifyAnchors(ctx.db, { dir, actorId });
  if (!v.isValid) throw new PermanentJobError(`The audit trail does not match its anchors: ${v.failures.slice(0, 3).map(f => `${f.file} ${f.reason}`).join('; ')}.`);
  return { sequence: anchor.sequence, anchorsChecked: v.anchorsChecked };
};

export const auditClockHandler: Handler = async (_payload, ctx) => {
  const r = await checkClock(ctx.db, { source: 'schedule', actorId: owner(ctx.job.createdBy) });
  if (!r.ok) throw new PermanentJobError(`The system clock is ${Math.round(r.behindMs / 60_000)} minute(s) behind records already written; signing is blocked until an Administrator acknowledges it.`);
  return { ok: true };
};

export const AUDIT_HANDLERS: Record<string, Handler> = {
  'audit.anchor': auditAnchorHandler,
  'audit.clock': auditClockHandler,
};
