/**
 * The handler registry (roadmap M15): job type -> function. A new kind of background work is one file in this folder and one line
 * here. Handlers run in the worker with the job's owner as the actor: the user who asked for it, or the service principal.
 */
import type { Handler } from '../types';
import { backupDrillHandler, backupRunHandler } from './backup';
import { calibrationDueHandler } from './events';
import { artifactsCleanupHandler, auditVerifyHandler } from './maintenance';
import { generatePdfHandler } from './pdf';
import { AUDIT_HANDLERS } from '../../schedules/audit';
import { REPORT_HANDLERS } from '../../reports/index';
import { TRAINING_HANDLERS } from '../../training/schedule';
import { EM_HANDLERS } from '../../schedules/em';
import { STABILITY_HANDLERS } from '../../schedules/stability';
import { REAGENT_HANDLERS } from '../../schedules/reagents';
import { TAT_HANDLERS } from '../../schedules/tat';
import { OOT_HANDLERS } from '../../schedules/oot';
import { PERIODIC_HANDLERS } from '../../schedules/periodic';
import { WORKLIST_HANDLERS } from '../../worklists/benchSheet';

export function defaultHandlers(): Record<string, Handler> {
  return {
    generate_gxp_pdf: generatePdfHandler,
    'backup.run': backupRunHandler,
    'backup.drill': backupDrillHandler,
    'artifacts.cleanup': artifactsCleanupHandler,
    'audit.verify': auditVerifyHandler,
    ...AUDIT_HANDLERS,
    'calibration.due': calibrationDueHandler,
    ...EM_HANDLERS,
    ...REPORT_HANDLERS,
    ...STABILITY_HANDLERS,
    ...TRAINING_HANDLERS,
    ...TAT_HANDLERS,
    ...OOT_HANDLERS,
    ...REAGENT_HANDLERS,
    ...WORKLIST_HANDLERS,
    ...PERIODIC_HANDLERS,
  };
}
