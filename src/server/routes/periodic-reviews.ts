// Domain: periodic review, retention and legal hold, batch archive (roadmap M42, r3-periodic-archive). Registered in src/server/routes/index.ts
// and given its rules in src/server/authz/routeTable.ts by the wave gate (docs/changes/r3-periodic-archive.gate.patch).
//
//   GET  /periodic-reviews/plans                   plans and their next due dates                                                periodic.view
//   POST /periodic-reviews/plans                   create a plan (kind, subject, interval, first due date, checklist)             periodic.manage
//   PUT  /periodic-reviews/plans/:id               change interval, due date, checklist or retire it (reason)                     periodic.manage
//   POST /periodic-reviews/plans/:id/open          open the review now (evidence snapshot)                                         periodic.manage
//   GET  /periodic-reviews/due                     open reviews and plans due within 30 days or overdue (the QA dashboard feed)   periodic.view
//   GET  /periodic-reviews                         reviews (?status ?kind)                                                        periodic.view
//   GET  /periodic-reviews/:id                     one review with its evidence, plan checklist and signatures                    periodic.view
//   PUT  /periodic-reviews/:id                     save the checklist answers, findings and summary                               periodic.manage
//   POST /periodic-reviews/:id/complete            conclude with a QA e-signature (PERIODIC_REVIEW)                               periodic.sign
//   POST /periodic-reviews/:id/cancel              cancel an open review (reason)                                                 periodic.manage
//   GET  /retention/policies                       retention per record class (no number = kept indefinitely)                     archive.view
//   PUT  /retention/policies/:recordClass          set the years with a QA e-signature (RETENTION_POLICY)                         retention.manage
//   GET  /retention/holds, POST /retention/holds, POST /retention/holds/:id/release     legal holds, QA e-signature (LEGAL_HOLD)    archive.view / retention.manage
//   GET  /retention/candidates                     archived records whose retention has run out and that no hold covers           archive.view
//   GET  /retention/flags, POST /retention/flags, POST /retention/flags/:id/withdraw    flag an archived record for disposal REVIEW  archive.view / retention.manage
//   GET  /archive/bundles, GET /archive/bundles/:id                                    the register                                archive.view
//   POST /archive/bundles                          queue the bundle of a batch (job archive.build)                                archive.manage
//   POST /archive/bundles/:id/verify               re-hash the bundle against its manifest                                        archive.manage
//   POST /archive/bundles/:id/restore-check        dry-run restore of the bundle into the live database (rolled back)             archive.manage
//   POST /archive/bundles/:id/decision             QA e-signature (ARCHIVE_DECISION): the batch's records become archived          archive.manage
//   GET  /archive/records/:entityType/:entityId    whether a record is archived                                                   archive.view
import path from 'path';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { archiveBundles, periodicReviewPlans, periodicReviews, REVIEW_KINDS } from '../../db/schema/periodic';
import { signatures } from '../../db/schema';
import { buildSchema, archiveDir, archivedEntry, checkBatchPreconditions, decideArchive, decideSchema, listBundles, restoreArchive, verifyRegistered } from '../archive';
import { securityEventContext } from '../auth/events';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { publishTask } from '../rabbitmq';
import {
  cancelReview, completeReview, createPlan, dueReviews, openReview, planCreateSchema, planUpdateSchema, reviewCancelSchema, reviewCompleteSchema, reviewDraftSchema, saveDraft, updatePlan,
} from '../periodic';
import {
  flagForPurge, flagSchema, flagWithdrawSchema, holdPlaceSchema, holdReleaseSchema, listFlags, listHolds, listPolicies, placeHold, policySchema, purgeCandidates, releaseHold,
  setPolicy, withdrawFlag,
} from '../retention';

export const reviewListQuerySchema = z.object({ status: z.enum(['Open', 'Completed', 'Cancelled']).optional(), kind: z.enum(REVIEW_KINDS).optional() }).strict();
const user = (req: any) => req.user as { id: string };

