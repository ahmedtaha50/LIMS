// Domain: platform operations (job queue, schedules, backup records, counters). Split out of src/db/schema.ts by r1-migrations;
// r1-backup-jobs owns this file. backup_runs and restore_drills are append-only (src/db/protections/ops.ts).
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, bigint, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * The durable job queue (roadmap M15). pending -> running -> completed | failed. A worker claims a job with FOR UPDATE SKIP LOCKED,
 * holds a lease (locked_by + heartbeat_at) while it runs, and a sweeper requeues a job whose lease went stale. `type` is the
 * handler key. A job belongs to created_by; its result is read by that user only. The result of a file-producing job is a file
 * (artifact_*), kept until artifact_expires_at.
 */
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  payload: text('payload'),
  result: text('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Added by migration 0080 (roadmap M15)
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  lockedBy: text('locked_by'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  createdBy: text('created_by').references(() => users.id),
  dedupeKey: text('dedupe_key'),
  lastError: text('last_error'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  artifactName: text('artifact_name'),
  artifactMime: text('artifact_mime'),
  artifactSha256: text('artifact_sha256'),
  artifactBytes: bigint('artifact_bytes', { mode: 'number' }),
  artifactExpiresAt: timestamp('artifact_expires_at', { withTimezone: true }),
  artifactPurgedAt: timestamp('artifact_purged_at', { withTimezone: true }),
}, (t) => [
  index('jobs_claim_idx').on(t.runAt).where(sql`${t.status} = 'pending'`),
  index('jobs_running_heartbeat_idx').on(t.heartbeatAt).where(sql`${t.status} = 'running'`),
  uniqueIndex('jobs_dedupe_active_uidx').on(t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
  index('jobs_created_by_idx').on(t.createdBy),
  index('jobs_artifact_expires_idx').on(t.artifactExpiresAt).where(sql`${t.artifactName} IS NOT NULL AND ${t.artifactPurgedAt} IS NULL`),
]);

/** What is due when. The scheduler enqueues a job for every enabled row whose next_due_at has passed (src/server/scheduler.ts). */
export const scheduledJobs = pgTable('scheduled_jobs', {
  name: text('name').primaryKey(),
  cron: text('cron').notNull(), // 5 fields, server local time
  type: text('type').notNull(), // the job type to enqueue
  payload: text('payload'),
  description: text('description').default('').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
  lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true }),
  lastJobId: text('last_job_id'),
  version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('scheduled_jobs_due_idx').on(t.nextDueAt).where(sql`${t.enabled}`),
]);

/** One row per backup attempt (ok or failed), written when the attempt ends. Append-only. */
export const backupRuns = pgTable('backup_runs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // scheduled | manual
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(), // ok | failed
  fileName: text('file_name'),
  bytes: bigint('bytes', { mode: 'number' }),
  sha256: text('sha256'),
  schemaVersion: text('schema_version'),
  auditHeadSequence: integer('audit_head_sequence'),
  auditHeadHash: text('audit_head_hash'),
  counts: text('counts'), // JSON {table: rows}
  verified: boolean('verified').default(false).notNull(),
  mirrorOk: boolean('mirror_ok'), // null: no mirror configured
  mirrorSha256: text('mirror_sha256'),
  mirrorError: text('mirror_error'),
  error: text('error'),
  jobId: text('job_id'),
  createdBy: text('created_by').references(() => users.id).notNull(),
}, (t) => [
  index('backup_runs_finished_at_idx').on(t.finishedAt),
  index('backup_runs_created_by_idx').on(t.createdBy),
]);

/** One row per restore drill: a backup restored into a scratch database and compared with the manifest. Append-only. */
export const restoreDrills = pgTable('restore_drills', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  backupFile: text('backup_file'),
  backupSha256: text('backup_sha256'),
  scratchDb: text('scratch_db'),
  passed: boolean('passed').notNull(),
  chainIntact: boolean('chain_intact'),
  countsMatch: boolean('counts_match'),
  hashesMatch: boolean('hashes_match'),
  timestampsMatch: boolean('timestamps_match'),
  tablesCompared: integer('tables_compared'),
  detail: text('detail'), // JSON: problems found
  error: text('error'),
  jobId: text('job_id'),
  createdBy: text('created_by').references(() => users.id).notNull(),
}, (t) => [
  index('restore_drills_finished_at_idx').on(t.finishedAt),
  index('restore_drills_created_by_idx').on(t.createdBy),
]);

/**
 * Gap-free counters behind nextSequence(tx, key) in src/server/core/tx.ts. Key convention for sample numbers:
 * 'sample:<year>' (migration 0002 seeds it from the highest existing SMP-<year>-<n> id).
 */
export const counters = pgTable('counters', {
  key: text('key').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});
