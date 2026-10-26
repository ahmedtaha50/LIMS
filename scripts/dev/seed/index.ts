/**
 * Demo data for development and CI: five users (password "password"), specifications, instruments, batches,
 * samples with results, a chained audit trail, notebook entries, a batch release, training records and an OOS case.
 * One file per domain under seeds/; each seeder skips a table that already has rows, so running this twice is safe.
 *
 *   npm run seed            (tsx scripts/dev/seed/index.ts, with the SQL_* variables of the target database)
 *
 * The demo users have a known password, so this refuses to run when NODE_ENV=production.
 */
import { createPool, db } from '../../../src/db/index';
import { seedUsers } from './seeds/identity';
import { seedSpecifications } from './seeds/specifications';
import { seedMethods } from './seeds/methods';
import { seedInstruments } from './seeds/equipment';
import { seedEnvironmental } from './seeds/environmental';
import { seedEm } from './seeds/em';
import { seedBatchMaterials } from './seeds/batches';
import { seedSamples } from './seeds/samples';
import { seedAuditTrail } from './seeds/audit';
import { seedNotebook } from './seeds/eln';
import { seedBatchReleases } from './seeds/release';
import { seedTraining } from './seeds/training';
import { seedOosInvestigations } from './seeds/oos';

export async function seedAll(): Promise<void> {
  await seedUsers(db);
  await seedSpecifications(db);
  await seedMethods(db);
  await seedInstruments(db);
  await seedEnvironmental(db);
  await seedEm(db);
  await seedBatchMaterials(db);
  await seedSamples(db);
  await seedAuditTrail(db);
  await seedNotebook(db);
  await seedBatchReleases(db);
  await seedTraining(db);
  await seedOosInvestigations(db);
  console.log('GxP seed data populated: users, specifications, draft methods and formulas, instruments, environmental records and sampling points, batches, samples and results, audit trail, notebook, release, training, OOS.');
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data: NODE_ENV=production (the demo users have a known password).');
    process.exit(1);
  }
  try {
    await seedAll();
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  } finally {
    await createPool().end();
  }
}

main();
