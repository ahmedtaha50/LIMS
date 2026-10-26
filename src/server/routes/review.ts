// Domain: the review of a sample's raw data (roadmap M20). Owned by r2-raw-data.
//
//   GET  /samples/:id/review-checklist   the server items evaluated now, the attestations a reviewer can record, the latest record
//   POST /samples/:id/review-checklist   a reviewer records the attestations (while Pending Review), with the server items as they stand
//   GET  /samples/:id/result-versions    every value each result has held, with its coded reason and any reintegration signature
//   POST /result-versions/:id/sign       QA approves a reintegration (REINTEGRATION_APPROVAL), never the person who made it
// The rules are in src/server/review.ts and src/server/services/result-hooks/versions.ts; who may call what is in
// src/server/authz/routeTable.ts (sample.view to read, sample.transition to record, result.reintegration.approve to sign).
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { samples } from '../../db/schema';
import { signatureFields } from '../../lib/validations/signatures';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { ATTESTATION_CODES, getChecklist, recordChecklist, type AttestationCode } from '../review';
import { listResultVersions, signReintegration } from '../services/result-hooks/versions';

/** POST /samples/:id/review-checklist. The server items, the reviewer and the time are the server's. */
export const reviewChecklistSchema = z.object({
  attestations: z.array(z.enum(ATTESTATION_CODES as [AttestationCode, ...AttestationCode[]], { error: `Each attestation must be one of ${ATTESTATION_CODES.join(', ')}.` }))
    .min(1, 'Record at least one attestation.')
    .refine(a => new Set(a).size === a.length, 'An attestation is listed twice.'),
  comment: z.string('comment must be text.').trim().max(2000, 'comment is too long (at most 2000 characters).').optional(),
  expectedVersion: z.number('expectedVersion is required.').int().positive('Record version mismatch. Refresh required.'),
}).strict();

/** POST /result-versions/:id/sign. The meaning is the server's (REINTEGRATION_APPROVAL); the reason is required by the catalog. */
export const reintegrationSignSchema = z.object({
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: signatureFields.reason,
}).strict();

export const reviewRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user as { id: string; role: string };

  router.get('/samples/:id/review-checklist', requireAuth, async (req, res) => {
    res.json(await getChecklist(db, String(req.params.id)));
  });

  router.post('/samples/:id/review-checklist', requireAuth, validate(reviewChecklistSchema), async (req, res) => {
    res.status(201).json({ checklist: await recordChecklist(db, actor(req), String(req.params.id), req.body) });
  });

  router.get('/samples/:id/result-versions', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [s] = await db.select({ id: samples.id }).from(samples).where(eq(samples.id, id)).limit(1);
    if (!s) throw new NotFoundError(`Sample ${id} was not found.`);
    res.json({ versions: await listResultVersions(db, id) });
  });

  router.post('/result-versions/:id/sign', requireAuth, validate(reintegrationSignSchema), async (req, res) => {
    res.json(await signReintegration(db, req, actor(req), String(req.params.id), req.body));
  });

  return router;
};
