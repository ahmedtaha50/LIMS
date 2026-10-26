/**
 * The results preview of POST /reports/generate (job generate_gxp_pdf, src/server/jobs/handlers/pdf.ts). It goes through the one
 * certificate engine (src/server/reports): the same snapshot builder and the same renderer as an issued Certificate of Analysis, but
 * with no number, no copy and no authorisation, a PREVIEW - NOT ISSUED mark on every page and a statement that it is not a
 * certificate (roadmap M25). The certificate itself is issued, signed and numbered through POST /coa/:sampleId.
 *
 * Only an Approved sample has a preview, as before: the state is read again here, in the worker, because it may have changed since
 * the request was accepted.
 */
import { eq } from 'drizzle-orm';
import { samples } from '../db/schema';
import type { Db } from './core/context';
import { PermanentJobError } from './jobs/types';
import { buildCoaSnapshot, renderCoaPdf } from './reports/index';

export async function renderCoa(db: Db, sampleId: string): Promise<Buffer> {
  const [sample] = await db.select({ id: samples.id, state: samples.state }).from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!sample) throw new PermanentJobError(`Sample ${sampleId} was not found.`);
  if (sample.state !== 'Approved') {
    throw new PermanentJobError(`Sample ${sampleId} is not Approved (state: ${sample.state}); a results preview is made only for an Approved sample.`);
  }
  const snapshot = await buildCoaSnapshot(db, sampleId, { certificate: null, supersedes: null, issuedAt: null });
  return renderCoaPdf({ snapshot, signatures: [], copy: null });
}
