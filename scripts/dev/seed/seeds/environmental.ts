// Demo data: Cleanroom Environmental Records (ISO 14644 / EU GMP Annex 1). Moved from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
// r2-em: each record names its sample type (settle plate) and the 0070 limits it is judged against, so every status follows the rule
// (topDefect: Grade D 15 and 22 CFU seeded Pass with no sample type or limit); the counts are unchanged.
import type { Db } from '../../../../src/server/core/context';
import { envRecords } from '../../../../src/db/schema';

export async function seedEnvironmental(db: Db): Promise<void> {
  const existingEnv = await db.select().from(envRecords);
  if (existingEnv.length === 0) {
    await db.insert(envRecords).values([
      { id: 'ENV-2026-001', location: 'Aseptic Filling Line 1 - Laminar Flow Hood', grade: 'Grade A', date: '2026-02-10', viableCount: 0, nonViableCount: 0, sampleType: 'Settle plate', limitAlert: null, limitAction: 0, status: 'Pass', testedBy: 'usr-qa' },
      { id: 'ENV-2026-002', location: 'Cleanroom Core Suite 104', grade: 'Grade B', date: '2026-02-10', viableCount: 2, nonViableCount: 320, sampleType: 'Settle plate', limitAlert: null, limitAction: 5, status: 'Pass', testedBy: 'usr-qa' },
      { id: 'ENV-2026-003', location: 'Granulation & Blending Suite 201', grade: 'Grade C', date: '2026-02-11', viableCount: 8, nonViableCount: 4200, sampleType: 'Settle plate', limitAlert: null, limitAction: 50, status: 'Pass', testedBy: 'usr-qa' },
      { id: 'ENV-2026-004', location: 'Personnel Airlock PAL-02', grade: 'Grade D', date: '2026-02-11', viableCount: 15, nonViableCount: 18000, sampleType: 'Settle plate', limitAlert: null, limitAction: 100, status: 'Pass', testedBy: 'usr-qa' },
      { id: 'ENV-2026-005', location: 'Tablet Compression Suite 305', grade: 'Grade C', date: '2026-02-12', viableCount: 12, nonViableCount: 5100, sampleType: 'Settle plate', limitAlert: null, limitAction: 50, status: 'Pass', testedBy: 'usr-qa' },
      { id: 'ENV-2026-006', location: 'Primary Blister Packaging Room', grade: 'Grade D', date: '2026-02-12', viableCount: 22, nonViableCount: 24500, sampleType: 'Settle plate', limitAlert: null, limitAction: 100, status: 'Pass', testedBy: 'usr-qa' },
    ]);
  }
}
