/**
 * Database start-up, in one place: bring the schema to this build's version (or check that it already is), then install the
 * append-only triggers. Used by the installer (src/server/init-db.ts) and by the migration CLI. server.ts should call
 * bootDatabase({ migrate: true }) where it calls ensureProtections() today (see docs/migrations.md).
 */
import type pg from 'pg';
import { applyProtections } from '../../db/protections';
import { migrate, verifySchema, type BackupFn, type MigrationReport } from '../migrate';
import { preMigrationBackup } from './preMigrationBackup';
import { appRoleStep } from './steps/roles';

export interface BootOptions {
  /** true: apply pending migrations (with the pre-migration backup). false: only check; a database that is behind or ahead is an error. */
  migrate: boolean;
  /** Default: the application's pool (SQL_* environment). */
  pool?: pg.Pool;
  dir?: string;
  /** Default: preMigrationBackup() from the environment. Pass null to configure none (the runner then refuses on a database with data). */
  backup?: BackupFn | null;
  log?: (message: string) => void;
}

export async function bootDatabase(o: BootOptions): Promise<{ report: MigrationReport | null }> {
  const pool = o.pool ?? (await import('../../db/index')).createPool();
  let report: MigrationReport | null = null;
  if (o.migrate) {
    report = await migrate(pool, {
      dir: o.dir,
      log: o.log,
      backup: o.backup === undefined ? preMigrationBackup() : o.backup ?? undefined,
      afterSchema: client => applyProtections(client),
    });
  } else {
    await verifySchema(pool, { dir: o.dir });
  }
  await applyProtections(pool); // every start, as ensureProtections() always did
  // After the protections, which re-create the guard triggers: lims_app and ENABLE ALWAYS (roadmap M35, src/db/roles.ts).
  await appRoleStep(pool, { log: o.log });
  return { report };
}
