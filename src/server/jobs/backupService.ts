/**
 * Backup operations (roadmap M14): what turns the file format of src/server/backup.ts into a process an auditor can follow.
 *
 *   runBackup       make a backup, copy it to the mirror and re-hash the copy, record the run (append-only backup_runs) and audit it,
 *                   all with the actor that asked (the signed-in administrator, or the service principal for a scheduled run)
 *   applyRetention  7 daily / 4 weekly / 12 monthly: delete only what this system made, never the newest, audit what was deleted
 *   runDrill        restore the latest backup into a scratch database, compare chain, counts, hashes and timestamp columns with the
 *                   manifest, drop the scratch database, record the result (append-only restore_drills)
 *   backupStatus    last good backup, mirror state, last drill, and the banners the UI shows when something needs attention
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import pg from 'pg';
import { backupRuns, restoreDrills } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { createBackup, restoreBackup } from '../backup';
import type { Db } from '../core/context';
import { autoOpenQmsRecord } from '../qms';

export interface Retention { daily: number; weekly: number; monthly: number }

export interface BackupSettings {
  dir: string;
  /** A second location (another disk, a share): the PC's own disk is not a backup of the PC. null: none configured. */
  mirrorDir: string | null;
  /** The key of scheduled backups. In the desktop shell it comes from the operating system's credential store (BACKUP_PASSPHRASE). */
  passphrase: string | null;
  retention: Retention;
  /** A backup older than this many hours raises the BACKUP_STALE banner (36: a nightly backup plus a missed night's slack). */
  staleHours: number;
  /** No passed restore drill for this many days raises DRILL_DUE (40: a monthly drill plus slack). */
  drillDays: number;
}

const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4, monthly: 12 };

function parseRetention(text: string | undefined): Retention {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text ?? '');
  return m ? { daily: Number(m[1]), weekly: Number(m[2]), monthly: Number(m[3]) } : DEFAULT_RETENTION;
}

export function backupSettings(env: NodeJS.ProcessEnv = process.env): BackupSettings {
  let passphrase = env.BACKUP_PASSPHRASE || null;
  if (!passphrase && env.BACKUP_PASSPHRASE_FILE) {
    try { passphrase = fs.readFileSync(env.BACKUP_PASSPHRASE_FILE, 'utf8').trim() || null; } catch { passphrase = null; }
  }
  return {
    dir: env.BACKUP_DIR || path.join(process.cwd(), 'backups'),
    mirrorDir: env.BACKUP_MIRROR_DIR || null,
    passphrase,
    retention: parseRetention(env.BACKUP_RETENTION),
    staleHours: 36,
    drillDays: 40,
  };
}

