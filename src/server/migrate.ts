/**
 * Forward-only migration runner (roadmap M04, EU GMP Annex 11 s.10 change control, 21 CFR Part 11.10(e)).
 *
 * Migrations are the numbered SQL files in drizzle/ (NNNN_name.sql). The journal table schema_migrations(id, sha256, applied_at,
 * app_version) records each applied file with the checksum of its text. One run:
 *
 *   1. takes a session advisory lock, so two processes starting together cannot both migrate;
 *   2. refuses to touch a database it does not understand:
 *        - a journaled migration whose file changed (CHECKSUM_MISMATCH) or is missing (SCHEMA_NEWER: the database was migrated by a
 *          newer build, so this build must not run on it: the downgrade guard);
 *        - a new migration numbered below one already applied (OUT_OF_ORDER);
 *        - a database without a journal whose structural fingerprint is not that of the v0.1.0 baseline (LEGACY_MISMATCH);
 *   3. when the database already holds data, makes a verified backup first (BACKUP_REQUIRED if none can be made);
 *   4. applies everything that is pending, writes the journal rows, installs the append-only triggers and appends one
 *      SCHEMA_MIGRATED entry to the audit hash chain, all in ONE transaction. The upgrade either happens completely, with its
 *      audit record, or not at all: a validated system is never left half-upgraded.
 *
 * Nothing here rewrites or deletes an existing row of the audit trail or of the signatures.
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type pg from 'pg';
import { fingerprint, JOURNAL_TABLE, readStructure, summarize } from './boot/structure';
import { appVersion as currentAppVersion } from './boot/version';

/** Session advisory lock held for the whole run. The audit chain uses 7001 (src/db/utils.ts writeAudit). */
export const MIGRATION_LOCK_KEY = 7002;
const AUDIT_CHAIN_LOCK_KEY = 7001;
const GENESIS_HASH = '0'.repeat(64);

export type MigrationErrorCode =
  | 'BAD_MIGRATIONS' | 'CHECKSUM_MISMATCH' | 'SCHEMA_NEWER' | 'OUT_OF_ORDER' | 'LEGACY_MISMATCH'
  | 'SCHEMA_BEHIND' | 'BACKUP_REQUIRED' | 'BACKUP_FAILED' | 'LOCK_TIMEOUT' | 'MIGRATION_FAILED';

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile { id: string; sha256: string; sql: string }
export interface AppliedMigration { id: string; sha256: string; appliedAt: Date; appVersion: string }

export type SchemaState =
  /** No tables at all: a new database. */
  | { kind: 'empty'; pending: MigrationFile[] }
  /** Tables but no journal, and the structure is exactly v0.1.0: the journal will be started at the baseline. */
  | { kind: 'legacy'; baseline: MigrationFile; pending: MigrationFile[] }
  /** A journal that matches the files on disk. */
  | { kind: 'journaled'; applied: AppliedMigration[]; pending: MigrationFile[] };

export interface BackupResult { file: string; sha256: string; verified: boolean }
export type BackupFn = (ctx: { pool: pg.Pool }) => Promise<BackupResult>;

