/**
 * The schedule and job handler of the stability programme (roadmap M31). r2-stability owns this file; SCHEDULES (./index.ts) and the
 * handler registry (src/server/jobs/handlers/index.ts) list them.
 *
 *   stability.timepoints   hourly at :05: the pull calendar sweep (src/server/stability/sweep.ts). Scheduled -> Due -> Missed by the
 *                          calendar (a missed pull opens its deviation), and pulled timepoints follow their sample. A slot that fell due
 *                          while the server was off runs once at start-up, and the sweep catches up from the date.
 */
import type { Handler } from '../jobs/types';
import { runStabilitySweep } from '../stability/sweep';
import type { ScheduleDef } from './index';

export const STABILITY_SCHEDULES: ScheduleDef[] = [
  { name: 'stability.timepoints', cron: '5 * * * *', type: 'stability.timepoints', description: 'Hourly: stability pulls whose window opened become Due; a window that closed without a pull becomes Missed and opens a deviation; pulled timepoints follow their sample (InTesting, Complete).' },
];

export const stabilityTimepointsHandler: Handler = async (_payload, ctx) => runStabilitySweep(ctx.db, { actorId: ctx.job.createdBy ?? undefined });

export const STABILITY_HANDLERS: Record<string, Handler> = { 'stability.timepoints': stabilityTimepointsHandler };