const poolOf = (db: Db): pg.Pool => {
  const pool = (db as unknown as { $client?: pg.Pool }).$client;
  if (!pool || typeof pool.connect !== 'function') throw new Error('The database handle has no connection pool.');
  return pool;
};
const newId = (prefix: string) => `${prefix}-${randomBytes(8).toString('hex')}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- mirror ----------------------------------------------------------------------------------------------------------

export interface MirrorResult { configured: boolean; ok: boolean | null; sha256: string | null; error: string | null }

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

const removeQuietly = (file: string) => { try { fs.rmSync(file, { force: true }); } catch { /* the folder may not exist or be readable: nothing to clean */ } };

/** Copies `file` into the mirror folder, reads the copy back and compares its SHA-256 with the original's. */
export async function mirrorCopy(file: string, mirrorDir: string | null, sha256: string): Promise<MirrorResult> {
  if (!mirrorDir) return { configured: false, ok: null, sha256: null, error: null };
  const dest = path.join(mirrorDir, path.basename(file));
  const part = `${dest}.part`;
  try {
    fs.mkdirSync(mirrorDir, { recursive: true });
    await pipeline(fs.createReadStream(file), fs.createWriteStream(part, { flags: 'w', mode: 0o600 }));
    const fd = fs.openSync(part, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd);
    const copied = await sha256Of(part);
    if (copied !== sha256) { removeQuietly(part); return { configured: true, ok: false, sha256: copied, error: 'The copy in the mirror folder does not match the backup (checksum differs).' }; }
    fs.renameSync(part, dest);
    return { configured: true, ok: true, sha256: copied, error: null };
  } catch (e) {
    removeQuietly(part);
    return { configured: true, ok: false, sha256: null, error: `The mirror folder is not available: ${errorText(e)}` };
  }
}

// ---- a backup run ----------------------------------------------------------------------------------------------------

export interface RunBackupArgs {
  db: Db;
  pool?: pg.Pool;
  settings: BackupSettings;
  /** The user (or the service principal) the run and its audit entries are attributed to. */
  actorId: string;
  kind: 'scheduled' | 'manual';
  /** The audit reason: 'Scheduled: <task>' for a timer, the user's stated reason otherwise. */
  reason: string;
  jobId?: string | null;
  /** A passphrase typed by the administrator; scheduled runs use settings.passphrase. */
  passphrase?: string;
}

export interface BackupRunResult {
  runId: string;
  file: string;
  sha256: string;
  bytes: number;
  verified: boolean;
  problems: string[];
  auditHead: { sequence: number; hash: string | null };
  counts: Record<string, number>;
  mirror: MirrorResult;
}

export async function runBackup(a: RunBackupArgs): Promise<BackupRunResult> {
  const startedAt = new Date();
  const runId = newId('run');
  let made: Awaited<ReturnType<typeof createBackup>> | null = null;
  let mirror: MirrorResult = { configured: !!a.settings.mirrorDir, ok: null, sha256: null, error: null };
  let failure: string | null = null;
  try {
    const passphrase = a.passphrase ?? a.settings.passphrase;
    if (!passphrase) throw new Error('No backup passphrase is configured. Set BACKUP_PASSPHRASE (the desktop shell keeps it in the operating system credential store).');
    made = await createBackup(a.pool ?? poolOf(a.db), passphrase, a.settings.dir);
    mirror = await mirrorCopy(made.file, a.settings.mirrorDir, made.sha256);
  } catch (e) {
    failure = errorText(e);
  }

  const verified = !!made && made.verified;
  const error = failure ?? (made && !made.verified ? `The backup was written but did not pass verification: ${made.problems.join('; ')}` : null);
  const detail = made ? `sha256=${made.sha256}; auditHead=${made.manifest.auditHead.sequence}; mirror=${mirror.ok === null ? 'none' : mirror.ok ? 'ok' : 'failed'}` : '';
  await a.db.transaction(async (tx) => {
    await tx.insert(backupRuns).values({
      id: runId, kind: a.kind, startedAt, finishedAt: new Date(), status: verified ? 'ok' : 'failed',
      fileName: made?.name ?? null, bytes: made?.bytes ?? null, sha256: made?.sha256 ?? null,
      schemaVersion: made?.manifest.schemaVersion ?? null, auditHeadSequence: made?.manifest.auditHead.sequence ?? null, auditHeadHash: made?.manifest.auditHead.hash ?? null,
      counts: made ? JSON.stringify(made.manifest.counts) : null, verified,
      mirrorOk: mirror.ok, mirrorSha256: mirror.sha256, mirrorError: mirror.error, error, jobId: a.jobId ?? null, createdBy: a.actorId,
    });
    await writeAudit(tx, a.actorId, verified ? 'BACKUP_CREATED' : 'BACKUP_FAILED', 'System', made?.name ?? runId, 'backup', '', verified ? detail : (error ?? 'failed'), a.reason);
    if (made && mirror.ok === false) await writeAudit(tx, a.actorId, 'BACKUP_MIRROR_FAILED', 'System', made.name, 'backup', '', mirror.error ?? 'mirror failed', a.reason);
    // r2-qms (roadmap M27): a failed backup opens a deviation for QA triage, in the same transaction as the failed run.
    if (!verified) {
      await autoOpenQmsRecord(tx, { source: 'backup-failed', sourceId: runId, actorId: a.actorId, title: `Backup failed (${a.kind})`, description: error ?? 'The backup failed.' });
    }
  });
  if (!made) throw new Error(failure!);
  return { runId, file: made.name, sha256: made.sha256, bytes: made.bytes, verified, problems: made.problems, auditHead: made.manifest.auditHead, counts: made.manifest.counts, mirror };
}

// ---- retention -------------------------------------------------------------------------------------------------------

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}`;
/** Monday-based week, labelled by the Monday's date. */
const weekKey = (d: Date) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(m); };