export interface MigrateOptions {
  /** Folder with the NNNN_name.sql files. Default: $MIGRATIONS_DIR, else ./drizzle. */
  dir?: string;
  /** Apply only up to and including this migration id (restore into an older backup, tests). */
  upTo?: string;
  /** Verified backup, called before anything changes when the database already holds data. */
  backup?: BackupFn;
  /** Runs inside the migration transaction after the SQL files (the boot code installs the append-only triggers here). */
  afterSchema?: (client: pg.PoolClient) => Promise<void>;
  /** Recorded in the journal and in the audit entry. Default: APP_VERSION or package.json. */
  appVersion?: string;
  /** Audit actor. Default: migration:<operating-system user>. */
  actor?: string;
  /** How long to wait for another migrating process (default 120 s) and for table locks held by other sessions (default 30 s). */
  lockWaitMs?: number;
  tableLockTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface MigrationReport {
  status: 'up-to-date' | 'migrated';
  /** The database was new (no tables) before this run. */
  fresh: boolean;
  /** A v0.1.0 installation was recognised and its journal started at 0000_baseline (journaled, not executed). */
  adoptedBaseline: boolean;
  /** The migrations whose SQL this run executed. */
  applied: string[];
  schemaVersion: string | null;
  backup: BackupResult | null;
  auditSequence: number | null;
}

export const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  id text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL
)`;

export const defaultMigrationsDir = () => process.env.MIGRATIONS_DIR || path.join(process.cwd(), 'drizzle');

/** The text that is hashed and executed: no BOM, LF line ends, so a Windows checkout (CRLF) gives the same checksum as Linux. */
const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export const checksum = (text: string) => createHash('sha256').update(normalize(text), 'utf8').digest('hex');

const FILE_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

export function loadMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.sql'));
  } catch {
    throw new MigrationError('BAD_MIGRATIONS', `Migrations folder not found: ${dir}. Set MIGRATIONS_DIR, or run from the folder that contains drizzle/.`);
  }
  const files: MigrationFile[] = [];
  const numbers = new Map<string, string>();
  for (const name of names.sort()) {
    const m = FILE_NAME.exec(name);
    if (!m) throw new MigrationError('BAD_MIGRATIONS', `Migration file "${name}" must be named NNNN_lowercase_name.sql (four digits, then letters, digits and underscores).`);
    const other = numbers.get(m[1]);
    if (other) throw new MigrationError('BAD_MIGRATIONS', `Migrations ${other} and ${name} share the number ${m[1]}; the order would be ambiguous.`);
    numbers.set(m[1], name);
    const sql = normalize(fs.readFileSync(path.join(dir, name), 'utf8'));
    files.push({ id: name.slice(0, -4), sha256: checksum(sql), sql });
  }
  if (files.length === 0) throw new MigrationError('BAD_MIGRATIONS', `No migrations found in ${dir}.`);
  return files;
}

/** The structural fingerprint a v0.1.0 installation must have, written in the header of the first migration. */
export function baselineFingerprint(baseline: MigrationFile): string | null {
  return /^--\s*baseline-structure-sha256:\s*([0-9a-f]{64})\s*$/m.exec(baseline.sql)?.[1] ?? null;
}

async function readJournal(db: pg.ClientBase | pg.Pool): Promise<AppliedMigration[]> {
  const exists = await db.query(`select to_regclass('public.${JOURNAL_TABLE}') as t`);
  if (!exists.rows[0].t) return [];
  const { rows } = await db.query(`select id, sha256, applied_at, app_version from ${JOURNAL_TABLE} order by id`);
  return rows.map(r => ({ id: r.id, sha256: r.sha256, appliedAt: r.applied_at, appVersion: r.app_version }));
}

/**
 * Classifies the database against the files. Throws a MigrationError for every state this build must not touch; changes nothing.
 */
export async function inspectSchema(db: pg.ClientBase | pg.Pool, files: MigrationFile[], upTo?: string): Promise<SchemaState> {
  const wanted = upTo ? files.filter(f => f.id <= upTo) : files;
  const applied = await readJournal(db);

  if (applied.length > 0) {
    const byId = new Map(files.map(f => [f.id, f]));
    const unknown = applied.filter(a => !byId.has(a.id));
    if (unknown.length > 0) {
      throw new MigrationError('SCHEMA_NEWER',
        `This database was migrated by a newer version of the application (it has ${unknown.map(u => u.id).join(', ')}, which this build does not contain). ` +
        `Refusing to continue: install the newer version, or restore a backup taken before that upgrade. Never run an older build on a newer database.`);
    }
    for (const a of applied) {
      const file = byId.get(a.id)!;
      if (file.sha256 !== a.sha256) {
        throw new MigrationError('CHECKSUM_MISMATCH',
          `Migration ${a.id} was edited after it was applied (journal ${a.sha256.slice(0, 12)}…, file ${file.sha256.slice(0, 12)}…). ` +
          `Applied migrations are immutable: restore the original file and put the change into a new migration.`);
      }
    }
    const appliedIds = new Set(applied.map(a => a.id));
    const pending = wanted.filter(f => !appliedIds.has(f.id));
    const highest = applied[applied.length - 1].id;
    const late = pending.find(f => f.id < highest);
    if (late) {
      throw new MigrationError('OUT_OF_ORDER',
        `Migration ${late.id} is new but sorts before ${highest}, which is already applied. Migrations are forward-only: renumber it above ${highest}.`);
    }
    return { kind: 'journaled', applied, pending };
  }

  const structure = await readStructure(db);
  if (Object.keys(structure).length === 0) return { kind: 'empty', pending: wanted };

  const baseline = files[0];
  const expected = baselineFingerprint(baseline);
  const found = fingerprint(structure);
  if (!expected || found !== expected) {
    throw new MigrationError('LEGACY_MISMATCH',
      `This database has tables but no migration journal, and its structure is not that of a B-Pharma LIMS v0.1.0 installation ` +
      `(fingerprint ${found.slice(0, 16)}…, expected ${expected ? expected.slice(0, 16) + '…' : 'none'}). It may have been created or changed by hand. ` +
      `Nothing was changed. Found: ${summarize(structure)}. Run "npx tsx src/server/boot/migrate-cli.ts structure" for the full description.`);
  }
  return { kind: 'legacy', baseline, pending: wanted.slice(1) };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function acquireLock(client: pg.PoolClient, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await client.query('select pg_try_advisory_lock($1) as ok', [MIGRATION_LOCK_KEY]);
    if (rows[0].ok) return;
    if (Date.now() >= deadline) {
      throw new MigrationError('LOCK_TIMEOUT', `Another process has been migrating this database for more than ${Math.round(waitMs / 1000)} s.`);
    }
    await sleep(250);
  }
}

const osUser = () => {
  try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || 'unknown'; }
};

/**
 * One audit-chain entry, written exactly as writeAudit (src/db/utils.ts) writes one: the same serialising lock, the same hash
 * input, so rows from both writers verify under the same chain check. Kept free of the application's modules so the runner can
 * work before the application's own schema is complete.
 */
async function appendAudit(client: pg.PoolClient, e: { userId: string; action: string; entity: string; entityId: string; field: string; oldValue: string; newValue: string; reason: string }) {
  await client.query('select pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_KEY]);
  const head = await client.query('select sequence, hash from audit_trail order by sequence desc limit 1');
  const sequence = head.rows.length ? head.rows[0].sequence + 1 : 1;
  const prevHash = head.rows.length ? head.rows[0].hash : GENESIS_HASH;
  const timestamp = new Date().toISOString();
  const content = JSON.stringify({ sequence, timestamp, userId: e.userId, action: e.action, entity: e.entity, entityId: e.entityId, field: e.field, oldValue: e.oldValue, newValue: e.newValue, reason: e.reason });
  const hash = createHash('sha256').update(content + prevHash).digest('hex');
  await client.query(
    `insert into audit_trail (id, sequence, user_id, action, entity, entity_id, field, old_value, new_value, reason, hash, prev_hash, timestamp_str)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [`adt-${randomBytes(8).toString('hex')}`, sequence, e.userId, e.action, e.entity, e.entityId, e.field, e.oldValue, e.newValue, e.reason, hash, prevHash, timestamp]);
  return sequence as number;
}

