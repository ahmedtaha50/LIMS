/**
 * Signatures of hash_version 1: the ones v0.1.0 wrote, and the ones the signing routes that have not moved to signRecord still
 * write. Each record type had its own hash formula, copied here exactly as the routes computed them. Three can be recomputed
 * from the record as it stands (a sample transition, an OOS closure, an ELN signature); the rest cannot:
 *   - a batch release signed a list of the sample ids of the batch at that moment, which was not kept;
 *   - a notebook observation signed nothing (content hash 'N/A').
 * For those the answer is null, "cannot be recomputed", and the verifier shows legacy-unverifiable. It never answers true for
 * them, and it never answers false: a mismatch it cannot tell from a legitimate later change is not evidence of tampering.
 */
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { labNotebook, oosInvestigations, samples } from '../../db/schema';
import type { signatures, auditTrail } from '../../db/schema';
import type { Executor } from '../core/tx';

type SignatureRow = typeof signatures.$inferSelect;
type AuditRow = typeof auditTrail.$inferSelect;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function legacyContentMatch(ex: Executor, sig: SignatureRow, audit: AuditRow | undefined, binding: { entityType: string; entityId: string }): Promise<boolean | null> {
  if (!sig.contentHash || sig.contentHash === 'N/A') return null;

  switch (binding.entityType) {
    case 'Sample': {
      if (!audit || audit.entity !== 'Sample' || audit.action !== 'Transition') return null;
      const [row] = await ex.select().from(samples).where(eq(samples.id, binding.entityId)).limit(1);
      if (!row) return false;
      return sha256(JSON.stringify({ id: row.id, material: row.material, batch: row.batch, state: audit.newValue, version: sig.recordVersion })) === sig.contentHash;
    }
    case 'OOS': {
      const [row] = await ex.select().from(oosInvestigations).where(eq(oosInvestigations.id, binding.entityId)).limit(1);
      if (!row) return false;
      return sha256(JSON.stringify({ id: row.id, sampleId: row.sampleId, resultId: row.resultId, rootCause: row.rootCause, conclusion: row.conclusion, version: sig.recordVersion })) === sig.contentHash;
    }
    case 'LabNotebook': {
      const [row] = await ex.select().from(labNotebook).where(eq(labNotebook.id, binding.entityId)).limit(1);
      if (!row) return false;
      return sha256(JSON.stringify({
        id: row.id, title: row.title, content: row.content, sampleId: row.sampleId, experimentType: row.experimentType, pharmacopeia: row.pharmacopeia,
        version: sig.recordVersion, signerId: sig.signerId, signedAt: row.signedAt ? row.signedAt.toISOString() : undefined,
      })) === sig.contentHash;
    }
    default:
      return null;
  }
}
