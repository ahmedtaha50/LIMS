/**
 * The durable queue behind publishTask (roadmap M15). Everything is a statement against the `jobs` table, so any number of
 * server processes can share one database:
 *
 *   enqueue      one row per job, an unguessable id, an owner, an optional dedupe key (one ACTIVE job per key)
 *   claimNext    UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED): each pending job goes to exactly one caller
 *   heartbeat    the lease: a running job whose heartbeat stops is abandoned
 *   completeJob  guarded by the lease (locked_by): a worker that lost its lease cannot overwrite the new owner's outcome
 *   failJob      back to pending with back-off until max_attempts is used up, then failed (the old nack() looped for ever)
 *   sweepStale   requeues (or fails) running jobs whose lease went stale: a killed process leaves such rows
 *
 * The state changes of a job do not use a version column: the lease predicate (id AND locked_by AND status = 'running') plays that
 * part (AGENTS.md section 2) - two workers cannot both hold it, and a stale one matches no row.
 */
import { randomBytes } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../core/context';
import type { Executor, Tx } from '../core/tx';
import type { ArtifactRef, JobRecord, JobStatus } from './types';

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 30 s, 60 s, 120 s, ... at most 15 minutes. */
export const defaultBackoffSeconds = (attempt: number) => Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));

export class LeaseLostError extends Error {
  constructor(jobId: string) { super(`The lease on job ${jobId} was lost (another worker took it over, or it was finished already).`); this.name = 'LeaseLostError'; }
}

const rowsOf = (res: unknown): any[] => (res as { rows: any[] }).rows;

/** drizzle's execute() hands timestamps back as the text PostgreSQL prints ('2026-10-14 02:00:00+00'). */
const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

function toRecord(r: any): JobRecord {
  let payload: any = null;
  if (r.payload) { try { payload = JSON.parse(r.payload); } catch { payload = null; } }
  return {
    id: r.id, type: r.type, status: r.status as JobStatus, payload, result: r.result ?? null,
    attempts: r.attempts, maxAttempts: r.max_attempts, runAt: toDate(r.run_at)!, lockedBy: r.locked_by, heartbeatAt: toDate(r.heartbeat_at),
    createdBy: r.created_by, dedupeKey: r.dedupe_key, lastError: r.last_error, createdAt: toDate(r.created_at)!, finishedAt: toDate(r.finished_at),
    artifactName: r.artifact_name, artifactPurgedAt: toDate(r.artifact_purged_at),
  };
}

