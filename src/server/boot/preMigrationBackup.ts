import path from 'path';
import pg from 'pg';
import { createBackup } from '../backup';
import type { BackupFn } from '../migrate';

const TIMESTAMP_OIDS = new Set([1114 /* timestamp */, 1184 /* timestamptz */]);

/**
 * The verified backup taken before a migration changes a database that holds data. Returns undefined when no passphrase is
 * configured (MIGRATION_BACKUP_PASSPHRASE, else BACKUP_PASSPHRASE); the runner then refuses to migrate.
 *
 * The backup reads timestamps as the text PostgreSQL stores, in a UTC session, instead of letting node-postgres turn the naive
 * v0.1.0 `timestamp` values into local-time Dates: that conversion is what shifted restored times by the machine's UTC offset.
 * The folder is BACKUP_DIR (the desktop shell sets it), else ./backups. src/server/backup.ts (r1-backup-jobs) is the only
 * thing this adapter calls; if backup v2 changes createBackup, adapt it here.
 */
export function preMigrationBackup(env: NodeJS.ProcessEnv = process.env): BackupFn | undefined {
  const passphrase = env.MIGRATION_BACKUP_PASSPHRASE || env.BACKUP_PASSPHRASE;
  if (!passphrase) return undefined;
  return async ({ pool }) => {
    // pg-pool keeps `password` (and ssl.key) as a non-enumerable property so that it does not show in logs; a spread drops it,
    // and a password-authenticated server then refuses the connection ("client password must be a string"). Copy it explicitly.
    const source = (pool as unknown as { options: pg.PoolConfig }).options;
    const reader = new pg.Pool({
      ...source,
      password: source.password,
      max: 1,
      types: { getTypeParser: ((oid: number, format?: string) => (TIMESTAMP_OIDS.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as any))) as any },
    });
    // Stored text of a naive timestamp does not depend on the zone, and a timestamptz is written with its offset; UTC only keeps the text uniform.
    reader.on('connect', client => { client.query("SET TIME ZONE 'UTC'").catch(err => console.error('Could not set the backup session time zone to UTC:', err)); });
    try {
      const r = await createBackup(reader, passphrase, env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
      return { file: r.file, sha256: r.sha256, verified: r.verified };
    } finally {
      await reader.end();
    }
  };
}
