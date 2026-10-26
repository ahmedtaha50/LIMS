/** Shared types of the job system. Kept apart from runner.ts so that handlers can import them without a cycle. */
import type { Db } from '../core/context';
import type { Tx } from '../core/tx';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ArtifactRef {
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  expiresAt: Date;
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  /** Parsed JSON, or null. */
  payload: any;
  result: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedBy: string | null;
  heartbeatAt: Date | null;
  createdBy: string | null;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  artifactName: string | null;
  artifactPurgedAt: Date | null;
}

export interface JobContext {
  job: JobRecord;
  db: Db;
  workerId: string;
  /** Aborted when the lease on the job was lost (another worker took it over) or the runner is shutting down. */
  signal: AbortSignal;
}

/** What a handler may return besides a plain value: a file it produced and a write to make in the transaction that completes the job. */
export class JobOutcome {
  constructor(readonly parts: { result?: unknown; artifact?: ArtifactRef; after?: (tx: Tx) => Promise<void> }) {}
}

/** Thrown by a handler when retrying cannot help (the sample is not Approved, the input is invalid). The job fails at once. */
export class PermanentJobError extends Error {
  constructor(message: string) { super(message); this.name = 'PermanentJobError'; }
}

export type Handler = (payload: any, ctx: JobContext) => Promise<unknown>;