export const periodicRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  // ---- periodic review ------------------------------------------------------------------------------------------------------------
  router.get('/periodic-reviews/plans', requireAuth, async (_req, res) => {
    res.json(await db.select().from(periodicReviewPlans).orderBy(periodicReviewPlans.nextDueDate, periodicReviewPlans.id));
  });
  router.post('/periodic-reviews/plans', requireAuth, validate(planCreateSchema), async (req, res) => {
    res.status(201).json(await createPlan(db, user(req).id, req.body));
  });
  router.put('/periodic-reviews/plans/:id', requireAuth, validate(planUpdateSchema), async (req, res) => {
    res.json(await updatePlan(db, user(req).id, String(req.params.id), req.body));
  });
  router.post('/periodic-reviews/plans/:id/open', requireAuth, async (req, res) => {
    res.status(201).json(await openReview(db, user(req).id, String(req.params.id)));
  });
  router.get('/periodic-reviews/due', requireAuth, async (_req, res) => {
    res.json(await dueReviews(db));
  });
  router.get('/periodic-reviews', requireAuth, validate(reviewListQuerySchema, 'query'), async (req, res) => {
    const q = req.query as z.infer<typeof reviewListQuerySchema>;
    const rows = await db.select({
      id: periodicReviews.id, planId: periodicReviews.planId, kind: periodicReviews.kind, subjectId: periodicReviews.subjectId, title: periodicReviews.title,
      dueDate: periodicReviews.dueDate, status: periodicReviews.status, conclusion: periodicReviews.conclusion, openedAt: periodicReviews.openedAt,
      completedAt: periodicReviews.completedAt, version: periodicReviews.version,
    }).from(periodicReviews).orderBy(desc(periodicReviews.dueDate), periodicReviews.id);
    res.json(rows.filter(r => (!q.status || r.status === q.status) && (!q.kind || r.kind === q.kind)));
  });
  router.get('/periodic-reviews/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [review] = await db.select().from(periodicReviews).where(eq(periodicReviews.id, id)).limit(1);
    if (!review) throw new NotFoundError(`Review ${id} was not found.`);
    const [plan] = await db.select().from(periodicReviewPlans).where(eq(periodicReviewPlans.id, review.planId)).limit(1);
    const sigs = await db.select().from(signatures).where(eq(signatures.entityId, id)).orderBy(signatures.timestamp);
    res.json({ review, plan, signatures: sigs.filter(s => s.entityType === 'PeriodicReview') });
  });
  router.put('/periodic-reviews/:id', requireAuth, validate(reviewDraftSchema), async (req, res) => {
    res.json(await saveDraft(db, user(req).id, String(req.params.id), req.body));
  });
  router.post('/periodic-reviews/:id/complete', requireAuth, validate(reviewCompleteSchema), async (req, res) => {
    res.json(await completeReview(db, user(req), String(req.params.id), req.body, securityEventContext(req)));
  });
  router.post('/periodic-reviews/:id/cancel', requireAuth, validate(reviewCancelSchema), async (req, res) => {
    res.json(await cancelReview(db, user(req).id, String(req.params.id), req.body));
  });

  // ---- retention and legal hold ---------------------------------------------------------------------------------------------------
  router.get('/retention/policies', requireAuth, async (_req, res) => { res.json(await listPolicies(db)); });
  router.put('/retention/policies/:recordClass', requireAuth, validate(policySchema), async (req, res) => {
    res.json(await setPolicy(db, user(req), String(req.params.recordClass), req.body, securityEventContext(req)));
  });
  router.get('/retention/holds', requireAuth, async (_req, res) => { res.json(await listHolds(db)); });
  router.post('/retention/holds', requireAuth, validate(holdPlaceSchema), async (req, res) => {
    res.status(201).json(await placeHold(db, user(req), req.body, securityEventContext(req)));
  });
  router.post('/retention/holds/:id/release', requireAuth, validate(holdReleaseSchema), async (req, res) => {
    res.json(await releaseHold(db, user(req), String(req.params.id), req.body, securityEventContext(req)));
  });
  router.get('/retention/candidates', requireAuth, async (_req, res) => { res.json(await purgeCandidates(db)); });
  router.get('/retention/flags', requireAuth, async (_req, res) => { res.json(await listFlags(db)); });
  router.post('/retention/flags', requireAuth, validate(flagSchema), async (req, res) => {
    res.status(201).json(await flagForPurge(db, user(req).id, req.body));
  });
  router.post('/retention/flags/:id/withdraw', requireAuth, validate(flagWithdrawSchema), async (req, res) => {
    res.json(await withdrawFlag(db, user(req).id, String(req.params.id), req.body));
  });

  // ---- archive --------------------------------------------------------------------------------------------------------------------
  router.get('/archive/bundles', requireAuth, async (_req, res) => { res.json(await listBundles(db)); });
  router.get('/archive/bundles/:id', requireAuth, async (req, res) => {
    const [bundle] = await db.select().from(archiveBundles).where(eq(archiveBundles.id, String(req.params.id))).limit(1);
    if (!bundle) throw new NotFoundError('Archive bundle not found.');
    const sigs = (await db.select().from(signatures).where(eq(signatures.entityId, bundle.id))).filter(s => s.entityType === 'ArchiveBundle');
    res.json({ bundle, signatures: sigs });
  });
  router.post('/archive/bundles', requireAuth, validate(buildSchema), async (req, res) => {
    const { batchId } = req.body as z.infer<typeof buildSchema>;
    await checkBatchPreconditions(db, batchId); // a batch that cannot be archived is refused now, not after a queue wait
    const jobId = await publishTask('archive.build', { batchId }, { createdBy: user(req).id, dedupeKey: `archive.build:${batchId}` });
    res.status(202).json({ jobId });
  });
  router.post('/archive/bundles/:id/verify', requireAuth, async (req, res) => {
    const { bundle, check } = await verifyRegistered(db, user(req).id, String(req.params.id));
    res.json({ bundleId: bundle.id, ...check });
  });
  router.post('/archive/bundles/:id/restore-check', requireAuth, async (req, res) => {
    const [bundle] = await db.select().from(archiveBundles).where(eq(archiveBundles.id, String(req.params.id))).limit(1);
    if (!bundle) throw new NotFoundError('Archive bundle not found.');
    res.json(await restoreArchive(db, path.join(archiveDir(), bundle.dirName), { dryRun: true }));
  });
  router.post('/archive/bundles/:id/decision', requireAuth, validate(decideSchema), async (req, res) => {
    res.json(await decideArchive(db, user(req), String(req.params.id), req.body, { context: securityEventContext(req) }));
  });
  router.get('/archive/records/:entityType/:entityId', requireAuth, async (req, res) => {
    const hit = await archivedEntry(db, String(req.params.entityType), String(req.params.entityId));
    res.json({ archived: !!hit, record: hit });
  });

  return router;
};
