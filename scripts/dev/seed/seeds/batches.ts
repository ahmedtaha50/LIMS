// Demo data: Raw Materials Dispensing & CoA Verification (Stage 1 for Batches). Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { batchMaterials } from '../../../../src/db/schema';

export async function seedBatchMaterials(db: Db): Promise<void> {
  const existingBM = await db.select().from(batchMaterials);
  if (existingBM.length === 0) {
    await db.insert(batchMaterials).values([
      // BATCH-2026-001 Materials
      {
        id: 'BM-PARA-API',
        batch: 'BATCH-2026-001',
        materialName: 'Paracetamol BP/USP Micropowder',
        materialType: 'API (Active Pharmaceutical Ingredient)',
        lotNumber: 'API-PARA-2026-081',
        manufacturer: 'Mallinckrodt Pharmaceuticals LLC',
        coaNumber: 'COA-MALL-88129',
        coaStatus: 'Verified Pass',
        quantityDispensed: '500.00 kg',
        potencyAssay: '99.85 %',
        lossOnDrying: '0.18 %',
        dispensedBy: 'usr-analyst1',
        verifiedBy: 'usr-qa',
        version: 1
      },
      {
        id: 'BM-PARA-MCC',
        batch: 'BATCH-2026-001',
        materialName: 'Microcrystalline Cellulose (Avicel PH-102)',
        materialType: 'Excipient (Binder & Disintegrant)',
        lotNumber: 'MCC-2025-9941',
        manufacturer: 'FMC Biopolymer Europe',
        coaNumber: 'COA-FMC-4102',
        coaStatus: 'Verified Pass',
        quantityDispensed: '120.00 kg',
        potencyAssay: '100.00 %',
        lossOnDrying: '4.10 %',
        dispensedBy: 'usr-analyst1',
        verifiedBy: 'usr-qa',
        version: 1
      },
      {
        id: 'BM-PARA-STA',
        batch: 'BATCH-2026-001',
        materialName: 'Pregelatinized Maize Starch (Starch 1500)',
        materialType: 'Excipient (Binder)',
        lotNumber: 'STA-2025-3318',
        manufacturer: 'Colorcon Inc.',
        coaNumber: 'COA-COL-1099',
        coaStatus: 'Verified Pass',
        quantityDispensed: '45.00 kg',
        potencyAssay: '100.00 %',
        lossOnDrying: '7.80 %',
        dispensedBy: 'usr-analyst1',
        verifiedBy: 'usr-qa',
        version: 1
      },
      {
        id: 'BM-PARA-MGS',
        batch: 'BATCH-2026-001',
        materialName: 'Magnesium Stearate (Vegetable Origin)',
        materialType: 'Excipient (Lubricant)',
        lotNumber: 'MGS-2026-1120',
        manufacturer: 'Peter Greven GMBH',
        coaNumber: 'COA-PG-5014',
        coaStatus: 'Verified Pass',
        quantityDispensed: '5.00 kg',
        potencyAssay: '99.20 %',
        lossOnDrying: '3.40 %',
        dispensedBy: 'usr-analyst1',
        verifiedBy: 'usr-qa',
        version: 1
      },

      // BATCH-2026-002 Materials
      {
        id: 'BM-AMX-API',
        batch: 'BATCH-2026-002',
        materialName: 'Amoxicillin Trihydrate Compacted Powder',
        materialType: 'API (Active Pharmaceutical Ingredient)',
        lotNumber: 'AMX-2026-0144',
        manufacturer: 'Sandoz / Centrient Pharmaceuticals',
        coaNumber: 'COA-CENT-9021',
        coaStatus: 'Verified Pass',
        quantityDispensed: '150.00 kg',
        potencyAssay: '87.40 % (as anhydrous)',
        lossOnDrying: '13.20 % (Water KF)',
        dispensedBy: 'usr-analyst2',
        verifiedBy: 'usr-qa',
        version: 1
      },
      {
        id: 'BM-AMX-SBZ',
        batch: 'BATCH-2026-002',
        materialName: 'Sodium Benzoate BP/USP',
        materialType: 'Excipient (Antimicrobial Preservative)',
        lotNumber: 'SBZ-2025-883',
        manufacturer: 'Emerald Performance Materials',
        coaNumber: 'COA-EM-4421',
        coaStatus: 'Verified Pass',
        quantityDispensed: '3.00 kg',
        potencyAssay: '99.90 %',
        lossOnDrying: '0.45 %',
        dispensedBy: 'usr-analyst2',
        verifiedBy: 'usr-qa',
        version: 1
      },

      // BATCH-2026-003 Materials
      {
        id: 'BM-CIP-API',
        batch: 'BATCH-2026-003',
        materialName: 'Ciprofloxacin Hydrochloride Monohydrate USP',
        materialType: 'API (Active Pharmaceutical Ingredient)',
        lotNumber: 'CIP-2026-5510',
        manufacturer: 'Bayer HealthCare Pharma',
        coaNumber: 'COA-BAY-3320',
        coaStatus: 'Verified Pass',
        quantityDispensed: '280.00 kg',
        potencyAssay: '99.60 %',
        lossOnDrying: '5.20 %',
        dispensedBy: 'usr-analyst1',
        verifiedBy: 'usr-qa',
        version: 1
      }
    ]);
  }
}
