// Demo data: the site map of the environmental monitoring programme (roadmap M32, r2-em). Only sampling points: the limit profiles that
// migration 0250 installs are Drafts, and a demo seed does not approve them (an approval is an e-signature of a real QA user), so the
// demo shows a programme waiting for QA's approval. Skips when the table already has rows.
import type { Db } from '../../../../src/server/core/context';
import { emSamplingPoints } from '../../../../src/db/schema/em';

export async function seedEm(db: Db): Promise<void> {
  const existing = await db.select({ id: emSamplingPoints.id }).from(emSamplingPoints).limit(1);
  if (existing.length > 0) return;
  await db.insert(emSamplingPoints).values([
    { id: 'EMP-DEMO-A1', code: 'FL1-A-01', room: 'Aseptic Filling Line 1', description: 'Laminar flow hood, at the filling needles', grade: 'Grade A', createdBy: 'usr-qa' },
    { id: 'EMP-DEMO-A2', code: 'FL1-A-02', room: 'Aseptic Filling Line 1', description: 'Laminar flow hood, stopper bowl', grade: 'Grade A', createdBy: 'usr-qa' },
    { id: 'EMP-DEMO-B1', code: 'CS104-B-01', room: 'Cleanroom Core Suite 104', description: 'Background of the filling line, door side', grade: 'Grade B', createdBy: 'usr-qa' },
    { id: 'EMP-DEMO-C1', code: 'GB201-C-01', room: 'Granulation & Blending Suite 201', description: 'Next to the blender discharge', grade: 'Grade C', createdBy: 'usr-qa' },
    { id: 'EMP-DEMO-D1', code: 'PAL02-D-01', room: 'Personnel Airlock PAL-02', description: 'Gowning bench', grade: 'Grade D', createdBy: 'usr-qa' },
    { id: 'EMP-DEMO-D2', code: 'PK-D-01', room: 'Primary Blister Packaging Room', description: 'Blister machine infeed', grade: 'Grade D', createdBy: 'usr-qa' },
  ]);
}
