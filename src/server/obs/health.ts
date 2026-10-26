/**
 * /api/health: the process is up. /api/ready: it can serve (the database answers and the schema is installed).
 * Unauthenticated by design, so a supervisor, load balancer or installer can poll them, and for that reason they
 * say nothing about the cause of a failure: the detail goes to the server log, not to the caller.
 */
import type { Router } from 'express';
import { createRouter } from '../core/router';
import { log, serializeError } from '../core/logger';

declare const __APP_VERSION__: string | undefined;
const VERSION = typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

export interface PoolLike {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface HealthOptions {
  getPool: () => PoolLike | Promise<PoolLike>;
  timeoutMs?: number;
}

const startedAt = Date.now();

export function healthRouter({ getPool, timeoutMs = 2000 }: HealthOptions): Router {
  const router = createRouter();

  router.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), version: VERSION });
  });

  router.get('/ready', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    try {
      const pool = await getPool();
      const result = await Promise.race([
        pool.query(`select to_regclass('public.users') is not null as schema_present`),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('database did not answer in time')), timeoutMs); }),
      ]);
      if (result.rows[0]?.schema_present !== true) {
        log.warn({}, 'readiness: database reachable but the schema is not installed');
        return res.status(503).json({ status: 'not_ready', checks: { database: 'ok', schema: 'missing' } });
      }
      return res.json({ status: 'ready', checks: { database: 'ok', schema: 'ok' } });
    } catch (err) {
      log.warn({ err: serializeError(err) }, 'readiness: database check failed');
      return res.status(503).json({ status: 'not_ready', checks: { database: 'failed' } });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  return router;
}
