/**
 * The schedules the application ships (roadmap M15). Each is a row of scheduled_jobs, created at start-up if it is missing: a row
 * that exists is never overwritten, so a time an administrator changed in the database survives an update. Cron expressions are
 * five fields in the server's local time. A schedule that falls due while the PC is off runs once when the server starts again.
 * BACKUP_CRON sets the backup time of a new installation (default 02:00).
 */
import { AUDIT_SCHEDULES } from './audit';
import { TRAINING_SCHEDULES } from '../training/schedule';
import { EM_SCHEDULES } from './em';
import { STABILITY_SCHEDULES } from './stability';
import { REAGENT_SCHEDULES } from './reagents';
import { TAT_SCHEDULES } from './tat';
import { OOT_SCHEDULES } from './oot';
import { PERIODIC_SCHEDULES } from './periodic';

export interface ScheduleDef {
  name: string;
  cron: string;
  /** The job type to enqueue (a handler in src/server/jobs/handlers). */
  type: string;
  payload?: Record<string, unknown>;
  description: string;
}

export function defaultSchedules(env: NodeJS.ProcessEnv = process.env): ScheduleDef[] {
  return [
    { name: 'backup.daily', cron: env.BACKUP_CRON || '0 2 * * *', type: 'backup.run', description: 'Encrypted backup, copied to the mirror, then pruned by the 7/4/12 retention rule.' },
    { name: 'backup.drill', cron: '0 3 1 * *', type: 'backup.drill', description: 'Monthly restore drill: the newest backup is restored into a scratch database and compared with its manifest.' },
    { name: 'audit.verify', cron: '0 4 * * 0', type: 'audit.verify', description: 'Weekly check of the whole audit hash chain and of the security event chain; the result is a security event.' },
    { name: 'calibration.due', cron: '15 6 * * *', type: 'calibration.due', description: 'Daily: announces instruments due for calibration within 30 days, and overdue ones (event instrument.calibration_due).' },
    { name: 'artifacts.cleanup', cron: '30 3 * * *', type: 'artifacts.cleanup', description: 'Deletes generated documents (Certificate of Analysis PDFs) after their 30-day retention.' },
    ...EM_SCHEDULES,
    ...AUDIT_SCHEDULES,
    ...STABILITY_SCHEDULES,
    ...TRAINING_SCHEDULES,
    ...REAGENT_SCHEDULES,
    ...TAT_SCHEDULES,
    ...OOT_SCHEDULES,
    ...PERIODIC_SCHEDULES,
  ];
}

export const SCHEDULES: ScheduleDef[] = defaultSchedules();