/**
 * Which files to keep: the newest backup of each of the last `daily` days, `weekly` weeks and `monthly` months that have one, in
 * the server's local time. The newest backup is always kept, whatever the policy says. Pure.
 */
export function retentionKeep(files: Array<{ name: string; at: Date }>, policy: Retention): Set<string> {
  const sorted = [...files].sort((a, b) => b.at.getTime() - a.at.getTime());
  const keep = new Set<string>();
  if (sorted.length) keep.add(sorted[0].name);
  const take = (key: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const f of sorted) {
      const k = key(f.at);
      if (seen.has(k)) continue; // the newest of that day, week or month has already been taken
      if (seen.size >= count) break;
      seen.add(k); keep.add(f.name);
    }
  };
  take(dayKey, policy.daily); take(weekKey, policy.weekly); take(monthKey, policy.monthly);
  return keep;
}

export interface RetentionResult { deleted: string[]; kept: string[]; failed: Array<{ file: string; error: string }> }

/**
 * Deletes the scheduled backups outside the retention rule from the backup folder and the mirror. Only files that a successful
 * scheduled run in backup_runs says this system made are candidates: a backup an Administrator made by hand (before an upgrade, at
 * a milestone), a pre-migration backup, or a file someone copied there is never deleted automatically.
 */
export async function applyRetention(a: { db: Db; settings: BackupSettings; actorId: string; reason: string }): Promise<RetentionResult> {
  const runs = await a.db.select({ name: backupRuns.fileName, at: backupRuns.finishedAt }).from(backupRuns)
    .where(and(eq(backupRuns.status, 'ok'), isNotNull(backupRuns.fileName), eq(backupRuns.kind, 'scheduled')));
  const dirs = [a.settings.dir, ...(a.settings.mirrorDir ? [a.settings.mirrorDir] : [])];
  const present = new Map<string, Date>();
  for (const r of runs) if (r.name && dirs.some(d => fs.existsSync(path.join(d, path.basename(r.name!))))) present.set(r.name, r.at);
  const candidates = [...present].map(([name, at]) => ({ name, at }));
  const keep = retentionKeep(candidates, a.settings.retention);

  const out: RetentionResult = { deleted: [], kept: candidates.filter(c => keep.has(c.name)).map(c => c.name), failed: [] };
  for (const c of candidates) {
    if (keep.has(c.name)) continue;
    let ok = true;
    for (const d of dirs) {
      try { fs.rmSync(path.join(d, path.basename(c.name)), { force: true }); }
      catch (e) { ok = false; out.failed.push({ file: path.join(d, c.name), error: errorText(e) }); }
    }
    if (ok) out.deleted.push(c.name);
  }
  if (out.deleted.length) {
    await a.db.transaction(async (tx) => {
      await writeAudit(tx, a.actorId, 'BACKUP_RETENTION', 'System', 'backup-retention', 'backups', '',
        JSON.stringify({ policy: a.settings.retention, deleted: out.deleted, kept: out.kept.length }), a.reason);
    });
  }
  return out;
}

// ---- restore drill ---------------------------------------------------------------------------------------------------

export interface DrillResult {
  drillId: string;
  passed: boolean;
  file: string | null;
  sha256: string | null;
  scratchDb: string | null;
  chainIntact: boolean | null;
  countsMatch: boolean | null;
  hashesMatch: boolean | null;
  timestampsMatch: boolean | null;
  tablesCompared: number | null;
  error: string | null;
}

/**
 * Restores a backup into a scratch database and compares it with what the backup says it holds. `file` is a backup file name in
 * the backup folder; default: the newest successful run whose file is still there. The scratch database is dropped afterwards.
 */
