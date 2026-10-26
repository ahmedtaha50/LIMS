// Domain: jobs (roadmap M15). What the queue and the scheduler are doing, for administrators and QA. Mounted by routes/backup.ts
// until routes/index.ts (r1-core) lists it. Job payloads and results are not returned: a job's result belongs to its owner.
import { desc } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { jobs, scheduledJobs } from '../../db/schema';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { ForbiddenError } from '../http/errors';

export const jobsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const adminOrQa: RequestHandler = (req, _res, next) => next(['Admin', 'QA'].includes((req as any).user.role) ? undefined : new ForbiddenError('Unauthorized'));

  router.get('/admin/jobs', requireAuth, adminOrQa, async (_req, res) => {
    const recent = await db.select({
      id: jobs.id, type: jobs.type, status: jobs.status, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, runAt: jobs.runAt,
      createdAt: jobs.createdAt, finishedAt: jobs.finishedAt, createdBy: jobs.createdBy, lockedBy: jobs.lockedBy, lastError: jobs.lastError,
    }).from(jobs).orderBy(desc(jobs.createdAt)).limit(50);
    const schedules = await db.select().from(scheduledJobs).orderBy(scheduledJobs.name);
    res.json({
      jobs: recent,
      schedules: schedules.map(s => ({ name: s.name, cron: s.cron, type: s.type, description: s.description, enabled: s.enabled, nextDueAt: s.nextDueAt, lastEnqueuedAt: s.lastEnqueuedAt, lastJobId: s.lastJobId })),
    });
  });

  return router;
};
