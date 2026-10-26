/**
 * The register of generated documents (roadmap M25): every PDF the system makes of a certificate is a report run, with its bytes, their
 * sha256 and a copy number; every delivery of those bytes is a row of the print log.
 *
 *   coaRenderHandler   job coa.render {documentId, purpose}: renders the certificate from its frozen snapshot with the watermark of its
 *                      state, and, in the transaction that completes the job, takes the next copy number (gap-free per document),
 *                      inserts the run, records the original's hash on the document (purpose Original, copy 1) and writes the audit
 *                      entries. A lost lease rolls all of it back, so no number is used twice or skipped.
 *   downloadRun        GET /reports/runs/:id/pdf      only the person the copy was made for; the bytes are re-hashed before they leave
 *   verifyRun          GET /reports/runs/:id/verify   bytes against their hash, snapshot against its hash, the authorisation signature
 */
import { randomBytes } from 'crypto';
import { asc, eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import { coaDocuments, reportPrintLog, reportRuns } from '../../db/schema/reports';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction } from '../core/tx';
import { verifySignature } from '../esign';
import { AppError, ForbiddenError, NotFoundError } from '../http/errors';
import { JobOutcome, PermanentJobError, type Handler } from '../jobs/types';
import { COA_ENTITY, COA_RENDER_JOB, documentSignatures, sha256Hex, snapshotHash } from './coa';
import { renderCoaPdf, watermarkFor } from './pdf';
import type { CoaSnapshot } from './snapshot';

type RunRow = typeof reportRuns.$inferSelect;

export const coaRenderHandler: Handler = async (payload, ctx) => {
  const documentId = typeof payload?.documentId === 'string' ? payload.documentId : '';
  const purpose = payload?.purpose === 'Original' ? 'Original' : payload?.purpose === 'Copy' ? 'Copy' : null;
  if (!documentId || !purpose) throw new PermanentJobError('The job needs a documentId and a purpose (Original or Copy).');
  const owner = ctx.job.createdBy;
  if (!owner) throw new PermanentJobError('The job has no owner.');
  const [doc] = await ctx.db.select().from(coaDocuments).where(eq(coaDocuments.id, documentId)).limit(1);
  if (!doc) throw new PermanentJobError(`Certificate ${documentId} was not found.`);
  if (purpose === 'Original' && doc.pdfSha256) return { documentId, runId: doc.originalRunId, purpose };   // made already (a retry)
  if (purpose === 'Copy' && !doc.pdfSha256) throw new PermanentJobError(`The original of ${doc.label} has not been made yet; a copy follows the original.`);

  const runId = `run-${randomBytes(10).toString('hex')}`;
  return new JobOutcome({
    result: { documentId, runId, purpose },
    after: async (tx) => {
      const current = await lockRow(tx, coaDocuments, documentId);       // the state printed is the state at this moment
      if (purpose === 'Original' && current.pdfSha256) throw new Error(`The original of ${current.label} was made meanwhile.`);
      const copyNo = await nextSequence(tx, `report-copy:${documentId}`);
      if (purpose === 'Original' && copyNo !== 1) throw new PermanentJobError(`The original of ${current.label} would not be copy 1 (it would be ${copyNo}).`);
      const [who] = await tx.select({ name: users.name }).from(users).where(eq(users.id, owner)).limit(1);
      const now = new Date();
      const pdf = renderCoaPdf({
        snapshot: current.snapshot as unknown as CoaSnapshot,
        signatures: await documentSignatures(tx, documentId),
        copy: { copyNo, purpose, status: current.status, generatedAt: now, generatedByName: who?.name ?? owner },
      });
      const sha = sha256Hex(pdf);
      await tx.insert(reportRuns).values({
        id: runId, reportType: 'CoA', documentId, copyNo, purpose, documentStatus: current.status, watermark: watermarkFor(current.status),
        fileName: `${current.label}-copy-${copyNo}.pdf`, mime: 'application/pdf', bytes: pdf.length, pdfSha256: sha, pdf, jobId: ctx.job.id,
        generatedBy: owner, generatedAt: now,
      });
      await writeAudit(tx, owner, 'Create', 'ReportRun', runId, 'document', '', JSON.stringify({ document: current.label, copyNo, purpose, status: current.status, sha256: sha, bytes: pdf.length }),
        purpose === 'Original' ? `Original PDF of certificate ${current.label}` : `Controlled copy ${copyNo} of certificate ${current.label}`);
      if (purpose === 'Original') {
        await updateVersioned(tx, coaDocuments, documentId, current.version, { pdfSha256: sha, originalRunId: runId });
        await writeAudit(tx, owner, 'Render', COA_ENTITY, documentId, 'pdf_sha256', '', sha, `Original PDF (copy 1, ${runId}) of certificate ${current.label}`);
      }
    },
  });
};

