// Demo data: Electronic Lab Notebook (ELN) worksheets. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import { createHash } from 'crypto';
import type { Db } from '../../../../src/server/core/context';
import { labNotebook } from '../../../../src/db/schema';

export async function seedNotebook(db: Db): Promise<void> {
  const existingELN = await db.select().from(labNotebook);
  if (existingELN.length === 0) {
    const elnContent1 = `# High Performance Liquid Chromatography (HPLC) Quantitative Assay
## Regulatory Reference: USP <621> Chromatography & USP Monograph for Acetaminophen Tablets

### 1. Objective & Scope
Quantitative determination of Paracetamol in finished tablet formulation batch BATCH-2026-001 using validated reverse-phase isocratic HPLC with UV detection at 243 nm.

### 2. Instrumentation & Chromatographic Setup
- **System:** Agilent 1260 Infinity II Quaternary Pump & DAD Detector (INST-HPLC-01)
- **Stationary Phase:** C18 Reverse-Phase, 250 mm × 4.6 mm ID, 5 µm particle size (L1 column chemistry)
- **Mobile Phase:** Methanol : HPLC Grade Water : Glacial Acetic Acid (28 : 69 : 3 v/v/v), degassed and filtered through 0.22 µm nylon membrane
- **Flow Rate:** 1.5 mL/min isocratic
- **Column Temperature:** 35.0 °C ± 0.5 °C
- **Detection Wavelength:** λ = 243 nm
- **Injection Volume:** 10.0 µL

### 3. System Suitability Test (SST) Criteria & Observed Values
| Parameter | Acceptance Limit (USP <621>) | Observed Value | Result |
| :--- | :--- | :--- | :--- |
| Retention Time (%RSD, n=5) | ≤ 1.0 % | 0.24 % | **PASS** |
| Peak Area Repeatability (%RSD, n=5) | ≤ 1.0 % | 0.42 % | **PASS** |
| Theoretical Plates (N) | ≥ 2,500 | 4,820 | **PASS** |
| USP Tailing Factor (T) | 0.8 to 1.5 | 1.12 | **PASS** |

### 4. Preparation Procedure & Cleanroom Voice Notes
- **Standard Solution:** Accurately weighed 50.12 mg of USP Reference Standard (Lot RS-2026-904) into 50 mL Class A volumetric flask. Dissolved in 30 mL mobile phase under 10 min sonication, made to volume. Diluted 5.0 mL to 50.0 mL. Nominal concentration: 0.1002 mg/mL.
- **Sample Solution:** Accurately weighed 20 whole tablets. Average tablet weight: 582.4 mg. Powdered finely. Weighed 58.2 mg equivalent powder, transferred to 50 mL volumetric flask, sonicated 15 min, filtered through 0.45 µm PTFE syringe filter. Diluted 5.0 mL to 50.0 mL.
- **Voice Dictation Entry (Aseptic Room 104):** *"System suitability injections completed at 09:15 AM. Baseline stable with noise < 0.05 mAU. Sample duplicate injections show sharp, symmetrical peak at retention time 4.22 min. Zero ghost peaks observed."*

### 5. Quantitative Formula & Calculation
$$\\text{Assay (\\% Label Claim)} = \\left( \\frac{A_{\\text{sample}}}{A_{\\text{standard}}} \\right) \\times \\left( \\frac{W_{\\text{std}}}{50} \\right) \\times \\left( \\frac{5}{50} \\right) \\times \\left( \\frac{50}{W_{\\text{sample}}} \\right) \\times \\left( \\frac{50}{5} \\right) \\times \\left( \\frac{\\text{Avg Tablet Weight}}{\\text{Label Claim}} \\right) \\times P_{\\text{std}} \\times 100$$
$$\\text{Assay} = \\left( \\frac{1482092}{1485120} \\right) \\times \\left( \\frac{50.12}{50} \\right) \\times \\left( \\frac{582.4}{500.0} \\right) \\times 0.9985 \\times 100 = 99.82\\%$$

### 6. Conclusion
The assay result of **99.8 %** complies with the USP specification limit of 98.0% to 102.0% of label claim.`;

    const elnHash1 = createHash('sha256').update(elnContent1).digest('hex');

    await db.insert(labNotebook).values([
      {
        id: 'ELN-2026-001',
        title: 'HPLC Assay & System Suitability Worksheet — Paracetamol 500mg',
        sampleId: 'SMP-2026-00001',
        experimentType: 'HPLC Assay Quantitative',
        pharmacopeia: 'USP <621> / USP Monograph',
        content: elnContent1,
        status: 'Signed',
        enteredBy: 'usr-analyst1',
        enteredAt: new Date('2026-02-12T09:00:00Z'),
        signedAt: new Date('2026-02-12T16:30:00Z'),
        signedBy: 'usr-analyst1',
        signatureMeaning: 'Authorship & Verification of Laboratory Records (21 CFR Part 11)',
        contentHash: elnHash1,
        version: 2,
        locked: true
      },
      {
        id: 'ELN-2026-002',
        title: 'In-Vitro Dissolution Profiling Worksheet — Amoxicillin Oral Suspension',
        sampleId: 'SMP-2026-00002',
        experimentType: 'Dissolution Testing',
        pharmacopeia: 'USP <711> Dissolution / EP 2.9.3',
        content: `# Dissolution Testing Execution Worksheet
## Regulatory Framework: USP <711> Dissolution (Apparatus 2 - Paddle Method)

### 1. Test Parameters
- **Medium:** 900 mL of 0.1 N Hydrochloric Acid
- **Temperature:** 37.0 °C ± 0.5 °C
- **Rotational Speed:** 75 RPM
- **Sampling Timepoints:** 15, 30, 45, and 60 minutes
- **Filter:** 0.45 µm porous cannula filter

### 2. Analytical Execution & Observations
- Medium temperature verified across all 6 vessels at 37.0 °C.
- Tablets dropped simultaneously using automated dosage drop mechanism.
- Handled inside sterile glovebox; voice dictation recording active.
- Observed complete disintegration within 8 minutes.

### 3. Acceptance Limits
$Q = 80\\%$ at 30 minutes.

### 4. Status
Testing worksheet in progress. Ready for second analyst verification signoff.`,
        status: 'Draft',
        enteredBy: 'usr-analyst2',
        enteredAt: new Date('2026-02-13T08:30:00Z'),
        version: 1,
        locked: false
      }
    ]);
  }
}
