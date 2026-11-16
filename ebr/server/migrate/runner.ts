import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from '../core/db.js';

/** A migration file that was already applied has been edited: the database and the code no longer describe the same schema. */
export class MigrationChangedError extends Error {}

export type Migration = { version: string; name: string; sql: string; sha256: string };
export type MigrateResult = { applied: string[]; alreadyApplied: number };

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Any fixed number: every instance that starts uses the same lock, so only one of them migrates at a time. */
const LOCK_KEY = 4_100_001;

/** Reads `NNNN_name.sql` files in order. Two files with the same number, or a file with another name, are refused. */
export function readMigrations(dir: string): Migration[] {
  const out: Migration[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.sql')) continue;
    const m = FILE.exec(f);
    if (!m) throw new Error(`migration file ${f}: the name must be NNNN_lowercase_name.sql`);
    const [, ver, name] = m as unknown as [string, string, string];
    if (out.some(x => x.version === ver)) throw new Error(`two migrations have the number ${ver}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    out.push({ version: ver, name, sql, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/**
 * Applies the migrations that are not in the database yet, each in its own transaction with its ledger row.
 * Forward-only: there is no "down". Safe when several instances start at once (advisory lock). Refuses to start when an
 * applied migration was edited, rather than run on a schema nobody wrote down.
 */
export async function migrate(pool: Pool, dir: string): Promise<MigrateResult> {
  const files = readMigrations(dir);
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await c.query<{ version: string; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations');
    const done = new Map(rows.map(r => [r.version, r]));
    for (const [v, r] of done) {
      const f = files.find(x => x.version === v);
      if (!f) throw new MigrationChangedError(`migration ${v}_${r.name} is applied in the database but its file is missing`);
      if (f.sha256 !== r.sha256) throw new MigrationChangedError(`migration ${v}_${f.name}.sql was edited after it was applied (sha256 ${r.sha256.slice(0, 12)} in the database, ${f.sha256.slice(0, 12)} on disk). Write a new migration instead.`);
    }
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.version)) continue;
      try {
        await c.query('BEGIN');
        await c.query(f.sql);
        await c.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [f.version, f.name, f.sha256]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${f.version}_${f.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      applied.push(`${f.version}_${f.name}`);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    c.release();
  }
}
