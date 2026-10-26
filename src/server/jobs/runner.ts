/**
 * The worker side of the queue (roadmap M15): claims jobs, runs their handlers, keeps the lease alive with a heartbeat, and
 * sweeps for the leases other workers lost. One runner per server process; any number of processes can share a database.
 *
 *   - a worker claims only the types it has a handler for, so an older process never fails a job of a newer type;
 *   - the heartbeat runs while the handler runs; if the lease is lost (a stall, then another worker took the job) the handler's
 *     signal is aborted and its late result is discarded by the lease guard in completeJob;
 *   - handlers should be idempotent: a crash between the side effect and the completion runs the job again (at-least-once).
 */
import { randomBytes } from 'crypto';
import os from 'os';
import { log, serializeError } from '../core/logger';
import type { Db } from '../core/context';
import { defaultHandlers } from './handlers';
import { claimNext, completeJob, defaultBackoffSeconds, failJob, heartbeat, LeaseLostError, sweepStale } from './queue';
import { JobOutcome, PermanentJobError, type Handler, type JobRecord } from './types';

export { JobOutcome, PermanentJobError };
export type { Handler };

export interface RunnerOptions {
  db: Db;
  workerId?: string;
  /** Jobs run at once in this process (default 2: a long backup does not block a PDF). */
  concurrency?: number;
  /** How often an idle worker looks for work (an enqueue in this process wakes it at once). Default 2 s. */
  pollMs?: number;
  /** How often stale leases are swept. Default 15 s. */
  sweepMs?: number;
  heartbeatMs?: number;
  /** A running job without a heartbeat for this long is abandoned. Default 60 s. */
  leaseSeconds?: number;
  backoffSeconds?: (attempt: number) => number;
  /** Default: the built-in handlers (handlers/index.ts). */
  handlers?: Record<string, Handler>;
}

export interface Runner {
  workerId: string;
  /** Look for work now (called after a job was enqueued in this process, or when a broker says one is waiting). */
  nudge(): void;
  /** Stops claiming, waits (up to 30 s) for the jobs in flight, stops the timers. */
  stop(): Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startRunner(o: RunnerOptions): Runner {
  const { db } = o;
  const workerId = o.workerId ?? `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  const concurrency = o.concurrency ?? 2;
  const pollMs = o.pollMs ?? 2000;
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const leaseSeconds = o.leaseSeconds ?? 60;
  const backoff = o.backoffSeconds ?? defaultBackoffSeconds;
  const handlers = o.handlers ?? defaultHandlers();
  const types = Object.keys(handlers);

  let stopping = false;
  const sleepers = new Set<() => void>();
  const wait = (ms: number) => new Promise<void>(resolve => {
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  });
  const nudge = () => { for (const wake of [...sleepers]) wake(); };

  async function execute(job: JobRecord) {
    const handler = handlers[job.type];
    const abort = new AbortController();
    const beat = setInterval(() => {
      heartbeat(db, job.id, workerId).then(held => { if (!held) abort.abort(new LeaseLostError(job.id)); }).catch(err => log.warn({ err: serializeError(err), job: job.id }, 'heartbeat failed'));
    }, heartbeatMs);
    try {
      const out = await handler(job.payload, { job, db, workerId, signal: abort.signal });
      const parts = out instanceof JobOutcome ? out.parts : { result: out };
      await completeJob(db, { id: job.id, workerId }, parts);
    } catch (err) {
      if (err instanceof LeaseLostError) { log.warn({ job: job.id, worker: workerId }, 'job lease lost; result discarded'); return; }
      const permanent = err instanceof PermanentJobError;
      log.error({ err: serializeError(err), job: job.id, type: job.type, attempt: job.attempts }, 'job failed');
      try {
        await failJob(db, { id: job.id, workerId }, errorText(err), { backoffSeconds: backoff(job.attempts), permanent });
      } catch (e2) { log.error({ err: serializeError(e2), job: job.id }, 'could not record the failure of a job'); }
    } finally {
      clearInterval(beat);
    }
  }

  async function loop() {
    while (!stopping) {
      let job: JobRecord | null = null;
      try { job = await claimNext(db, workerId, types); }
      catch (err) { log.error({ err: serializeError(err) }, 'could not claim a job'); await wait(pollMs); continue; }
      if (!job) { await wait(pollMs); continue; }
      await execute(job);
    }
  }

  const sweep = () => sweepStale(db, { leaseSeconds, backoffSeconds: backoff })
    .then(r => { if (r.requeued.length || r.failed.length) log.warn({ requeued: r.requeued, failed: r.failed }, 'stale job leases swept'); })
    .catch(err => log.error({ err: serializeError(err) }, 'lease sweep failed'));
  void sweep();
  const sweeper = setInterval(() => void sweep(), o.sweepMs ?? 15_000);

  const loops = Array.from({ length: concurrency }, () => loop());

  return {
    workerId,
    nudge,
    async stop() {
      stopping = true;
      clearInterval(sweeper);
      nudge();
      await Promise.race([Promise.allSettled(loops), new Promise(r => setTimeout(r, 30_000))]);
    },
  };
}
