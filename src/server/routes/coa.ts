/**
 * Domain: the controlled Certificate of Analysis and the register of generated documents (roadmap M25). r2-coa-reports owns this file;
 * the work is in src/server/reports. Who may call each route: src/server/authz/routeTable.ts.
 *
 *   GET  /coa/documents                    the register (batch, sampleId, status filters)          report.view
 *   GET  /coa/documents/:id                one certificate: snapshot, signatures, its copies          report.view
 *   POST /coa/documents/:id/reissue        signed COA_AUTHORISATION, the next issue version          coa.issue
 *   POST /coa/documents/:id/void           signed COA_VOID                                           coa.issue
 *   POST /coa/documents/:id/copies         a controlled copy for the requester (job coa.render)     report.generate
 *   GET  /coa/:sampleId                    the certificates of a sample and what blocks an issue    report.view
 *   POST /coa/:sampleId                    issue: signed COA_AUTHORISATION, 409 unless eligible      coa.issue
 *   GET  /reports/runs/:id                 what was generated, for whom, every delivery             report.view
 *   GET  /reports/runs/:id/pdf             the bytes, for the person the copy was made for          report.generate
 *   GET  /reports/runs/:id/verify          bytes, snapshot and signature checked                    record.verify
 *
 * The status of a rendering job is GET /reports/status/:jobId (src/server/reports.ts, owner only).
 */
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import { documentDetail, downloadRun, issueCoa, listDocuments, reissueCoa, requestCopy, runDetail, sampleCoa, verifyRun, voidCoa } from '../reports/index';
import { coaCopySchema, coaIssueSchema, coaListQuerySchema, coaReissueSchema, coaVoidSchema } from '../reports/schemas';

export const coaRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user as { id: string; role: string };

  // The document routes first: /coa/documents must not be read as a sample id.
  router.get('/coa/documents', requireAuth, validate(coaListQuerySchema, 'query'), async (req, res) => {
    res.json(await listDocuments(db, req.query as any));
  });
  router.get('/coa/documents/:id', requireAuth, async (req, res) => {
    res.json(await documentDetail(db, String(req.params.id)));
  });
  router.post('/coa/documents/:id/reissue', requireAuth, validate(coaReissueSchema), async (req, res) => {
    res.json(await reissueCoa(db, req, actor(req), String(req.params.id), req.body));
  });
  router.post('/coa/documents/:id/void', requireAuth, validate(coaVoidSchema), async (req, res) => {
    res.json(await voidCoa(db, req, actor(req), String(req.params.id), req.body));
  });
  router.post('/coa/documents/:id/copies', requireAuth, validate(coaCopySchema), async (req, res) => {
    res.json(await requestCopy(db, actor(req), String(req.params.id)));
  });
  router.get('/coa/:sampleId', requireAuth, async (req, res) => {
    res.json(await sampleCoa(db, String(req.params.sampleId)));
  });
  router.post('/coa/:sampleId', requireAuth, validate(coaIssueSchema), async (req, res) => {
    res.json(await issueCoa(db, req, actor(req), String(req.params.sampleId), req.body));
  });

  router.get('/reports/runs/:id', requireAuth, async (req, res) => {
    res.json(await runDetail(db, String(req.params.id)));
  });
  router.get('/reports/runs/:id/pdf', requireAuth, async (req, res) => {
    const run = await downloadRun(db, actor(req), String(req.params.id));
    res.setHeader('Content-Type', run.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${run.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-SHA256', run.pdfSha256);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(run.pdf));
  });
  router.get('/reports/runs/:id/verify', requireAuth, async (req, res) => {
    res.json(await verifyRun(db, String(req.params.id)));
  });

  return router;
};
