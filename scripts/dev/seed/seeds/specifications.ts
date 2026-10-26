// Demo data: Active Specifications. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { specifications } from '../../../../src/db/schema';

export async function seedSpecifications(db: Db): Promise<void> {
  const existingSpecs = await db.select().from(specifications);
  if (existingSpecs.length <= 1) {
    await db.delete(specifications); // Clear draft dummy
    await db.insert(specifications).values([
      {
        id: 'SPEC-PARA-500',
        material: 'Paracetamol 500mg Finished Tablets',
        version: 1,
        effectiveDate: '2026-01-01',
        status: 'Active',
        parameters: [
          { name: 'HPLC Assay (% Label Claim)', min: 98.0, max: 102.0 },
          { name: 'Dissolution (Q at 30 min, %)', min: 80.0, max: 105.0 },
          { name: '4-Aminophenol Impurity (%)', min: 0.0, max: 0.005 },
          { name: 'Total Related Substances (%)', min: 0.0, max: 0.50 },
          { name: 'Karl Fischer Water Content (%)', min: 0.1, max: 3.0 },
          { name: 'Uniformity of Dosage Units (AV)', min: 0.0, max: 15.0 },
        ]
      },
      {
        id: 'SPEC-AMX-250',
        material: 'Amoxicillin 250mg/5mL Oral Suspension',
        version: 1,
        effectiveDate: '2026-01-01',
        status: 'Active',
        parameters: [
          { name: 'HPLC Assay (% Label Claim)', min: 90.0, max: 120.0 },
          { name: 'pH Determination', min: 5.0, max: 7.5 },
          { name: 'Deliverable Volume (mL)', min: 100.0, max: 110.0 },
          { name: 'Total Aerobic Microbial Count (CFU/g)', min: 0.0, max: 100.0 },
        ]
      },
      {
        id: 'SPEC-CIPRO-500',
        material: 'Ciprofloxacin 500mg Film-Coated Tablets',
        version: 1,
        effectiveDate: '2026-01-01',
        status: 'Active',
        parameters: [
          { name: 'HPLC Assay (% Label Claim)', min: 98.0, max: 102.0 },
          { name: 'Dissolution (Q at 30 min, %)', min: 80.0, max: 100.0 },
          { name: 'Fluoroquinolonic Acid Impurity (%)', min: 0.0, max: 0.20 },
        ]
      }
    ]);
  }
}
