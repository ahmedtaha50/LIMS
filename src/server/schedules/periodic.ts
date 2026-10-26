/**
 * The scheduled periodic-review and archive jobs (roadmap M42). Owned by r3-periodic-archive; SCHEDULES (./index.ts), the handler registry
 * (src/server/jobs/handlers/index.ts) and the event catalog (src/server/events/catalog.ts) list them through the wave gate.
 *
 *   periodic.scan   daily: opens the review of every active plan that falls due within 14 days (evidence snapshot, audit entry), and announces
 *                   open reviews through the events outbox (event periodic.review_due): at 7 days, on the due date, and again every 7 days
 *                   while overdue. Each (review, threshold) is announced once, so two runs never announce the same thing twice.
 *   archive.build  on demand (POST /archive/bundles): builds the bundle of one batch under ARCHIVE_DIR. Long work, so it runs in the queue.
 *   archive.verify weekly: re-hashes every Archived bundle against its manifest; a bundle that no longer verifies is announced
 *                  (event archive.verification_failed) and the failure is recorded on the register.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { archiveBundles, type ReviewKind } from '../../db/schema/periodic';
import { periodicReviewPlans, periodicReviews } from '../../db/schema/periodic';
import { writeAudit } from '../../db/utils';
import { utcToday } from '../../lib/validations/instruments';
import { buildBatchBundle, verifyRegistered } from '../archive';
import type { Db } from '../core/context';
import { withTransaction } from '../core/tx';
import { emitEvent } from '../events/emit';
import { ensureServicePrincipal } from '../jobs/principal';
import { PermanentJobError, type Handler } from '../jobs/types';
import { AppError } from '../http/errors';
import { daysBetween, OPEN_LEAD_DAYS, openReview } from '../periodic';
import { outboxEvents } from '../../db/schema/events';
import type { ScheduleDef } from './index';

export const PERIODIC_SCHEDULES: ScheduleDef[] = [
  { name: 'periodic.scan', cron: '20 6 * * *', type: 'periodic.scan', description: 'Daily: opens the periodic reviews that fall due within 14 days and announces open reviews due or overdue (event periodic.review_due).' },
  { name: 'archive.verify', cron: '40 4 * * 0', type: 'archive.verify', description: 'Weekly: re-hashes every archived bundle against its manifest and announces one that no longer verifies (event archive.verification_failed).' },
];

/** The announcement a review is due for today: 7 (within a week), 0 (due today), or -7, -14, ... (overdue, weekly). null: not yet. */
export function alertThreshold(daysRemaining: number): number | null {
  if (daysRemaining < 0) return -7 * Math.ceil(-daysRemaining / 7);
  if (daysRemaining === 0) return 0;
  if (daysRemaining <= 7) return 7;
  return null;
}

const SCAN_LOCK = 7330;

export async function runPeriodicScan(db: Db, opts: { now?: Date; actorId?: string } = {}) {
  const now = opts.now ?? new Date();
  const today = utcToday(now);
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  const horizon = utcToday(new Date(now.getTime() + OPEN_LEAD_DAYS * 86_400_000));
  let opened = 0, alerts = 0;

  const plans = await db.select().from(periodicReviewPlans).where(and(eq(periodicReviewPlans.status, 'Active'), sql`${periodicReviewPlans.nextDueDate} <= ${horizon}`,
    sql`NOT EXISTS (SELECT 1 FROM periodic_reviews r WHERE r.plan_id = ${periodicReviewPlans.id} AND r.status = 'Open')`)).orderBy(asc(periodicReviewPlans.nextDueDate), asc(periodicReviewPlans.id));
  for (const plan of plans) {
    try { await openReview(db, actorId, plan.id, { now, reason: `Scheduled: periodic.scan (plan ${plan.id} due ${plan.nextDueDate})` }); opened++; }
    catch (e: any) { if (e?.code !== 'REVIEW_OPEN') throw e; } // another run opened it first
  }

  const open = await db.select().from(periodicReviews).where(eq(periodicReviews.status, 'Open')).orderBy(asc(periodicReviews.dueDate), asc(periodicReviews.id));
  for (const r of open) {
    const remaining = daysBetween(today, r.dueDate);
    const threshold = alertThreshold(remaining);
    if (threshold === null) continue;
    const sent = await withTransaction(db, async (tx, afterCommit) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCAN_LOCK})`);
      const [already] = await tx.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.type, 'periodic.review_due'), eq(outboxEvents.entityId, r.id), sql`(${outboxEvents.payload}->>'threshold')::int = ${threshold}`)).limit(1);
      if (already) return false;
      await emitEvent(tx, {
        type: 'periodic.review_due',
        payload: { reviewId: r.id, kind: r.kind as ReviewKind, subjectId: r.subjectId, title: r.title, dueDate: r.dueDate, threshold, daysRemaining: remaining, overdue: remaining < 0 },
        entity: 'PeriodicReview', entityId: r.id, actorId,
      }, afterCommit);
      return true;
    });
    if (sent) alerts++;
  }
  return { opened, alerts };
}

export async function runArchiveVerify(db: Db, opts: { actorId?: string; dir?: string } = {}) {
  const actorId = opts.actorId ?? await ensureServicePrincipal(db);
  const bundles = await db.select().from(archiveBundles).where(eq(archiveBundles.status, 'Archived')).orderBy(asc(archiveBundles.id));
  let failed = 0;
  for (const b of bundles) {
    let ok = false, problems: string[] = [];
    try { const r = await verifyRegistered(db, actorId, b.id, { dir: opts.dir }); ok = r.check.ok; problems = r.check.problems; }
    catch (e) { problems = [(e as Error).message]; }
    if (ok) continue;
    failed++;
    await withTransaction(db, async (tx, afterCommit) => {
      await emitEvent(tx, {
        type: 'archive.verification_failed',
        payload: { bundleId: b.id, subject: b.subjectLabel, problemCount: problems.length },
        entity: 'ArchiveBundle', entityId: b.id, actorId,
      }, afterCommit);
      await writeAudit(tx, actorId, 'VerificationFailed', 'ArchiveBundle', b.id, 'verification', 'ok', 'failed', `Scheduled: archive.verify: ${problems.slice(0, 3).join('; ')}`);
    });
  }
  return { checked: bundles.length, failed };
}

export const periodicScanHandler: Handler = async (_payload, ctx) => runPeriodicScan(ctx.db, { actorId: ctx.job.createdBy ?? undefined });
export const archiveVerifyHandler: Handler = async (_payload, ctx) => runArchiveVerify(ctx.db, { actorId: ctx.job.createdBy ?? undefined });
export const archiveBuildHandler: Handler = async (payload, ctx) => {
  const batchId = String(payload?.batchId ?? '');
  if (!batchId) throw new Error('archive.build needs a batchId.');
  if (!ctx.job.createdBy) throw new Error('archive.build needs the user who asked for it.');
  let bundle;
  try { bundle = await buildBatchBundle(ctx.db, { batchId, actorId: ctx.job.createdBy }); }
  catch (e) { if (e instanceof AppError && e.status < 500) throw new PermanentJobError(e.message); throw e; } // retrying cannot make the batch ready
  return { bundleId: bundle.id, manifestSha256: bundle.manifestSha256, files: bundle.fileCount };
};

export const PERIODIC_HANDLERS: Record<string, Handler> = {
  'periodic.scan': periodicScanHandler,
  'archive.verify': archiveVerifyHandler,
  'archive.build': archiveBuildHandler,
};