export async function runDrill(a: { db: Db; pool?: pg.Pool; settings: BackupSettings; actorId: string; reason: string; jobId?: string | null; file?: string }): Promise<DrillResult> {
  const startedAt = new Date();
  const drillId = newId('drill');
  const pool = a.pool ?? poolOf(a.db);
  const base = (pool as unknown as { options: pg.PoolConfig }).options;
  const res: DrillResult = { drillId, passed: false, file: null, sha256: null, scratchDb: null, chainIntact: null, countsMatch: null, hashesMatch: null, timestampsMatch: null, tablesCompared: null, error: null };
  let problems: string[] = [];
  let admin: pg.Client | null = null;
  let scratch: pg.Pool | null = null;
  try {
    if (!a.settings.passphrase) throw new Error('No backup passphrase is configured, so the backup cannot be opened. Set BACKUP_PASSPHRASE.');
    let name = a.file ? path.basename(a.file) : null;
    if (!name) {
      const runs = await a.db.select({ name: backupRuns.fileName }).from(backupRuns).where(and(eq(backupRuns.status, 'ok'), isNotNull(backupRuns.fileName))).orderBy(desc(backupRuns.finishedAt)).limit(20);
      name = runs.map(r => r.name!).find(n => fs.existsSync(path.join(a.settings.dir, n))) ?? null;
    }
    if (!name) throw new Error('There is no backup file to restore (no successful backup run with a file in the backup folder).');
    const full = path.join(a.settings.dir, name);
    if (!fs.existsSync(full)) throw new Error(`Backup file ${name} was not found in the backup folder.`);
    res.file = name;
    res.sha256 = await sha256Of(full);

    const scratchName = `${(base.database ?? 'lims').slice(0, 40)}_drill_${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}`;
    res.scratchDb = scratchName;
    admin = new pg.Client({ host: base.host, port: base.port, user: base.user, password: base.password, database: 'postgres' });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    try { await admin.query(`CREATE DATABASE "${scratchName}"`); }
    catch (e) { throw new Error(`The scratch database could not be created (the database role needs CREATEDB): ${errorText(e)}`); }
    scratch = new pg.Pool({ host: base.host, port: base.port, user: base.user, password: base.password, database: scratchName, max: 2 });
    // the scratch database is dropped WITH (FORCE) at the end: a connection the server terminates must not become an unhandled 'error' event
    scratch.on('error', () => undefined);

    const r = await restoreBackup(full, a.settings.passphrase, scratch);
    Object.assign(res, { chainIntact: r.chainIntact, countsMatch: r.countsMatch, hashesMatch: r.hashesMatch, timestampsMatch: r.timestampsMatch, tablesCompared: r.tablesCompared });
    problems = r.problems;
    res.passed = r.chainIntact && r.countsMatch && r.hashesMatch === true && r.timestampsMatch === true;
    if (!res.passed && !res.error) res.error = `The restored database differs from the backup: ${r.problems.join('; ') || 'a check failed'}`;
  } catch (e) {
    res.error = errorText(e);
  } finally {
    await scratch?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${res.scratchDb}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }

  await a.db.transaction(async (tx) => {
    await tx.insert(restoreDrills).values({
      id: drillId, startedAt, finishedAt: new Date(), backupFile: res.file, backupSha256: res.sha256, scratchDb: res.scratchDb, passed: res.passed,
      chainIntact: res.chainIntact, countsMatch: res.countsMatch, hashesMatch: res.hashesMatch, timestampsMatch: res.timestampsMatch, tablesCompared: res.tablesCompared,
      detail: problems.length ? JSON.stringify(problems) : null, error: res.error, jobId: a.jobId ?? null, createdBy: a.actorId,
    });
    await writeAudit(tx, a.actorId, 'BACKUP_DRILL', 'System', drillId, 'restore_drill', '',
      `passed=${res.passed}; file=${res.file ?? '-'}; chain=${res.chainIntact}; counts=${res.countsMatch}; tables=${res.hashesMatch}; timestamps=${res.timestampsMatch}${res.error ? `; error=${res.error.slice(0, 300)}` : ''}`, a.reason);
  });
  return res;
}

// ---- status ----------------------------------------------------------------------------------------------------------

