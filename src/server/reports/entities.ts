// The signable record type of the Certificate of Analysis (roadmap M25). A signature on a CoaDocument covers the certificate as issued:
// its number and issue version, the sample, the specification revision, the hash of the frozen snapshot and what it supersedes, with
// the status the signed action set (asSigned). A later supersede or void therefore does not break the issue signature, and the void
// signature covers status Voided. The snapshot itself is protected by its hash, here and in GET /reports/runs/:id/verify.
import { eq } from 'drizzle-orm';
import { coaDocuments } from '../../db/schema/reports';
import { asSigned, registerSignable } from '../esign';

registerSignable({
  type: 'CoaDocument',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(coaDocuments).where(eq(coaDocuments.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, sampleId: row.sampleId, number: row.number, issueVersion: row.issueVersion, label: row.label,
      specId: row.specId, specRevision: row.specRevision, snapshotSha256: row.snapshotSha256, supersedesId: row.supersedesId,
      issuedBy: row.issuedBy, status: asSigned(change, ['status'], row.status),
    };
  },
});
