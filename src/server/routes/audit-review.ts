// Domain: audit-trail review and tamper evidence (roadmap M35). Owned by r2-audit-tamper.
//
//   GET  /audit/exceptions?batch=B | ?from=&to=           the rows of the scope and the exceptions among them (review by exception)
//   GET  /audit/reviews[?batch=B]                          signed reviews, newest first; with ?batch, the batch's coverage
//   POST /audit/reviews                                    the signed review (AUDIT_REVIEW) of a batch or of a sequence range
//   GET  /audit/review-settings                            "a signed review is required before release"
//   PUT  /audit/review-settings                            changed only with an e-signature (AUDIT_REVIEW_SETTING)
//   GET  /audit/anchors                                    the anchor folder and the anchors written
//   POST /audit/anchors                                    write an anchor now (the daily job does it on its own)
//   POST /audit/anchors/verify                             compare every anchor file with the database
//   GET  /audit/clock                                      the clock guard: open and past anomalies, whether signing is blocked
//   POST /audit/clock-anomalies/:id/acknowledge            the Administrator's signed acknowledgement (CLOCK_ANOMALY_ACK)
// Who may call what is in src/server/authz/routeTable.ts (audit.view, audit.review, audit.review.settings, audit.verify, clock.acknowledge).
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { auditAnchors, clockAnomalies } from '../../db/schema/audit-review';
import { signatureFields } from '../../lib/validations/signatures';
import { anchorDirectory, verifyAnchors, writeAnchor } from '../audit/anchors';
import { acknowledgeClockAnomaly, openClockAnomalies } from '../audit/clockGuard';
import { createReview, findExceptions, getReviewSettings, listReviews, updateReviewSettings, MAX_RANGE } from '../audit/review';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';

const batchName = z.string().trim().min(1).max(200);
const seq = z.coerce.number().int().min(1);
const credentials = { password: signatureFields.password, totpCode: signatureFields.totpCode };
const comment = z.string().trim().max(4000).optional();

export const auditExceptionsQuery = z.object({ batch: batchName.optional(), from: seq.optional(), to: seq.optional() }).strict()
  .refine(q => (q.batch !== undefined) !== (q.from !== undefined || q.to !== undefined), { message: 'Give either batch, or from and to.' })
  .refine(q => q.batch !== undefined || (q.from !== undefined && q.to !== undefined && q.from <= q.to), { message: 'from and to are both needed, from not after to.' })
  .refine(q => q.batch !== undefined || (q.to! - q.from! + 1) <= MAX_RANGE, { message: `A range spans at most ${MAX_RANGE} entries.` });

export const auditReviewsQuery = z.object({ batch: batchName.optional() }).strict();

export const auditReviewBody = z.discriminatedUnion('scope', [
  // throughSequence: the last entry of the batch the reviewer was shown (GET /audit/exceptions toSequence); the review is refused when the
  // batch has changed since, so a signature never covers an entry its signer did not see.
  z.object({ scope: z.literal('batch'), batch: batchName, throughSequence: z.number().int().min(1), comment, reason: signatureFields.reason, ...credentials }).strict(),
  z.object({ scope: z.literal('range'), fromSequence: z.number().int().min(1), toSequence: z.number().int().min(1), comment, reason: signatureFields.reason, ...credentials }).strict()
    .refine(b => b.fromSequence <= b.toSequence, { message: 'fromSequence must not be after toSequence.' }),
]);
/** The keys POST /audit/reviews accepts, for the route table (a union has no single shape). */
export const AUDIT_REVIEW_KEYS = ['scope', 'batch', 'throughSequence', 'fromSequence', 'toSequence', 'comment', 'reason', 'password', 'totpCode'] as const;

export const auditReviewSettingsBody = z.object({
  requiredForRelease: z.boolean(), expectedVersion: z.number().int().min(0), reason: z.string().trim().min(1).max(1000), ...credentials,
}).strict();

export const clockAcknowledgeBody = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(1000), ...credentials }).strict();

export const emptyAuditBody = z.object({}).strict();

export const auditReviewRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user;

  router.get('/audit/exceptions', requireAuth, validate(auditExceptionsQuery, 'query'), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof auditExceptionsQuery>;
    res.json(await findExceptions(db, q.batch !== undefined ? { kind: 'batch', batch: q.batch } : { kind: 'range', from: q.from!, to: q.to! }));
  });

  router.get('/audit/reviews', requireAuth, validate(auditReviewsQuery, 'query'), async (req, res) => {
    res.json(await listReviews(db, { batch: (req.query as any).batch }));
  });

  router.post('/audit/reviews', requireAuth, validate(auditReviewBody), async (req, res) => {
    res.json(await createReview(db, actor(req), req.body, securityEventContext(req)));
  });

  router.get('/audit/review-settings', requireAuth, async (_req, res) => {
    res.json(await getReviewSettings(db));
  });

  router.put('/audit/review-settings', requireAuth, validate(auditReviewSettingsBody), async (req, res) => {
    res.json(await updateReviewSettings(db, actor(req), req.body, securityEventContext(req)));
  });

  router.get('/audit/anchors', requireAuth, async (_req, res) => {
    const { dir, secondPath } = anchorDirectory();
    const anchors = await db.select().from(auditAnchors).orderBy(desc(auditAnchors.sequence), desc(auditAnchors.anchoredAt)).limit(100);
    res.json({ directory: dir, secondPath, anchors });
  });

  router.post('/audit/anchors', requireAuth, validate(emptyAuditBody), async (req, res) => {
    const { file, anchor } = await writeAnchor(db, { dir: anchorDirectory().dir, actorId: actor(req).id });
    res.json({ file, anchor });
  });

  router.post('/audit/anchors/verify', requireAuth, validate(emptyAuditBody), async (req, res) => {
    res.json(await verifyAnchors(db, { dir: anchorDirectory().dir, actorId: actor(req).id }));
  });

  router.get('/audit/clock', requireAuth, async (_req, res) => {
    const anomalies = await db.select().from(clockAnomalies).orderBy(desc(clockAnomalies.detectedAt)).limit(100);
    res.json({ anomalies, signingBlocked: (await openClockAnomalies(db)).length > 0, serverTime: new Date().toISOString() });
  });

  router.post('/audit/clock-anomalies/:id/acknowledge', requireAuth, validate(clockAcknowledgeBody), async (req, res) => {
    res.json(await acknowledgeClockAnomaly(db, actor(req), String(req.params.id), req.body, securityEventContext(req)));
  });

  return router;
};
