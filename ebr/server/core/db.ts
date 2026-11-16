import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/**
 * One pool per process. The pool's `error` event is handled: an idle connection that the database closes (restart, a
 * database dropped by a test) must not crash the process.
 */
export function createPool(connectionString: string, max = 20, onError: (e: Error) => void = () => undefined): Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: 'bpharma-ebr' });
  pool.on('error', onError);
  return pool;
}

/**
 * Runs `fn` in one transaction: COMMIT when it returns, ROLLBACK when it throws. Every write that needs an audit entry
 * does both inside the same call, so neither can exist without the other.
 */
export async function withTx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
