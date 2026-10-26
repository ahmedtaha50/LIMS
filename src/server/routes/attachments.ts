// Domain: raw-data files attached to a sample or one of its results (roadmap M20). Owned by r2-raw-data.
//
//   POST /samples/:id/attachments?fileName&resultId&description   the file itself as the body (Content-Type application/octet-stream),
//                                                                  streamed into the blob store; 201 with the register row
//   GET  /samples/:id/attachments                                  the register of the sample
//   GET  /attachments/:id/content                                  the file, after re-hashing it; 409 (and an audit entry) when the
//                                                                  stored file is missing or does not match its sha256
// The body is never parsed as JSON or base64, so the size limit is ATTACHMENT_MAX_BYTES, not express.json's 100 kB. The type comes from
// the file's first bytes (src/server/blobs/sniff.ts). Files are added by the people who enter results, while the sample is Logged or
// in Testing; never once it is Approved or Rejected (423). Nothing is ever replaced or removed (append-only register).
// Who may call what is in src/server/authz/routeTable.ts (result.enter to add, sample.view to read).
import type { Request, Response } from 'express';
import { pipeline } from 'stream/promises';
import { randomBytes } from 'crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { results, samples } from '../../db/schema';
import { attachments } from '../../db/schema/rawdata';
import { writeAudit } from '../../db/utils';
import { RESULT_ENTRY_ROLES } from '../../lib/constants/results';
import { blobDir, detectKind, maxAttachmentBytes, openBlob, stageBlob, verifyBlob, BlobTooLargeError } from '../blobs';
import { type Db, type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, withTransaction, type Executor } from '../core/tx';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

