// Demo data: OOS Investigations. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { oosInvestigations } from '../../../../src/db/schema';

export async function seedOosInvestigations(db: Db): Promise<void> {
  const existingOOS = await db.select().from(oosInvestigations);
  if (existingOOS.length === 0) {
    await db.insert(oosInvestigations).values([
      {
        id: 'OOS-2026-001',
        sampleId: 'SMP-2026-00003',
        resultId: 'RES-003-1',
        parameter: 'HPLC Assay (% Label Claim)',
        dateRaised: '2026-09-18',
        status: 'Phase II QA Review',
        assignedTo: 'usr-qa',
        rootCause: 'Column backpressure anomaly during chromatographic run',
        version: 1
      }
    ]);
  }
}