function failedAt(file: MigrationFile, err: any): MigrationError {
  const position = Number(err?.position);
  const line = Number.isFinite(position) && position > 0 ? ` at line ${file.sql.slice(0, position - 1).split('\n').length}` : '';
  return new MigrationError('MIGRATION_FAILED', `Migration ${file.id} failed${line}: ${err?.message ?? err}. The database was left unchanged.`, { cause: err });
}

export async function migrate(pool: pg.Pool, options: MigrateOptions = {}): Promise<MigrationReport> {
  const log = options.log ?? (() => {});
  const files = loadMigrations(options.dir);
  const client = await pool.connect();
  // Routine NOTICEs ("trigger ... does not exist, skipping") are noise; a WARNING (see 0001) must reach the person running the upgrade.
  const onNotice = (n: any) => { if (n.severity === 'WARNING') log(`database warning: ${n.message}`); };
  client.on('notice', onNotice);
  try {
    await acquireLock(client, options.lockWaitMs ?? 120_000);
    try {
      return await run(pool, client, files, options, log);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.removeListener('notice', onNotice);
    client.release();
  }
}

async function run(pool: pg.Pool, client: pg.PoolClient, files: MigrationFile[], o: MigrateOptions, log: (m: string) => void): Promise<MigrationReport> {
  const state = await inspectSchema(client, files, o.upTo);
  const toApply = state.pending;
  const adopt = state.kind === 'legacy' ? state.baseline : null;
  const fresh = state.kind === 'empty';
  const lastApplied = state.kind === 'journaled' ? state.applied[state.applied.length - 1]?.id ?? null : null;

  if (!adopt && toApply.length === 0) {
    return { status: 'up-to-date', fresh: false, adoptedBaseline: false, applied: [], schemaVersion: lastApplied, backup: null, auditSequence: null };
  }

  // A database that already holds data is backed up, and the backup verified, before the first byte changes.
  let backup: BackupResult | null = null;
  if (!fresh) {
    if (!o.backup) {
      throw new MigrationError('BACKUP_REQUIRED',
        `${toApply.length + (adopt ? 1 : 0)} migration(s) are pending on a database that holds data, and no pre-migration backup is configured. ` +
        `Set MIGRATION_BACKUP_PASSPHRASE (at least 12 characters; BACKUP_DIR chooses the folder) so a verified backup is made first.`);
    }
    log('Making the pre-migration backup…');
    try {
      backup = await o.backup({ pool });
    } catch (e: any) {
      throw new MigrationError('BACKUP_FAILED', `The pre-migration backup failed, so nothing was changed: ${e?.message ?? e}`, { cause: e });
    }
    if (!backup.verified) throw new MigrationError('BACKUP_FAILED', `The pre-migration backup ${backup.file} did not verify, so nothing was changed.`);
    log(`Backup ${backup.file} verified (sha256 ${backup.sha256}).`);
  }

  const version = o.appVersion ?? currentAppVersion();
  const actor = o.actor ?? `migration:${osUser()}`;
  const journalRows = [...(adopt ? [adopt] : []), ...toApply];
  const ids = journalRows.map(f => f.id);

  await client.query('BEGIN');
  try {
    await client.query(`select set_config('lock_timeout', $1, true)`, [`${o.tableLockTimeoutMs ?? 30_000}ms`]);
    await client.query(JOURNAL_DDL);
    const insertJournal = (f: MigrationFile) =>
      client.query(`insert into ${JOURNAL_TABLE} (id, sha256, app_version) values ($1, $2, $3)`, [f.id, f.sha256, version]);
    if (adopt) {
      await insertJournal(adopt);
      log(`Recognised a v0.1.0 installation: journal started at ${adopt.id} (not executed).`);
    }
    for (const f of toApply) {
      log(`Applying ${f.id}…`);
      try { await client.query(f.sql); } catch (e) { throw failedAt(f, e); }
      await insertJournal(f);
    }
    if (o.afterSchema) await o.afterSchema(client);

    const newest = ids[ids.length - 1];
    const auditSequence = await appendAudit(client, {
      userId: actor,
      action: 'SCHEMA_MIGRATED',
      entity: 'SYSTEM_MIGRATION',
      entityId: newest,
      field: 'schema_version',
      oldValue: lastApplied ?? '',
      newValue: JSON.stringify({
        version: newest, appVersion: version, baselineAdopted: !!adopt, fresh,
        applied: journalRows.map(f => ({ id: f.id, sha256: f.sha256 })),
        backup: backup ? { file: path.basename(backup.file), sha256: backup.sha256 } : null,
      }),
      reason: `Database schema ${fresh ? 'installed' : 'migrated'} to ${newest} by ${actor} (application ${version}): ${ids.join(', ')}` +
        (backup ? `; pre-migration backup ${path.basename(backup.file)} verified` : ''),
    });
    await client.query('COMMIT');
    log(`Schema is at ${newest}.`);
    return { status: 'migrated', fresh, adoptedBaseline: !!adopt, applied: toApply.map(f => f.id), schemaVersion: newest, backup, auditSequence };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof MigrationError) throw e;
    throw new MigrationError('MIGRATION_FAILED', `The migration could not be completed: ${(e as any)?.message ?? e}. The database was left unchanged.`, { cause: e });
  }
}

/**
 * Read-only check for a normal server start: succeeds only when the database is exactly at the newest migration of this build.
 * Throws SCHEMA_NEWER / CHECKSUM_MISMATCH / ... from inspectSchema, or SCHEMA_BEHIND when migrations are pending.
 */
export async function verifySchema(pool: pg.Pool, options: Pick<MigrateOptions, 'dir' | 'upTo'> = {}) {
  const files = loadMigrations(options.dir);
  const state = await inspectSchema(pool, files, options.upTo);
  const how = 'Run the installer (init-db) or "npx tsx src/server/boot/migrate-cli.ts migrate" first.';
  if (state.kind === 'empty') throw new MigrationError('SCHEMA_BEHIND', `The database has no schema yet. ${how}`);
  if (state.kind === 'legacy') throw new MigrationError('SCHEMA_BEHIND', `The database is a v0.1.0 installation that has not been migrated. ${how}`);
  if (state.pending.length > 0) {
    throw new MigrationError('SCHEMA_BEHIND', `The database is ${state.pending.length} migration(s) behind this build (${state.pending.map(p => p.id).join(', ')}). ${how}`);
  }
  return state;
}
