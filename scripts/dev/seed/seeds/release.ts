// Demo data: Batch Releases (Stage 5). Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import { createHash } from 'crypto';
import type { Db } from '../../../../src/server/core/context';
import { batchReleases } from '../../../../src/db/schema';

export async function seedBatchReleases(db: Db): Promise<void> {
  const existingBR = await db.select().from(batchReleases);
  if (existingBR.length === 0) {
    const releaseHash2 = createHash('sha256').update('BATCH-2026-002-RELEASE-CERTIFICATE').digest('hex');
    await db.insert(batchReleases).values([
      {
        id: 'BR-2026-002',
        batch: 'BATCH-2026-002',
        status: 'Released',
        dispositionRecommendation: 'Conforms to all registered European & USP Pharmacopeia specifications. Released for market distribution.',
        releasedBy: 'usr-qa',
        releasedAt: new Date('2026-02-13T17:00:00Z'),
        meaning: 'Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)',
        contentHash: releaseHash2,
        signatureId: 'SIG-BR-002',
        auditEntryId: 'adt-release-002',
        version: 1
      }
    ]);
  }
}