/** For GET /api/ready (src/server/obs/health.ts): when the newest successful backup finished, or null if there has been none. */
export async function lastSuccessfulBackupAt(db: Db): Promise<Date | null> {
  const [r] = await db.select({ at: backupRuns.finishedAt }).from(backupRuns).where(eq(backupRuns.status, 'ok')).orderBy(desc(backupRuns.finishedAt)).limit(1);
  return r?.at ?? null;
}

export interface Banner { level: 'error' | 'warning' | 'info'; code: string; message: string }

export interface BackupStatus {
  lastSuccessfulBackupAt: string | null;
  lastRun: { id: string; status: string; kind: string; finishedAt: string; file: string | null; error: string | null } | null;
  mirror: { configured: boolean; ok: boolean | null; error: string | null; checkedAt: string | null };
  lastDrill: { id: string; passed: boolean; finishedAt: string; file: string | null; error: string | null } | null;
  banners: Banner[];
}

export async function backupStatus(db: Db, settings: BackupSettings, now = new Date()): Promise<BackupStatus> {
  const [lastRun] = await db.select().from(backupRuns).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [lastOk] = await db.select().from(backupRuns).where(eq(backupRuns.status, 'ok')).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [lastWithFile] = await db.select().from(backupRuns).where(isNotNull(backupRuns.fileName)).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [lastDrill] = await db.select().from(restoreDrills).orderBy(desc(restoreDrills.finishedAt)).limit(1);
  const [lastPassedDrill] = await db.select().from(restoreDrills).where(eq(restoreDrills.passed, true)).orderBy(desc(restoreDrills.finishedAt)).limit(1);
  const [firstOk] = await db.select().from(backupRuns).where(eq(backupRuns.status, 'ok')).orderBy(backupRuns.finishedAt).limit(1);

  const mirror = { configured: !!settings.mirrorDir, ok: lastWithFile?.mirrorOk ?? null, error: lastWithFile?.mirrorError ?? null, checkedAt: lastWithFile?.finishedAt?.toISOString() ?? null };
  const banners: Banner[] = [];
  const hours = (d: Date) => (now.getTime() - d.getTime()) / 3_600_000;
  if (!lastOk) banners.push({ level: 'error', code: 'NO_BACKUP', message: 'No successful backup has been made yet.' });
  else if (hours(lastOk.finishedAt) > settings.staleHours) {
    banners.push({ level: 'error', code: 'BACKUP_STALE', message: `The last successful backup is ${Math.floor(hours(lastOk.finishedAt))} hours old (limit ${settings.staleHours}).` });
  }
  if (lastRun && lastRun.status === 'failed') banners.push({ level: 'error', code: 'BACKUP_FAILED', message: `The last backup attempt failed: ${lastRun.error ?? 'unknown error'}` });
  if (!settings.mirrorDir) banners.push({ level: 'warning', code: 'NO_MIRROR', message: 'No second copy is configured: the backups exist only on this PC\'s disk (BACKUP_MIRROR_DIR).' });
  else if (mirror.ok === false) banners.push({ level: 'error', code: 'MIRROR_FAILED', message: `The last backup could not be copied to the mirror: ${mirror.error ?? 'unknown error'}` });
  if (lastDrill && !lastDrill.passed) banners.push({ level: 'error', code: 'DRILL_FAILED', message: `The last restore drill failed: ${lastDrill.error ?? 'the restored database differs from the backup'}` });
  const drillReference = lastPassedDrill?.finishedAt ?? firstOk?.finishedAt;
  if (drillReference && (now.getTime() - drillReference.getTime()) / 86_400_000 > settings.drillDays) {
    banners.push({ level: 'warning', code: 'DRILL_DUE', message: `No restore drill has passed in the last ${settings.drillDays} days.` });
  }

  return {
    lastSuccessfulBackupAt: lastOk?.finishedAt.toISOString() ?? null,
    lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, kind: lastRun.kind, finishedAt: lastRun.finishedAt.toISOString(), file: lastRun.fileName, error: lastRun.error } : null,
    mirror,
    lastDrill: lastDrill ? { id: lastDrill.id, passed: lastDrill.passed, finishedAt: lastDrill.finishedAt.toISOString(), file: lastDrill.backupFile, error: lastDrill.error } : null,
    banners,
  };
}