/** Query of POST /samples/:id/attachments. The uploader, time, hash, size and type are the server's. */
export const attachmentUploadQuerySchema = z.object({
  fileName: z.string('fileName is required.').trim().min(1, 'fileName is required.').max(255, 'fileName is too long (at most 255 characters).')
    .refine(n => !/[\\/\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..', 'fileName must be a plain file name (no folder, no control character).'),
  resultId: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000, 'description is too long (at most 1000 characters).').optional(),
}).strict();

/** The states in which raw data is added: before and during testing. */
const OPEN_STATES = ['Logged', 'Testing'];

function assertSampleOpen(sample: { id: string; state: string }) {
  if (sample.state === 'Approved' || sample.state === 'Rejected') {
    throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: Sample ${sample.id} is ${sample.state}; its raw data can no longer be added to.`);
  }
  if (!OPEN_STATES.includes(sample.state)) {
    throw new AppError(409, 'SAMPLE_NOT_IN_TESTING', `Raw data is attached while the sample is ${OPEN_STATES.join(' or ')}; sample ${sample.id} is ${sample.state}.`);
  }
}

async function loadSample(ex: Executor, id: string) {
  const [s] = await ex.select().from(samples).where(eq(samples.id, id)).limit(1);
  if (!s) throw new NotFoundError(`Sample ${id} was not found.`);
  return s;
}

const present = (row: typeof attachments.$inferSelect) => ({ ...row, uploadedAt: row.uploadedAt.toISOString() });

/** RFC 6266: an ASCII fallback name and the exact name in UTF-8. */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function integrityFailure(db: Db, user: { id: string }, row: typeof attachments.$inferSelect, problem: string) {
  await withTransaction(db, tx => writeAudit(tx, user.id, 'IntegrityCheckFailed', 'Attachment', row.id, 'sha256', row.sha256, problem,
    `Download refused: ${row.fileName} (sample ${row.sampleId}) registered with sha256 ${row.sha256}; ${problem}.`));
}

export const attachmentsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/samples/:id/attachments', requireAuth, validate(attachmentUploadQuerySchema, 'query'), async (req: Request, res: Response) => {
    const user = (req as any).user as { id: string; role: string };
    const sampleId = String(req.params.id);
    const q = req.query as unknown as z.infer<typeof attachmentUploadQuerySchema>;
    if (!RESULT_ENTRY_ROLES.includes(user.role)) {
      throw new ForbiddenError(`Forbidden: raw data is attached by ${RESULT_ENTRY_ROLES.join(' or ')}, who enter the results.`);
    }
    if (!req.is('application/octet-stream')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file itself as the request body with Content-Type: application/octet-stream.');
    }
    assertSampleOpen(await loadSample(db, sampleId));
    if (q.resultId) {
      const [r] = await db.select({ sampleId: results.sampleId }).from(results).where(eq(results.id, q.resultId)).limit(1);
      if (!r || r.sampleId !== sampleId) throw new NotFoundError(`Result ${q.resultId} is not a result of sample ${sampleId}.`);
    }
    const limit = maxAttachmentBytes();
    const declared = Number(req.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > limit) throw new BlobTooLargeError(limit);

    const dir = blobDir();
    const staged = await stageBlob(req, { dir, maxBytes: limit });
    try {
      if (staged.bytes === 0) throw new BadRequestError('The file is empty.');
      const kind = detectKind(staged.head, q.fileName, staged.bytes <= staged.head.length);
      if (!kind.ok) throw new AppError(415, 'ATTACHMENT_TYPE_REFUSED', kind.reason);
      // The file is in the store before its register row exists, so no row ever names a file that is not there. If the transaction
      // below fails, the stored file is simply not referenced (content-addressed: it is harmless and reused by an identical upload).
      await staged.commit();

      const row = await withTransaction(db, async (tx) => {
        assertSampleOpen(await lockRow(tx, samples, sampleId));
        const values = {
          id: `att-${randomBytes(8).toString('hex')}`, sampleId, resultId: q.resultId ?? null, fileName: q.fileName,
          mediaType: kind.value.mediaType, kind: kind.value.kind, bytes: staged.bytes, sha256: staged.sha256,
          description: q.description || null, uploadedBy: user.id, uploadedAt: new Date(),
        };
        await tx.insert(attachments).values(values);
        await writeAudit(tx, user.id, 'Create', 'Attachment', values.id, 'all', '', JSON.stringify({
          sampleId, resultId: values.resultId, fileName: values.fileName, mediaType: values.mediaType, bytes: values.bytes, sha256: values.sha256,
        }), `Raw data attached to ${q.resultId ? `result ${q.resultId} of ` : ''}sample ${sampleId}`);
        return values;
      });
      res.status(201).json({ attachment: present(row as typeof attachments.$inferSelect) });
    } finally {
      await staged.discard();
    }
  });

  router.get('/samples/:id/attachments', requireAuth, async (req, res) => {
    const sampleId = String(req.params.id);
    await loadSample(db, sampleId);
    const rows = await db.select().from(attachments).where(eq(attachments.sampleId, sampleId)).orderBy(asc(attachments.uploadedAt));
    res.json({ attachments: rows.map(present) });
  });

  router.get('/attachments/:id/content', requireAuth, async (req, res) => {
    const user = (req as any).user as { id: string };
    const [row] = await db.select().from(attachments).where(eq(attachments.id, String(req.params.id))).limit(1);
    if (!row) throw new NotFoundError(`Attachment ${req.params.id} was not found.`);
    const dir = blobDir();
    const check = await verifyBlob(dir, row.sha256);
    if (!check.ok) {
      const problem = check.problem === 'missing' ? 'the file is missing from the blob store' : `the stored file hashes to ${check.actual}`;
      await integrityFailure(db, user, row, problem);
      throw new AppError(409, 'ATTACHMENT_INTEGRITY_FAILED',
        `${row.fileName} cannot be released: ${problem}, not to its registered sha256 ${row.sha256}. The event is recorded in the audit trail; restore the file from a backup.`);
    }
    res.setHeader('Content-Type', row.mediaType);
    res.setHeader('Content-Length', String(check.bytes));
    res.setHeader('Content-Disposition', disposition(row.fileName));
    res.setHeader('X-Content-SHA256', row.sha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(openBlob(dir, row.sha256), res);
  });

  return router;
};
