// Demo data: Qualified Analytical Instruments. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { instruments } from '../../../../src/db/schema';

export async function seedInstruments(db: Db): Promise<void> {
  const existingInst = await db.select().from(instruments);
  if (existingInst.length === 0) {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const dateStr = nextYear.toISOString().split('T')[0];

    await db.insert(instruments).values([
      { id: 'INST-HPLC-01', name: 'Agilent 1260 Infinity II HPLC System', type: 'Chromatography', status: 'Active', calibrationDueDate: dateStr, lastCalibrationDate: '2026-01-15' },
      { id: 'INST-UV-02', name: 'Shimadzu UV-1900i Spectrophotometer', type: 'Spectroscopy', status: 'Active', calibrationDueDate: dateStr, lastCalibrationDate: '2026-01-10' },
      { id: 'INST-DIS-03', name: 'Hanson Vision G2 Dissolution Tester', type: 'Dissolution', status: 'Active', calibrationDueDate: dateStr, lastCalibrationDate: '2026-01-12' },
      { id: 'INST-BAL-04', name: 'Mettler Toledo XPE205 Analytical Balance', type: 'Weighing', status: 'Active', calibrationDueDate: dateStr, lastCalibrationDate: '2026-01-05' },
    ]);
  }
}
