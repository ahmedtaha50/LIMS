/**
 * The schedule and job handler of out-of-trend evaluation (roadmap M39, r3-spc). r3-spc owns this file; SCHEDULES (./index.ts) and the
 * handler registry (src/server/jobs/handlers/index.ts) list them.
 *
 *   oot.evaluate   hourly at :20: every Approved control-limit baseline is run against the approved results entered after its data
 *                  window, and a rule violation becomes one advisory alert (src/server/stats/alerts.ts). Idempotent. A slot that fell due
 *                  while the server was off runs once at start-up and catches up from the data.
 */
import type { Handler } from '../jobs/types';
import { evaluateAlerts } from '../stats/alerts';
import type { ScheduleDef } from './index';

export const OOT_SCHEDULES: ScheduleDef[] = [
  { name: 'oot.evaluate', cron: '20 * * * *', type: 'oot.evaluate', description: 'Hourly: approved results are checked against the control-limit baselines; a rule violation raises an advisory out-of-trend alert (no result or disposition is changed).' },
];

export const ootEvaluateHandler: Handler = async (_payload, ctx) => evaluateAlerts(ctx.db, { actorId: ctx.job.createdBy ?? undefined });

export const OOT_HANDLERS: Record<string, Handler> = { 'oot.evaluate': ootEvaluateHandler };
