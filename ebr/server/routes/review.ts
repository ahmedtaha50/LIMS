import type { Response } from 'express';
import { z } from 'zod';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { route, type Actor } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import * as svc from '../review/service.js';

const password = z.string().min(1).max(200);
const tx = <T>(pool: Pool, actor: Actor | null, res: Response, fn: (x: svc.Ctx) => Promise<T>) =>
  withTx(pool, (c) => fn({ c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }));
const p = (params: Record<string, string>, k: string) => params[k] as string;

export const routes = [
  route({ method: 'GET', path: '/api/batches/:id/review', permission: 'batch.read', summary: 'The review items, the review and the disposition of a batch', handler: ({ pool, params }) => svc.reviewView(pool, p(params, 'id')) }),
  route({ method: 'POST', path: '/api/batches/:id/review', permission: 'review.perform', summary: 'Start the review by exception of a completed batch', status: 201, handler: ({ pool, actor, res, params }) => tx(pool, actor, res, (x) => svc.startReview(x, p(params, 'id'))) }),
  route({
    method: 'POST', path: '/api/batches/:id/review/items/:itemId', permission: 'review.perform', summary: 'Sign one review item as reviewed',
    input: strict({ password, note: z.string().max(1000).optional() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.acknowledge(x, p(params, 'id'), p(params, 'itemId'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/review/complete', permission: 'review.perform', summary: 'Complete the review', input: strict({ version, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.completeReview(x, p(params, 'id'), input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/release', permission: 'batch.release', summary: 'Release the batch (QA signature, after a complete review)', input: strict({ password, comment: z.string().max(1000).optional() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.dispose(x, p(params, 'id'), 'released', input)),
  }),
  route({
    method: 'POST', path: '/api/batches/:id/reject', permission: 'batch.release', summary: 'Reject the batch, with a reason', input: strict({ password, comment: z.string().min(3).max(1000) }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.dispose(x, p(params, 'id'), 'rejected', input)),
  }),
  route({
    method: 'GET', path: '/api/batches/:id/certified-copy', permission: 'batch.read', summary: 'The batch record as a certified copy (PDF), registered by its SHA-256',
    handler: async ({ pool, params, res, actor }) => {
      const { pdf, sha256, batchNumber } = await svc.certifiedCopy(pool, p(params, 'id'), actor!.username);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="batch-${batchNumber.replace(/[^A-Za-z0-9._-]/g, '_')}-certified-copy.pdf"`);
      res.setHeader('X-Certified-Copy-SHA256', sha256);
      res.status(200).end(pdf);
    },
  }),
  route({
    method: 'POST', path: '/api/certified-copies/verify', permission: 'batch.read', summary: 'Is this PDF a certified copy that the system issued, unchanged?',
    input: strict({ pdfBase64: z.string().min(10).max(1_300_000) }),
    handler: ({ pool, input }) => svc.verifyCopy(pool, Buffer.from(input.pdfBase64, 'base64')),
  }),
];
