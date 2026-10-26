/**
 * The scheduled adverse-trend evaluation of the environmental monitoring programme (roadmap M32). r2-em owns this file; SCHEDULES
 * (./index.ts) and the handler registry (src/server/jobs/handlers/index.ts) list it (wave gate).
 *
 *   em.trends   daily 05:40: the rules of src/server/em/trends.ts over the last year of results, as the service principal. A finding
 *               already flagged is not flagged again.
 */
import { evaluateTrends } from '../em/trends';
import { PermanentJobError, type Handler } from '../jobs/types';
import type { ScheduleDef } from './index';

export const EM_SCHEDULES: ScheduleDef[] = [
  { name: 'em.trends', cron: '40 5 * * *', type: 'em.trends', description: 'Daily: environmental monitoring adverse trends (3 consecutive alert-level results at a point, 2 action-level results within 30 days, a recurring organism in a room).' },
];

export const emTrendsHandler: Handler = async (_payload, ctx) => {
  if (!ctx.job.createdBy) throw new PermanentJobError('The job has no owner.');
  const { evaluated, flagged } = await evaluateTrends(ctx.db, { actorId: ctx.job.createdBy });
  return { evaluated, flagged: flagged.length };
};

export const EM_HANDLERS: Record<string, Handler> = { 'em.trends': emTrendsHandler };
