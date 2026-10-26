import { applyRetention, backupSettings, runBackup, runDrill } from '../backupService';
import { PermanentJobError, type Handler } from '../types';

/** 'Scheduled: backup.daily' for a timer's job, 'Requested: ...' for one an administrator queued. */
const reasonOf = (payload: any, requested: string) => (typeof payload?.schedule === 'string' ? `Scheduled: ${payload.schedule}` : `Requested: ${requested}`);

/** backup.run: a backup with the configured key, mirrored, recorded, then pruned by the retention rule. */
export const backupRunHandler: Handler = async (payload, ctx) => {
  const actorId = ctx.job.createdBy;
  if (!actorId) throw new PermanentJobError('The job has no owner.');
  const settings = backupSettings();
  const r = await runBackup({ db: ctx.db, settings, actorId, kind: 'scheduled', reason: reasonOf(payload, 'backup'), jobId: ctx.job.id });
  // A file that is written but did not verify is recorded as a failed run; running the same backup again would not change that.
  if (!r.verified) throw new PermanentJobError(`The backup ${r.file} did not pass verification: ${r.problems.join('; ')}`);
  const retention = await applyRetention({ db: ctx.db, settings, actorId, reason: `Scheduled: backup retention (after ${r.file})` });
  return { run: r.runId, file: r.file, sha256: r.sha256, mirror: r.mirror.ok, retentionDeleted: retention.deleted.length };
};

/** backup.drill: restore the newest backup into a scratch database and compare it with its manifest. A failed drill is recorded, not retried. */
export const backupDrillHandler: Handler = async (payload, ctx) => {
  const actorId = ctx.job.createdBy;
  if (!actorId) throw new PermanentJobError('The job has no owner.');
  const d = await runDrill({ db: ctx.db, settings: backupSettings(), actorId, reason: reasonOf(payload, 'restore drill'), jobId: ctx.job.id });
  if (!d.passed) throw new PermanentJobError(`Restore drill ${d.drillId} failed: ${d.error ?? 'the restored database differs from the backup'}`);
  return { drill: d.drillId, file: d.file, tablesCompared: d.tablesCompared };
};
