// Domain: release. Owned by r1-results-oos (roadmap M10).
//
// POST /traceability/batch/:batch/release: QA's signature (signRecord, BATCH_RELEASE, entity BatchRelease = the batch name). Refused
// (400 RELEASE_BLOCKED, listing every reason) while any release blocker (src/server/release-blockers) reports something; the blockers
// are checked before the signature is asked for and again inside the signing transaction, under a lock on the batch's samples.
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { batchReleases, samples } from '../../db/schema';
import { batchReleaseSchema } from '../../lib/validations/release';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { type Executor } from '../core/tx';
import { getMeaning, signRecord } from '../esign';
import { emitEvent } from '../events/emit';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { findReleaseBlockers } from '../release-blockers';
import { assertTransition } from '../workflow/entityStates';

const DEFAULT_DISPOSITION = 'Batch meets all registered quality specifications and GMP standards. Formally released for commercial distribution.';

async function assertReleasable(ex: Executor, batch: string) {
  const problems = await findReleaseBlockers(ex, batch);
  if (problems.length) throw new AppError(400, 'RELEASE_BLOCKED', `RELEASE_BLOCKED: Batch ${batch} cannot be released. ${problems.join(' ')}`, problems);
}

export const releaseRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/traceability/batch/:batch/release', requireAuth, validate(batchReleaseSchema), async (req, res) => {
    const batch = String(req.params.batch);
    const user = (req as any).user;
    const { password, totpCode, reason, dispositionRecommendation } = req.body as { password: string; totpCode?: string; reason?: string; dispositionRecommendation?: string };

    if (!['Admin', 'QA'].includes(user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Forbidden: Only Qualified Persons (QP) or Quality Assurance Officers can authorize Batch Release.');
    }
    const [existing] = await db.select().from(batchReleases).where(eq(batchReleases.batch, batch)).limit(1);
    assertTransition('batchRelease', existing?.status ?? 'Quarantine Hold', 'Released');
    await assertReleasable(db, batch);

    const { result, signature } = await signRecord({
      db, user, meaningCode: 'BATCH_RELEASE', credentials: { password, totpCode },
      reason: reason || 'Batch manufactured and tested in full compliance with GMP and the Marketing Authorization',
      entityType: 'BatchRelease', entityId: batch, context: securityEventContext(req),
      execute: async (tx, afterCommit) => {
        // Lock the batch's samples: no sample of the batch can move or gain a result while the release is decided and written.
        await tx.select({ id: samples.id }).from(samples).where(eq(samples.batch, batch)).for('update');
        await assertReleasable(tx, batch);
        const releasedAt = new Date();
        // Inserted, never upserted: the unique batch makes a second release fail instead of overwriting the first.
        const [row] = await tx.insert(batchReleases).values({
          id: `BR-${randomBytes(4).toString('hex').toUpperCase()}`, batch, status: 'Released',
          dispositionRecommendation: dispositionRecommendation || DEFAULT_DISPOSITION,
          releasedBy: user.id, releasedAt, meaning: (await getMeaning(tx, 'BATCH_RELEASE'))?.text ?? null, version: 1,
        }).returning();
        // Announced with the signature's transaction (r2-events, roadmap M23): no event for a release that rolls back.
        await emitEvent(tx, { type: 'batch.released', payload: { batch, releaseId: row.id }, entity: 'BatchRelease', entityId: batch, actorId: user.id }, afterCommit);
        return { recordVersion: row.version, audit: { action: 'Release', field: 'status', oldValue: 'Quarantine', newValue: 'Released', reason: reason || 'Batch release' }, result: row };
      },
    });

    // The signature names the release (entity BatchRelease, the batch); batch_releases.signature_id, content_hash and audit_entry_id
    // are v0.1.0's links and stay empty: writing them would be a second write after the signed transaction.
    res.json({
      success: true,
      message: `Batch ${batch} officially released for market distribution. 21 CFR Part 11 electronic signature applied.`,
      release: { batch, status: 'Released', releasedAt: result.releasedAt, releasedBy: user.name || user.email, signatureId: signature.id, contentHash: signature.contentHash },
    });
  });

  return router;
};
