/**
 * Entry point of the background job system (roadmap M15). The file keeps its name and its two exports, because server.ts and
 * reports.ts import them; what stands behind them is the database queue in src/server/jobs.
 *
 *   QUEUE_DRIVER=pg    (default) every server process polls the jobs table and claims with FOR UPDATE SKIP LOCKED
 *   QUEUE_DRIVER=amqp  as pg, and RabbitMQ (RABBITMQ_URL) also carries a "work is waiting" message so a worker wakes at once.
 *                      The database stays the source of truth (retries, leases, ownership); the broker is only a doorbell, and
 *                      the system works, with polling, when the broker is down.
 */
import amqp from 'amqplib';
import { db } from '../db';
import { log, serializeError } from './core/logger';
import { ensureServicePrincipal } from './jobs/principal';
import { enqueue } from './jobs/queue';
import { startRunner, type Runner } from './jobs/runner';
import { startScheduler, type TickHandle } from './scheduler';

const QUEUE = 'lims_jobs';
let runner: Runner | null = null;
let scheduler: TickHandle | null = null;
let channel: amqp.Channel | null = null;
let connection: Awaited<ReturnType<typeof amqp.connect>> | null = null;

/** Starts the workers and the scheduler of this process. Called once by server.ts. */
export async function initRabbitMQ() {
  if (runner) return;
  const driver = (process.env.QUEUE_DRIVER || 'pg').toLowerCase();
  if (driver !== 'pg' && driver !== 'amqp') throw new Error(`QUEUE_DRIVER must be "pg" or "amqp" (got "${driver}")`);

  runner = startRunner({ db });
  scheduler = await startScheduler(db, { onEnqueued: () => runner?.nudge() });
  log.info({ driver, worker: runner.workerId }, 'job system started');

  if (driver === 'amqp') {
    try {
      connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
      channel = await connection.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
      await channel.consume(QUEUE, (msg) => { if (msg) { runner?.nudge(); channel?.ack(msg); } });
      connection.on('error', () => { channel = null; });
      connection.on('close', () => { channel = null; });
    } catch (err) {
      channel = null;
      log.warn({ err: serializeError(err) }, 'RabbitMQ is not available; background jobs are found by polling the database'); // the URL may hold credentials: not logged
    }
  }
}

export async function stopJobSystem() {
  scheduler?.stop(); scheduler = null;
  await runner?.stop(); runner = null;
  await channel?.close().catch(() => undefined); channel = null;
  await connection?.close().catch(() => undefined); connection = null;
}

export interface PublishOptions {
  /** The user who asked for the work; default: the service principal. Only that user may read the job and its file. */
  createdBy?: string;
  runAt?: Date;
  /** While a pending or running job has this key, the call returns that job's id. */
  dedupeKey?: string;
}

/** Queues a job and returns its id. The signature (type, data) is the one the callers have always used. */
export async function publishTask(type: string, data: unknown, options: PublishOptions = {}): Promise<string> {
  const createdBy = options.createdBy ?? await ensureServicePrincipal(db);
  const { id, created } = await enqueue(db, { type, payload: data, createdBy, runAt: options.runAt, dedupeKey: options.dedupeKey });
  if (created) {
    runner?.nudge();
    if (channel) { try { channel.sendToQueue(QUEUE, Buffer.from(id), { persistent: true }); } catch { /* the polling finds it */ } }
  }
  return id;
}
