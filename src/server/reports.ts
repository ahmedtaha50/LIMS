/**
 * Report jobs (roadmap M15) and the entry point of the controlled-document engine (roadmap M25, ./reports/index.ts, re-exported here).
 * The request is queued (publishTask) and the PDF is made by a worker; the result is a file that only the user who asked for it can read.
 *
 *   POST /reports/generate           a results PREVIEW (src/server/pdfWorker.ts), not a certificate: the Certificate of Analysis is issued,
 *                                    numbered and signed through POST /coa/:sampleId (src/server/routes/coa.ts).
 *                                    409 unless the sample is Approved; strict body; one active job per user and sample
 *   GET  /reports/status/:jobId      owner only (403 for anyone else); a finished PDF job answers `result`, a data: URI, as the UI expects
 *   GET  /reports/artifact/:jobId    owner only; the PDF as a download, its checksum verified against the record before it is sent
 */
import crypto from 'crypto';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { jobs, samples } from '../db/schema';
import { createRequireAuth } from './core/auth';
import { createRouter } from './core/router';
import { AppError, ForbiddenError, NotFoundError } from './http/errors';
import { validate } from './http/validate';
import { artifactPath } from './jobs/artifacts';
import { publishTask } from './rabbitmq';

export * from './reports/index';

const requireAuth = createRequireAuth(db);
export const reportsRouter = createRouter();

const generateSchema = z.object({ sampleId: z.string().trim().min(1, 'sampleId is required').max(100) }).strict();

reportsRouter.post('/reports/generate', requireAuth, validate(generateSchema), async (req, res) => {
  const user = (req as any).user;
  const { sampleId } = req.body as z.infer<typeof generateSchema>;
  const [sample] = await db.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!sample) throw new NotFoundError(`Sample ${sampleId} was not found.`);
  if (sample.state !== 'Approved') {
    throw new AppError(409, 'SAMPLE_NOT_APPROVED', `A Certificate of Analysis is issued only for an Approved sample; ${sampleId} is "${sample.state}".`);
  }
  const jobId = await publishTask('generate_gxp_pdf', { sampleId }, { createdBy: user.id, dedupeKey: `coa:${sampleId}:${user.id}` });
  res.json({ jobId });
});

/** The job, if it exists and belongs to the signed-in user. 404 for an unknown id; 403 (and nothing else) for someone else's job. */
async function ownedJob(req: any) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, String(req.params.jobId))).limit(1);
  if (!job) throw new NotFoundError('Job not found.');
  if (!job.createdBy || job.createdBy !== req.user.id) throw new ForbiddenError();
  return job;
}

/** The file of a finished job, after its SHA-256 was compared with the one recorded when it was made. */
function readArtifact(job: typeof jobs.$inferSelect): Buffer {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(artifactPath(job.artifactName!)); }
  catch { throw new AppError(404, 'ARTIFACT_MISSING', 'The stored document could not be found. Request it again.'); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== job.artifactSha256) {
    throw new AppError(500, 'ARTIFACT_CORRUPT', 'The stored document does not match its recorded checksum and was not sent. Request it again and report this to QA.');
  }
  return bytes;
}

reportsRouter.get('/reports/status/:jobId', requireAuth, async (req, res) => {
  const job = await ownedJob(req);
  if (job.status === 'failed') return void res.json({ status: 'failed', error: job.lastError ?? 'The job failed.' });
  if (job.status !== 'completed') return void res.json({ status: job.status });
  if (!job.artifactName) return void res.json({ status: 'completed', result: job.result });
  if (job.artifactPurgedAt) return void res.json({ status: 'completed', purged: true });
  res.json({ status: 'completed', result: `data:${job.artifactMime};base64,${readArtifact(job).toString('base64')}` });
});

reportsRouter.get('/reports/artifact/:jobId', requireAuth, async (req, res) => {
  const job = await ownedJob(req);
  if (job.status !== 'completed' || !job.artifactName) throw new NotFoundError('This job has no document.');
  if (job.artifactPurgedAt) throw new AppError(410, 'ARTIFACT_EXPIRED', 'The document was deleted after its retention period. Request it again.');
  const bytes = readArtifact(job);
  const sampleId = String((job.payload ? JSON.parse(job.payload) : {}).sampleId ?? job.id).replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', job.artifactMime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="CoA-${sampleId}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(bytes);
});
