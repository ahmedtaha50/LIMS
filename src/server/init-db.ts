/**
 * Database installation and upgrade (run by the Electron shell, or by IT). Idempotent.
 *  - brings the schema to this build's version with the migration runner (src/server/migrate.ts): installs a new database,
 *    or upgrades an existing one after a verified pre-migration backup (MIGRATION_BACKUP_PASSPHRASE, BACKUP_DIR)
 *  - installs the audit/signature immutability triggers
 *  - creates the first Administrator when no users exist
 * Secrets are read from the environment, never from argv.
 */
import { randomBytes } from 'crypto';
import { createPool, db } from '../db/index';
import { users } from '../db/schema';
import { generatePasswordHash } from '../db/utils';
import { bootDatabase } from './boot';

async function main() {
  const pool = createPool();
  const { report } = await bootDatabase({ migrate: true, pool, log: m => console.log(m) });
  console.log(report && report.status === 'migrated'
    ? `Schema ${report.fresh ? 'installed' : 'upgraded'} to ${report.schemaVersion} (applied: ${report.applied.join(', ') || 'none; v0.1.0 recognised and journaled'}).`
    : 'Schema already up to date.');

  const existing = await db.select().from(users).limit(1);
  if (existing.length === 0) {
    const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
      throw new Error('First administrator required: set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (min 12 characters).');
    }
    await db.insert(users).values({
      id: `usr-${randomBytes(4).toString('hex')}`, uid: `local-${randomBytes(4).toString('hex')}`,
      email: ADMIN_EMAIL, name: ADMIN_NAME, role: 'Admin',
      passwordHash: generatePasswordHash(ADMIN_PASSWORD), hasCompletedSoftwareTraining: false,
    } as any);
    console.log('First administrator created.');
  }
  await pool.end();
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1); });
