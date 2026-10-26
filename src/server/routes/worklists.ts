// Domain: worklists and batch runs (roadmap M33). Owned by r2-worklists; registered in src/server/routes/index.ts and given its rules in
// src/server/authz/routeTable.ts by the wave gate. The rules are in src/server/worklists/service.ts.
//
//   GET  /worklists                          list (?status ?methodCode ?instrumentId ?assigneeId ?from ?to), with item and pending counts   worklist.view
//   GET  /worklists/workload                 per analyst and per instrument: planned, on the bench, pending, overdue                        worklist.view
//   GET  /worklists/candidates?methodCode=   results waiting for a method, on no open worklist                                              worklist.view
//   GET  /worklists/bench-sheets/:jobId      the PDF of a finished bench-sheet job (only the person who asked)                              worklist.view
//   GET  /worklists/:id                      the worklist, its instrument and its items in run order                                        worklist.view
//   GET  /worklists/:id/run-sequence.csv     the run sequence as CSV (audited)                                                              worklist.view
//   POST /worklists                          plan a worklist (WL-<year>-<n>)                                                                worklist.manage
//   PUT  /worklists/:id                      title, date, instrument, notes (a reason once Released)                                        worklist.manage
//   POST /worklists/:id/items                add an item (Sample with its assignee, or Standard / Blank / SST / Control)                    worklist.manage
//   PUT  /worklists/:id/items/:itemId        reassign or relabel                                                                            worklist.manage
//   POST /worklists/:id/items/:itemId/remove remove, with a reason (the item stays in the record)                                           worklist.manage
//   POST /worklists/:id/reorder              the run order                                                                                  worklist.manage
//   POST /worklists/:id/release              freeze the membership                                                                          worklist.manage
//   POST /worklists/:id/complete             the run is done                                                                                worklist.manage
//   POST /worklists/:id/cancel               cancelled, with a reason                                                                       worklist.manage
//   POST /worklists/:id/bench-sheet          queue the PDF bench sheet (job worklist.bench_sheet)                                           worklist.manage
//   PUT  /worklists/:id/grid                 enter results cell by cell through saveResult (200, or 207 with the cells refused)             result.enter
import crypto from 'crypto';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import { jobs } from '../../db/schema';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { AppError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { artifactPath } from '../jobs/artifacts';
import { publishTask } from '../rabbitmq';
import { BENCH_SHEET_JOB } from '../worklists/benchSheet';
import { exportRunSequence } from '../worklists/export';
import { saveGrid } from '../worklists/grid';
import {
  cancelSchema, candidatesQuerySchema, completeSchema, gridSaveSchema, itemAddSchema, itemRemoveSchema, itemUpdateSchema, listQuerySchema,
  releaseSchema, reorderSchema, workloadQuerySchema, worklistCreateSchema, worklistUpdateSchema,
} from '../worklists/schemas';
import {
  addItem, candidates, closeWorklist, createWorklist, getWorklist, listWorklists, releaseWorklist, removeItem, reorderItems, updateItem,
  updateWorklist, workload, type Actor,
} from '../worklists/service';

export const worklistsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user as Actor;
  const id = (req: any) => String(req.params.id);

  router.get('/worklists', requireAuth, validate(listQuerySchema, 'query'), async (req, res) => {
    res.json(await listWorklists(db, req.query as any));
  });

  router.get('/worklists/workload', requireAuth, validate(workloadQuerySchema, 'query'), async (req, res) => {
    res.json(await workload(db, req.query as any));
  });

  router.get('/worklists/candidates', requireAuth, validate(candidatesQuerySchema, 'query'), async (req, res) => {
    res.json(await candidates(db, String((req.query as any).methodCode)));
  });

  router.get('/worklists/bench-sheets/:jobId', requireAuth, async (req, res) => {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, String(req.params.jobId))).limit(1);
    if (!job || job.type !== BENCH_SHEET_JOB) throw new NotFoundError('Job not found.');
    if (!job.createdBy || job.createdBy !== actor(req).id) throw new ForbiddenError();
    if (job.status === 'failed') throw new AppError(409, 'JOB_FAILED', job.lastError ?? 'The bench sheet could not be made. Request it again.');
    if (job.status !== 'completed' || !job.artifactName) throw new AppError(409, 'JOB_PENDING', `The bench sheet is not ready yet (${job.status}).`);
    if (job.artifactPurgedAt) throw new AppError(410, 'ARTIFACT_EXPIRED', 'The document was deleted after its retention period. Request it again.');
    let bytes: Buffer;
    try { bytes = fs.readFileSync(artifactPath(job.artifactName)); }
    catch { throw new AppError(404, 'ARTIFACT_MISSING', 'The stored document could not be found. Request it again.'); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== job.artifactSha256) {
      throw new AppError(500, 'ARTIFACT_CORRUPT', 'The stored document does not match its recorded checksum and was not sent. Request it again and report this to QA.');
    }
    const worklistId = String((job.payload ? JSON.parse(job.payload) : {}).worklistId ?? job.id).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${worklistId}-bench-sheet.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  });

  router.get('/worklists/:id', requireAuth, async (req, res) => {
    res.json(await getWorklist(db, id(req)));
  });

  router.get('/worklists/:id/run-sequence.csv', requireAuth, async (req, res) => {
    const out = await exportRunSequence(db, actor(req), id(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(out.csv);
  });

  router.post('/worklists', requireAuth, validate(worklistCreateSchema), async (req, res) => {
    res.json(await createWorklist(db, actor(req), req.body));
  });

  router.put('/worklists/:id', requireAuth, validate(worklistUpdateSchema), async (req, res) => {
    res.json(await updateWorklist(db, actor(req), id(req), req.body));
  });

  router.post('/worklists/:id/items', requireAuth, validate(itemAddSchema), async (req, res) => {
    res.json(await addItem(db, actor(req), id(req), req.body));
  });

  router.put('/worklists/:id/items/:itemId', requireAuth, validate(itemUpdateSchema), async (req, res) => {
    res.json(await updateItem(db, actor(req), id(req), String(req.params.itemId), req.body));
  });

  router.post('/worklists/:id/items/:itemId/remove', requireAuth, validate(itemRemoveSchema), async (req, res) => {
    res.json(await removeItem(db, actor(req), id(req), String(req.params.itemId), req.body));
  });

  router.post('/worklists/:id/reorder', requireAuth, validate(reorderSchema), async (req, res) => {
    res.json(await reorderItems(db, actor(req), id(req), req.body));
  });

  router.post('/worklists/:id/release', requireAuth, validate(releaseSchema), async (req, res) => {
    res.json(await releaseWorklist(db, actor(req), id(req), req.body.expectedVersion));
  });

  router.post('/worklists/:id/complete', requireAuth, validate(completeSchema), async (req, res) => {
    res.json(await closeWorklist(db, actor(req), id(req), 'Completed', req.body));
  });

  router.post('/worklists/:id/cancel', requireAuth, validate(cancelSchema), async (req, res) => {
    res.json(await closeWorklist(db, actor(req), id(req), 'Cancelled', req.body));
  });

  router.post('/worklists/:id/bench-sheet', requireAuth, async (req, res) => {
    await getWorklist(db, id(req)); // 404 for an unknown worklist, before a job exists
    const user = actor(req);
    const jobId = await publishTask(BENCH_SHEET_JOB, { worklistId: id(req) }, { createdBy: user.id, dedupeKey: `${BENCH_SHEET_JOB}:${id(req)}:${user.id}` });
    res.json({ jobId });
  });

  router.put('/worklists/:id/grid', requireAuth, validate(gridSaveSchema), async (req, res) => {
    const out = await saveGrid(db, actor(req), id(req), req.body.cells);
    res.status(out.failed.length > 0 ? 207 : 200).json(out);
  });

  return router;
};
