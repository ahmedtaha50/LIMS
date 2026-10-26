// Demo data: QC Samples & Analytical Results (Stage 3). Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import { sql } from 'drizzle-orm';
import type { Db } from '../../../../src/server/core/context';
import { samples, results } from '../../../../src/db/schema';

export async function seedSamples(db: Db): Promise<void> {
  const existingSamples = await db.select().from(samples);
  if (existingSamples.length === 0) {
    // Sample 1: BATCH-2026-001 (Paracetamol) - Complete & Passed
    await db.insert(samples).values([
      {
        id: 'SMP-2026-00001',
        material: 'Paracetamol 500mg Finished Tablets',
        batch: 'BATCH-2026-001',
        state: 'Approved',
        createdBy: 'usr-analyst1',
        version: 2
      },
      {
        id: 'SMP-2026-00002',
        material: 'Amoxicillin 250mg/5mL Oral Suspension',
        batch: 'BATCH-2026-002',
        state: 'Approved',
        createdBy: 'usr-analyst2',
        version: 2
      },
      {
        id: 'SMP-2026-00003',
        material: 'Ciprofloxacin 500mg Film-Coated Tablets',
        batch: 'BATCH-2026-003',
        state: 'Testing',
        createdBy: 'usr-analyst1',
        version: 1
      }
    ]);

    // Results for SMP-2026-00001
    await db.insert(results).values([
      {
        id: 'RES-001-1',
        sampleId: 'SMP-2026-00001',
        parameter: 'HPLC Assay (% Label Claim)',
        value: '99.8',
        specMin: 98.0,
        specMax: 102.0,
        isOos: false,
        instrumentId: 'INST-HPLC-01',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T09:30:00Z'),
        version: 2
      },
      {
        id: 'RES-001-2',
        sampleId: 'SMP-2026-00001',
        parameter: 'Dissolution (Q at 30 min, %)',
        value: '94.2',
        specMin: 80.0,
        specMax: 105.0,
        isOos: false,
        instrumentId: 'INST-DIS-03',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T11:15:00Z'),
        version: 2
      },
      {
        id: 'RES-001-3',
        sampleId: 'SMP-2026-00001',
        parameter: '4-Aminophenol Impurity (%)',
        value: '0.0018',
        specMin: 0.0,
        specMax: 0.005,
        isOos: false,
        instrumentId: 'INST-HPLC-01',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T13:45:00Z'),
        version: 2
      },
      {
        id: 'RES-001-4',
        sampleId: 'SMP-2026-00001',
        parameter: 'Total Related Substances (%)',
        value: '0.12',
        specMin: 0.0,
        specMax: 0.50,
        isOos: false,
        instrumentId: 'INST-HPLC-01',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T14:10:00Z'),
        version: 2
      },
      {
        id: 'RES-001-5',
        sampleId: 'SMP-2026-00001',
        parameter: 'Karl Fischer Water Content (%)',
        value: '1.85',
        specMin: 0.1,
        specMax: 3.0,
        isOos: false,
        instrumentId: 'INST-BAL-04',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T15:00:00Z'),
        version: 2
      },
      {
        id: 'RES-001-6',
        sampleId: 'SMP-2026-00001',
        parameter: 'Uniformity of Dosage Units (AV)',
        value: '3.8',
        specMin: 0.0,
        specMax: 15.0,
        isOos: false,
        instrumentId: 'INST-BAL-04',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T15:45:00Z'),
        version: 2
      },

      // Results for SMP-2026-00002
      {
        id: 'RES-002-1',
        sampleId: 'SMP-2026-00002',
        parameter: 'HPLC Assay (% Label Claim)',
        value: '91.5',
        specMin: 90.0,
        specMax: 120.0,
        isOos: false,
        instrumentId: 'INST-HPLC-01',
        enteredBy: 'usr-analyst2',
        enteredAt: new Date('2026-02-13T10:00:00Z'),
        version: 2
      },
      {
        id: 'RES-002-2',
        sampleId: 'SMP-2026-00002',
        parameter: 'pH Determination',
        value: '5.8',
        specMin: 5.0,
        specMax: 7.5,
        isOos: false,
        instrumentId: 'INST-UV-02',
        enteredBy: 'usr-analyst2',
        enteredAt: new Date('2026-02-13T10:45:00Z'),
        version: 2
      },
      {
        id: 'RES-002-3',
        sampleId: 'SMP-2026-00002',
        parameter: 'Deliverable Volume (mL)',
        value: '101.5',
        specMin: 100.0,
        specMax: 110.0,
        isOos: false,
        instrumentId: 'INST-BAL-04',
        enteredBy: 'usr-analyst2',
        enteredAt: new Date('2026-02-13T11:30:00Z'),
        version: 2
      },
      {
        id: 'RES-002-4',
        sampleId: 'SMP-2026-00002',
        parameter: 'Total Aerobic Microbial Count (CFU/g)',
        value: '10',
        specMin: 0.0,
        specMax: 100.0,
        isOos: false,
        instrumentId: 'INST-BAL-04',
        enteredBy: 'usr-analyst2',
        enteredAt: new Date('2026-02-13T14:00:00Z'),
        version: 2
      },

      // Results for SMP-2026-00003 (Testing)
      {
        id: 'RES-003-1',
        sampleId: 'SMP-2026-00003',
        parameter: 'HPLC Assay (% Label Claim)',
        value: '99.1',
        specMin: 98.0,
        specMax: 102.0,
        isOos: false,
        instrumentId: 'INST-HPLC-01',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-14T09:00:00Z'),
        version: 2
      },
      {
        id: 'RES-003-2',
        sampleId: 'SMP-2026-00003',
        parameter: 'Dissolution (Q at 30 min, %)',
        value: null,
        specMin: 80.0,
        specMax: 100.0,
        isOos: false,
        version: 1
      },
      {
        id: 'RES-003-3',
        sampleId: 'SMP-2026-00003',
        parameter: 'Fluoroquinolonic Acid Impurity (%)',
        value: null,
        specMin: 0.0,
        specMax: 0.20,
        isOos: false,
        version: 1
      }
    ]);

    // Every entered result gets its first version (roadmap M20), as saveResult writes it; the review checklist checks the history.
    await db.execute(sql`
      INSERT INTO result_versions (id, result_id, sample_id, result_version, value, is_oos, change_code, reason, instrument_id, entered_by, entered_at)
      SELECT 'rv-seed-' || id, id, sample_id, version, value, is_oos, 'INITIAL_ENTRY', 'Demo data entry', instrument_id, entered_by, COALESCE(entered_at, now())
      FROM results WHERE value IS NOT NULL AND value <> ''`);
  }
}