export interface EnqueueOptions {
  type: string;
  payload?: unknown;
  /** Every job belongs to someone: the signed-in user who asked for it, or the service principal for scheduled work. */
  createdBy: string;
  /** Not before this time (default: now, by the database's clock). */
  runAt?: Date;
  /** While a pending or running job has this key, enqueue answers that job instead of adding another. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(ex: Executor, o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  if (!o.createdBy) throw new Error('enqueue: createdBy is required (a job always has an owner)');
  const payload = o.payload === undefined ? null : JSON.stringify(o.payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `job-${randomBytes(12).toString('hex')}`;
    const inserted = rowsOf(await ex.execute(sql`
      INSERT INTO jobs (id, type, status, payload, run_at, max_attempts, created_by, dedupe_key)
      VALUES (${id}, ${o.type}, 'pending', ${payload}, COALESCE(${o.runAt ?? null}::timestamptz, now()), ${o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${o.createdBy}, ${o.dedupeKey ?? null})
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running') DO NOTHING
      RETURNING id`));
    if (inserted.length) return { id, created: true };
    const existing = rowsOf(await ex.execute(sql`SELECT id FROM jobs WHERE dedupe_key = ${o.dedupeKey ?? null} AND status IN ('pending', 'running') LIMIT 1`));
    if (existing.length) return { id: existing[0].id, created: false };
    // the other job finished between the two statements: try to insert again
  }
  throw new Error('enqueue: could not place the job');
}

/** The oldest due pending job, now running under `workerId`; null when there is none. `types` limits it to the handlers the caller has. */
export async function claimNext(ex: Executor, workerId: string, types?: string[]): Promise<JobRecord | null> {
  if (types && types.length === 0) return null;
  const typeFilter: SQL = types ? sql`AND type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})` : sql``;
  const rows = rowsOf(await ex.execute(sql`
    UPDATE jobs SET status = 'running', locked_by = ${workerId}, heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() ${typeFilter}
      ORDER BY run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`));
  return rows.length ? toRecord(rows[0]) : null;
}

/** Extends the lease. False when the caller no longer holds it. */
export async function heartbeat(ex: Executor, id: string, workerId: string): Promise<boolean> {
  const rows = rowsOf(await ex.execute(sql`UPDATE jobs SET heartbeat_at = now() WHERE id = ${id} AND locked_by = ${workerId} AND status = 'running' RETURNING id`));
  return rows.length === 1;
}

export interface CompletionParts {
  result?: unknown;
  artifact?: ArtifactRef;
  /** Runs in the transaction that completes the job (the audit entry of what the job did goes here). */
  after?: (tx: Tx) => Promise<void>;
}

const resultText = (r: unknown): string | null => (r === undefined || r === null ? null : typeof r === 'string' ? r : JSON.stringify(r));

export async function completeJob(db: Db, lease: { id: string; workerId: string }, parts: CompletionParts): Promise<void> {
  const a = parts.artifact;
  await db.transaction(async (tx) => {
    const rows = rowsOf(await tx.execute(sql`
      UPDATE jobs SET status = 'completed', result = ${resultText(parts.result)}, finished_at = now(), updated_at = now(),
        artifact_name = ${a?.name ?? null}, artifact_mime = ${a?.mime ?? null}, artifact_sha256 = ${a?.sha256 ?? null},
        artifact_bytes = ${a?.bytes ?? null}, artifact_expires_at = ${a?.expiresAt ?? null}
      WHERE id = ${lease.id} AND locked_by = ${lease.workerId} AND status = 'running'
      RETURNING id`));
    if (rows.length !== 1) throw new LeaseLostError(lease.id);
    if (parts.after) await parts.after(tx);
  });
}

/** Records a failed attempt. Pending again (after the back-off) unless attempts are used up or `permanent`. Returns what became of it. */
export async function failJob(ex: Executor, lease: { id: string; workerId: string }, error: string, o: { backoffSeconds: number; permanent?: boolean }): Promise<'requeued' | 'failed' | 'lost'> {
  const rows = rowsOf(await ex.execute(sql`
    UPDATE jobs SET
      status = CASE WHEN ${o.permanent ?? false} OR attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      run_at = CASE WHEN ${o.permanent ?? false} OR attempts >= max_attempts THEN run_at ELSE now() + make_interval(secs => ${o.backoffSeconds}) END,
      locked_by = CASE WHEN ${o.permanent ?? false} OR attempts >= max_attempts THEN locked_by ELSE NULL END,
      heartbeat_at = CASE WHEN ${o.permanent ?? false} OR attempts >= max_attempts THEN heartbeat_at ELSE NULL END,
      finished_at = CASE WHEN ${o.permanent ?? false} OR attempts >= max_attempts THEN now() ELSE NULL END,
      last_error = ${error.slice(0, 2000)}, updated_at = now()
    WHERE id = ${lease.id} AND locked_by = ${lease.workerId} AND status = 'running'
    RETURNING status`));
  return rows.length === 0 ? 'lost' : rows[0].status === 'failed' ? 'failed' : 'requeued';
}

/**
 * Running jobs whose heartbeat is older than the lease: the worker died or hung. They go back to pending with back-off, or to
 * failed if they have used their attempts. The row lock (SKIP LOCKED) lets several processes sweep at once.
 */
export async function sweepStale(db: Db, o: { leaseSeconds: number; backoffSeconds?: (attempt: number) => number }): Promise<{ requeued: string[]; failed: string[] }> {
  const backoff = o.backoffSeconds ?? defaultBackoffSeconds;
  return db.transaction(async (tx) => {
    const stale = rowsOf(await tx.execute(sql`
      SELECT id, attempts, max_attempts FROM jobs
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => ${o.leaseSeconds})
      ORDER BY heartbeat_at FOR UPDATE SKIP LOCKED`));
    const out = { requeued: [] as string[], failed: [] as string[] };
    for (const j of stale) {
      if (j.attempts >= j.max_attempts) {
        await tx.execute(sql`UPDATE jobs SET status = 'failed', finished_at = now(), updated_at = now(),
          last_error = 'The worker stopped sending heartbeats (lease expired) and the job had used all its attempts; it was abandoned.' WHERE id = ${j.id}`);
        out.failed.push(j.id);
      } else {
        await tx.execute(sql`UPDATE jobs SET status = 'pending', locked_by = NULL, heartbeat_at = NULL, updated_at = now(),
          run_at = now() + make_interval(secs => ${backoff(j.attempts)}),
          last_error = 'The worker stopped sending heartbeats (lease expired); the job was requeued.' WHERE id = ${j.id}`);
        out.requeued.push(j.id);
      }
    }
    return out;
  });
}
