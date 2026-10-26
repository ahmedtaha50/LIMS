// Domain: controlled documents (roadmap M28). Owned by r2-docs-training. The rules are in src/server/documents.ts.
//
//   GET  /documents                              the register: Effective and open version, periodic review date      doc.view
//   POST /documents                              a new document and its revision 1 (Draft, author = actor)          doc.author
//   GET  /documents/:id                          the document, every version, their signatures                      doc.view
//   POST /documents/:id/revise                   the next revision as a Draft (one open version per document)       doc.author
//   PUT  /document-versions/:id                  title, change summary of the actor's Draft (version predicate)     doc.author
//   PUT  /document-versions/:id/file?fileName&expectedVersion   the file itself (application/octet-stream)    doc.author
//   POST /document-versions/:id/submit           authorship signature, Draft -> InReview                           doc.author
//   POST /document-versions/:id/review           review signature                                                   doc.review
//   POST /document-versions/:id/approve          approval signature, InReview -> Approved                           doc.approve
//   POST /document-versions/:id/return           back to Draft with a reason                                        doc.review
//   POST /document-versions/:id/effective        QA signature, Approved -> Effective, previous one Superseded       doc.approve
//   POST /document-versions/:id/obsolete         withdrawal signature with a reason, Effective -> Obsolete           doc.approve
//   GET  /document-versions/:id/content          the file after re-hashing it (409 + audit entry when it differs)   doc.view
//   POST /document-versions/:id/print            a numbered controlled copy (print log)                             doc.print
//   GET  /document-versions/:id/prints           the print log of a version                                         doc.view
// Who may call what is in src/server/authz/routeTable.ts; the actor is always req.user.
import type { Request, Response } from 'express';
import { pipeline } from 'stream/promises';
import type { z } from 'zod';
import { blobDir, detectKind, maxAttachmentBytes, openBlob, stageBlob, verifyBlob, BlobTooLargeError } from '../blobs';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import {
  assertUploadAllowed, attachFile, createDocument, documentDetail, DOCUMENT_FILE_KINDS, findVersion, listDocuments, listPrints, printControlledCopy,
  recordIntegrityFailure, returnToDraft, reviseDocument, signStep, updateDraft,
} from '../documents';
import { AppError, BadRequestError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import {
  documentCreateSchema, documentReviseSchema, versionFileQuerySchema, versionObsoleteSchema, versionPrintSchema, versionReturnSchema, versionSignSchema,
  versionUpdateSchema,
} from '../training/schemas';

const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export const documentsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actorOf = (req: Request) => (req as any).user as { id: string; role: string; name: string };

  router.get('/documents', requireAuth, async (_req, res) => {
    res.json(await listDocuments(db));
  });

  router.post('/documents', requireAuth, validate(documentCreateSchema), async (req, res) => {
    res.json(await createDocument(db, actorOf(req), req.body as z.infer<typeof documentCreateSchema>));
  });

  router.get('/documents/:id', requireAuth, async (req, res) => {
    res.json(await documentDetail(db, String(req.params.id)));
  });

  router.post('/documents/:id/revise', requireAuth, validate(documentReviseSchema), async (req, res) => {
    res.json(await reviseDocument(db, actorOf(req), String(req.params.id)));
  });

  router.put('/document-versions/:id', requireAuth, validate(versionUpdateSchema), async (req, res) => {
    res.json(await updateDraft(db, actorOf(req), String(req.params.id), req.body as z.infer<typeof versionUpdateSchema>));
  });

  // The body is the file: never parsed as JSON, so the limit is ATTACHMENT_MAX_BYTES, not express.json's.
  router.put('/document-versions/:id/file', requireAuth, validate(versionFileQuerySchema, 'query'), async (req: Request, res: Response) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const q = req.query as unknown as z.infer<typeof versionFileQuerySchema>;
    if (!req.is('application/octet-stream')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file itself as the request body with Content-Type: application/octet-stream.');
    }
    await assertUploadAllowed(db, actor, id, q.expectedVersion);
    const limit = maxAttachmentBytes();
    const declared = Number(req.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > limit) throw new BlobTooLargeError(limit);
    const dir = blobDir();
    const staged = await stageBlob(req, { dir, maxBytes: limit });
    try {
      if (staged.bytes === 0) throw new BadRequestError('The file is empty.');
      const kind = detectKind(staged.head, q.fileName, staged.bytes <= staged.head.length);
      if (!kind.ok) throw new AppError(415, 'DOCUMENT_TYPE_REFUSED', kind.reason);
      if (!DOCUMENT_FILE_KINDS.includes(kind.value.kind)) {
        throw new AppError(415, 'DOCUMENT_TYPE_REFUSED', `A controlled document is a PDF, a Word or Excel file, or plain text; ${q.fileName} is ${kind.value.kind}.`);
      }
      // The file is in the store before the row names it (content-addressed: an unreferenced file is harmless).
      await staged.commit();
      res.json(await attachFile(db, actor, id, q.expectedVersion, { fileName: q.fileName, mediaType: kind.value.mediaType, bytes: staged.bytes, sha256: staged.sha256 }));
    } finally {
      await staged.discard();
    }
  });

  for (const step of ['submit', 'review', 'approve', 'effective'] as const) {
    router.post(`/document-versions/:id/${step}`, requireAuth, validate(versionSignSchema), async (req, res) => {
      const { password, totpCode, reason, expectedVersion } = req.body as z.infer<typeof versionSignSchema>;
      res.json(await signStep({ db, req, actor: actorOf(req), step, id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason }));
    });
  }

  router.post('/document-versions/:id/obsolete', requireAuth, validate(versionObsoleteSchema), async (req, res) => {
    const { password, totpCode, reason, expectedVersion } = req.body as z.infer<typeof versionObsoleteSchema>;
    res.json(await signStep({ db, req, actor: actorOf(req), step: 'obsolete', id: String(req.params.id), expectedVersion, credentials: { password, totpCode }, reason }));
  });

  router.post('/document-versions/:id/return', requireAuth, validate(versionReturnSchema), async (req, res) => {
    res.json(await returnToDraft(db, actorOf(req), String(req.params.id), req.body as z.infer<typeof versionReturnSchema>));
  });

  router.get('/document-versions/:id/content', requireAuth, async (req, res) => {
    const v = await findVersion(db, String(req.params.id));
    if (!v.fileSha256 || !v.fileName) throw new NotFoundError(`Revision ${v.revision} has no file.`);
    const dir = blobDir();
    const check = await verifyBlob(dir, v.fileSha256);
    if (!check.ok) {
      const problem = check.problem === 'missing' ? 'the file is missing from the blob store' : `the stored file hashes to ${check.actual}`;
      await recordIntegrityFailure(db, actorOf(req), v, problem);
      throw new AppError(409, 'DOCUMENT_INTEGRITY_FAILED',
        `${v.fileName} cannot be released: ${problem}, not to its registered sha256 ${v.fileSha256}. The event is recorded in the audit trail; restore the file from a backup.`);
    }
    res.setHeader('Content-Type', v.mediaType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(check.bytes));
    res.setHeader('Content-Disposition', disposition(v.fileName));
    res.setHeader('X-Content-SHA256', v.fileSha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(openBlob(dir, v.fileSha256), res);
  });

  router.post('/document-versions/:id/print', requireAuth, validate(versionPrintSchema), async (req, res) => {
    res.status(201).json(await printControlledCopy(db, actorOf(req), String(req.params.id), req.body as z.infer<typeof versionPrintSchema>));
  });

  router.get('/document-versions/:id/prints', requireAuth, async (req, res) => {
    res.json(await listPrints(db, String(req.params.id)));
  });

  return router;
};
