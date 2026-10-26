// Demo data: Training Records & Certifications. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { trainingRecords } from '../../../../src/db/schema';

export async function seedTraining(db: Db): Promise<void> {
  const existingTrn = await db.select().from(trainingRecords);
  if (existingTrn.length === 0) {
    await db.insert(trainingRecords).values([
      { id: 'TRN-001', userId: 'usr-analyst1', moduleName: '21 CFR Part 11 & Data Integrity', status: 'Completed', completedAt: new Date(Date.now() - 45 * 86400000), certifiedBy: 'usr-qa', version: 1 },
      { id: 'TRN-002', userId: 'usr-analyst1', moduleName: 'HPLC Chromatography SOP (USP <621>)', status: 'Completed', completedAt: new Date(Date.now() - 30 * 86400000), certifiedBy: 'usr-qa', version: 1 },
      { id: 'TRN-003', userId: 'usr-analyst1', moduleName: 'Cleanroom Aseptic Gowning (ISO 14644)', status: 'Overdue', completedAt: null, certifiedBy: null, version: 1 },
      { id: 'TRN-004', userId: 'usr-analyst2', moduleName: '21 CFR Part 11 & Data Integrity', status: 'Completed', completedAt: new Date(Date.now() - 60 * 86400000), certifiedBy: 'usr-qa', version: 1 },
      { id: 'TRN-005', userId: 'usr-analyst2', moduleName: 'Dissolution Testing Protocol (USP <711>)', status: 'Overdue', completedAt: null, certifiedBy: null, version: 1 },
      { id: 'TRN-006', userId: 'usr-analyst2', moduleName: 'OOS / OOT Investigation Procedure', status: 'Pending', completedAt: null, certifiedBy: null, version: 1 },
      { id: 'TRN-007', userId: 'usr-reviewer', moduleName: 'Data Integrity & Audit Trail Review', status: 'Completed', completedAt: new Date(Date.now() - 20 * 86400000), certifiedBy: 'usr-qa', version: 1 },
      { id: 'TRN-008', userId: 'usr-reviewer', moduleName: 'Computerized System Validation (GAMP 5)', status: 'Overdue', completedAt: null, certifiedBy: null, version: 1 },
      { id: 'TRN-009', userId: 'usr-qa', moduleName: 'Batch Record Review & QP Release', status: 'Completed', completedAt: new Date(Date.now() - 10 * 86400000), certifiedBy: 'usr-admin', version: 1 },
      { id: 'TRN-010', userId: 'usr-qa', moduleName: 'Quality Risk Management (ICH Q9)', status: 'Completed', completedAt: new Date(Date.now() - 5 * 86400000), certifiedBy: 'usr-admin', version: 1 },
    ]);
  }
}
