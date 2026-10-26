// Demo data: methods and calculation formulas (roadmap M18, r2-methods-calc). Skips when the tables already have rows.
//
// Every record is seeded as a DRAFT with no author: a seed never makes an approval or a signature. QA reviews each one and signs it
// Effective (METHOD_APPROVAL, FORMULA_APPROVAL), and the server refuses a formula whose test cases do not reproduce their values.
// The expected values of the test cases were calculated by hand outside the system (Python decimal at 50 digits, rounded half-up;
// the script is quoted in docs/changes/r2-methods-calc.md), and tests/unit/calc/seeds.test.ts runs every one through the engine.
import type { Db } from '../../../../src/server/core/context';
import { calcFormulas } from '../../../../src/db/schema/calc';
import { methods } from '../../../../src/db/schema/methods';
import type { FormulaInput, FormulaTestCase, SstCriterion } from '../../../../src/lib/validations/methods';

interface SeedFormula { id: string; code: string; name: string; expression: string; unit: string | null; inputs: FormulaInput[]; testCases: FormulaTestCase[] }
interface SeedMethod { id: string; code: string; title: string; description: string; instrumentType: string | null; sstCriteria: SstCriterion[] }

const rep = (name: string, label: string, unit: string | null = null): FormulaInput => ({ name, label, unit, replicates: true });
const one = (name: string, label: string, unit: string | null = null): FormulaInput => ({ name, label, unit, replicates: false });
const AV = 'abs(max(98.5, min(101.5, mean(x))) - mean(x)) + if(count(x) == 10, 2.4, 2.0) * sd(x)';

export const SEED_FORMULAS: readonly SeedFormula[] = [
  {
    id: 'FRM-SEED-ASSAY', code: 'ASSAY-HPLC-EXT', name: 'Assay by HPLC, external standard, % of label claim', unit: '%',
    expression: '(mean(A_spl) / mean(A_std)) * (W_std * P_std / 100 / V_std) * (V_spl / W_spl) * Avg_wt / LC * 100',
    inputs: [
      rep('A_spl', 'Peak areas of the sample preparation'), rep('A_std', 'Peak areas of the standard injections'),
      one('W_std', 'Standard weight', 'mg'), one('P_std', 'Standard purity', '%'), one('V_std', 'Standard dilution volume', 'mL'),
      one('W_spl', 'Sample weight (tablet powder)', 'mg'), one('V_spl', 'Sample dilution volume', 'mL'), one('Avg_wt', 'Average tablet weight', 'mg'),
      one('LC', 'Label claim', 'mg'),
    ],
    testCases: [{
      name: 'Two sample injections, five standard injections', decimals: 1, expected: '100.2',
      inputs: { A_spl: [1523456, 1525012], A_std: [1519870, 1521034, 1520455, 1518999, 1522001], W_std: 50.12, P_std: 99.8, V_std: 50, W_spl: 625.4, V_spl: 500, Avg_wt: 625.0, LC: 500 },
    }],
  },
  {
    id: 'FRM-SEED-RSD', code: 'SST-RSD', name: 'System suitability: %RSD of replicate standard injections', unit: '%',
    expression: 'rsd(x)', inputs: [rep('x', 'Peak areas of the replicate injections')],
    testCases: [
      { name: 'Six injections that pass', inputs: { x: [1000, 1010, 990, 1005, 995, 1000] }, decimals: 2, expected: '0.71' },
      { name: 'Six injections that fail NMT 2.0', inputs: { x: [103, 97, 103, 97, 100, 100] }, decimals: 1, expected: '2.7' },
    ],
  },
  {
    id: 'FRM-SEED-DISS', code: 'DISS-UNIT', name: 'Dissolution: % of label claim dissolved, one unit (UV, external standard)', unit: '%',
    expression: '(A_u / mean(A_std)) * (W_std * P_std / 100 / V_std) * V_med / LC * 100',
    inputs: [
      one('A_u', 'Absorbance of the unit'), rep('A_std', 'Absorbance of the standard'), one('W_std', 'Standard weight', 'mg'),
      one('P_std', 'Standard purity', '%'), one('V_std', 'Standard dilution volume', 'mL'), one('V_med', 'Medium volume', 'mL'), one('LC', 'Label claim', 'mg'),
    ],
    testCases: [{ name: 'One unit', decimals: 1, expected: '98.5', inputs: { A_u: 487650, A_std: [493210, 492876, 494010], W_std: 27.8, P_std: 99.6, V_std: 50, V_med: 900, LC: 500 } }],
  },
  {
    id: 'FRM-SEED-DISSQ', code: 'DISS-Q-S1', name: 'Dissolution stage S1: lowest of six units (each must be NLT Q + 5)', unit: '%',
    expression: 'min(units)', inputs: [rep('units', '% dissolved of each unit', '%')],
    testCases: [{ name: 'Six units', inputs: { units: [92.4, 95.1, 90.8, 93.3, 96.0, 91.7] }, decimals: 0, expected: '91' }],
  },
  {
    id: 'FRM-SEED-KF', code: 'KF-WATER', name: 'Water by volumetric Karl Fischer titration, % w/w', unit: '%',
    expression: 'V * F / W * 100', inputs: [one('V', 'Titrant volume', 'mL'), one('F', 'Titrant factor', 'mg/mL'), one('W', 'Sample weight', 'mg')],
    testCases: [{ name: 'One titration', inputs: { V: 1.25, F: 5.02, W: 250.3 }, decimals: 2, expected: '2.51' }],
  },
  {
    id: 'FRM-SEED-AV', code: 'USP905-AV', name: 'Uniformity of dosage units, acceptance value (USP <905>, L1 = 15.0)', unit: null,
    expression: AV, inputs: [rep('x', 'Individual contents, % of label claim', '%')],
    testCases: [
      { name: 'n = 10, mean within 98.5-101.5', decimals: 1, expected: '2.2', inputs: { x: [99.2, 100.4, 98.7, 101.1, 99.8, 100.9, 98.9, 100.2, 99.5, 101.3] } },
      { name: 'n = 10, mean below 98.5', decimals: 1, expected: '3.5', inputs: { x: [96.2, 97.8, 95.9, 98.1, 97.0, 96.6, 97.4, 98.4, 96.1, 97.5] } },
      { name: 'n = 10, mean above 101.5', decimals: 1, expected: '2.3', inputs: { x: [102.1, 103.0, 101.8, 102.6, 103.4, 101.9, 102.2, 102.8, 103.1, 102.5] } },
      { name: 'n = 30 (k = 2.0)', decimals: 1, expected: '1.8', inputs: { x: Array.from({ length: 30 }, (_, i) => Number((99.0 + 0.1 * i).toFixed(1))) } },
    ],
  },
];

