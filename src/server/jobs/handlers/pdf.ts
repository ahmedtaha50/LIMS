import { writeAudit } from '../../../db/utils';
import { renderCoa } from '../../pdfWorker';
import { storeArtifact } from '../artifacts';
import { JobOutcome, PermanentJobError, type Handler } from '../types';

/**
 * generate_gxp_pdf: the Certificate of Analysis of an Approved sample. The PDF is written as a file (not into the database) and
 * issuing it is audited in the transaction that completes the job, attributed to the user who asked for it.
 */
export const generatePdfHandler: Handler = async (payload, ctx) => {
  const sampleId = typeof payload?.sampleId === 'string' ? payload.sampleId : '';
  if (!sampleId) throw new PermanentJobError('The job has no sampleId.');
  const owner = ctx.job.createdBy;
  if (!owner) throw new PermanentJobError('The job has no owner.');

  const bytes = await renderCoa(ctx.db, sampleId);
  // The file is named after the job, so a retry of the same job rewrites the same file instead of leaving a second copy behind.
  const artifact = storeArtifact(bytes, 'pdf', 'application/pdf', { name: ctx.job.id.replace(/^job-/, '') });
  return new JobOutcome({
    result: { sampleId, bytes: artifact.bytes },
    artifact,
    after: async (tx) => {
      await writeAudit(tx, owner, 'Create', 'CertificateOfAnalysis', sampleId, 'document', '', `sha256=${artifact.sha256}; job=${ctx.job.id}; bytes=${artifact.bytes}`,
        'Requested: certificate of analysis');
    },
  });
};