export const REPORT_HANDLERS: Record<string, Handler> = { [COA_RENDER_JOB]: coaRenderHandler };

async function loadRun(db: Db, id: string): Promise<RunRow> {
  const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, id)).limit(1);
  if (!run) throw new NotFoundError(`Report run ${id} was not found.`);
  return run;
}

/** GET /reports/runs/:id: what was generated, for whom, and every delivery. Never the bytes. */
export async function runDetail(db: Db, id: string) {
  const run = await loadRun(db, id);
  const [doc] = run.documentId ? await db.select({ label: coaDocuments.label, status: coaDocuments.status }).from(coaDocuments).where(eq(coaDocuments.id, run.documentId)).limit(1) : [];
  const prints = await db.select().from(reportPrintLog).where(eq(reportPrintLog.runId, id)).orderBy(asc(reportPrintLog.printedAt));
  return {
    id: run.id, reportType: run.reportType, documentId: run.documentId, documentLabel: doc?.label ?? null, documentStatusNow: doc?.status ?? null,
    copyNo: run.copyNo, purpose: run.purpose, documentStatus: run.documentStatus, watermark: run.watermark, fileName: run.fileName, mime: run.mime,
    bytes: run.bytes, pdfSha256: run.pdfSha256, jobId: run.jobId, generatedBy: run.generatedBy, generatedAt: run.generatedAt.toISOString(),
    prints: prints.map(p => ({ id: p.id, action: p.action, printedBy: p.printedBy, printedAt: p.printedAt.toISOString() })),
  };
}

/**
 * GET /reports/runs/:id/pdf. A controlled copy belongs to the person it was made for (403 for anyone else: they request their own copy).
 * The bytes are re-hashed against the record first: a mismatch is 500 REPORT_CORRUPT and nothing is sent. The delivery is logged
 * (print log and audit entry) before the bytes go out.
 */
export async function downloadRun(db: Db, user: { id: string }, id: string): Promise<RunRow> {
  const run = await loadRun(db, id);
  if (run.generatedBy !== user.id) throw new ForbiddenError('This copy was made for another person. Request your own controlled copy of the certificate.');
  const pdf = Buffer.from(run.pdf);
  if (pdf.length !== run.bytes || sha256Hex(pdf) !== run.pdfSha256) {
    throw new AppError(500, 'REPORT_CORRUPT', `The stored document ${run.fileName} does not match its recorded checksum and was not sent. Report this to QA.`);
  }
  await withTransaction(db, async (tx) => {
    const printId = `prt-${randomBytes(10).toString('hex')}`;
    await tx.insert(reportPrintLog).values({ id: printId, runId: run.id, action: 'Download', printedBy: user.id });
    await writeAudit(tx, user.id, 'Download', 'ReportRun', run.id, 'print', '', printId, `Copy ${run.copyNo} (${run.fileName}) delivered`);
  });
  return run;
}

/** GET /reports/runs/:id/verify. `valid` only when every check passes. */
export async function verifyRun(db: Db, id: string) {
  const run = await loadRun(db, id);
  const pdf = Buffer.from(run.pdf);
  const pdfHash = pdf.length === run.bytes && sha256Hex(pdf) === run.pdfSha256;
  const checks: { pdfHash: boolean; snapshotHash: boolean | null; original: boolean | null; signature: string | null } = { pdfHash, snapshotHash: null, original: null, signature: null };
  let document: { id: string; label: string; status: string } | null = null;
  if (run.documentId) {
    const [doc] = await db.select().from(coaDocuments).where(eq(coaDocuments.id, run.documentId)).limit(1);
    if (doc) {
      document = { id: doc.id, label: doc.label, status: doc.status };
      checks.snapshotHash = snapshotHash(doc.snapshot) === doc.snapshotSha256;
      checks.original = run.purpose === 'Original' ? doc.pdfSha256 === run.pdfSha256 && doc.originalRunId === run.id : null;
      const issue = (await documentSignatures(db, doc.id)).find(s => s.meaningCode === 'COA_AUTHORISATION');
      checks.signature = issue ? ((await verifySignature(db, issue.id))?.status ?? 'missing') : 'missing';
    } else {
      checks.snapshotHash = false;
      checks.signature = 'record-missing';
    }
  }
  const valid = checks.pdfHash && checks.snapshotHash !== false && checks.original !== false && (checks.signature === null || checks.signature === 'valid');
  return { runId: run.id, valid, checks, document, copyNo: run.copyNo, pdfSha256: run.pdfSha256, verifiedAt: new Date().toISOString() };
}