export const SEED_METHODS: readonly SeedMethod[] = [
  {
    id: 'MTH-SEED-HPLC', code: 'HPLC-ASSAY', title: 'Assay and related substances by HPLC', instrumentType: 'Chromatography',
    description: 'Reversed-phase HPLC, external standard. System suitability before the sample injections.',
    sstCriteria: [{ name: 'Repeatability, %RSD of 6 standard injections', formulaCode: 'SST-RSD', limit_kind: 'NMT', lower: null, upper: 2.0, decimals: 1, replicates: 6 }],
  },
  { id: 'MTH-SEED-DISS', code: 'DISSOLUTION', title: 'Dissolution, apparatus 2 (paddle), UV finish', instrumentType: 'Dissolution', description: 'Stage S1 with six units.', sstCriteria: [] },
  { id: 'MTH-SEED-KF', code: 'KF-VOLUMETRIC', title: 'Water by volumetric Karl Fischer titration', instrumentType: null, description: 'Titrant standardised daily.', sstCriteria: [] },
  { id: 'MTH-SEED-CU', code: 'CONTENT-UNIFORMITY', title: 'Uniformity of dosage units by content uniformity (USP <905>)', instrumentType: 'Chromatography', description: 'Ten units assayed individually by HPLC.', sstCriteria: [] },
];

export async function seedMethods(db: Db): Promise<void> {
  if ((await db.select({ id: calcFormulas.id }).from(calcFormulas).limit(1)).length === 0) {
    await db.insert(calcFormulas).values(SEED_FORMULAS.map(f => ({ ...f, revision: 1, status: 'Draft', createdBy: null, version: 1 })));
  }
  if ((await db.select({ id: methods.id }).from(methods).limit(1)).length === 0) {
    await db.insert(methods).values(SEED_METHODS.map(m => ({ ...m, revision: 1, status: 'Draft', createdBy: null, version: 1 })));
  }
}
