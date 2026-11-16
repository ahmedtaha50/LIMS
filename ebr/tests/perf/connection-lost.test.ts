import { describe, expect, it } from 'vitest';
import { createPool } from '../../server/core/db.js';
import { freshDatabase } from '../helpers/db.js';

// Found by the capacity test: a connection ended by the database while a request holds it (restart, failover, an
// administrator terminating it) emitted an unhandled 'error' and crashed the whole server process.
describe('a database connection lost during a request', () => {
  it('does not crash the process: the query fails and the loss is reported', async () => {
    const d = await freshDatabase('kill');
    const lost: string[] = [];
    const pool = createPool(d.url, 2, (e) => lost.push(e.message));
    const killer = createPool(d.url, 1);
    const c = await pool.connect();
    try {
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // the outcome is caught at once: on a fast runner the rejection can arrive before any later handler (seen in CI)
      const outcome = c.query('SELECT pg_sleep(5)').then(() => 'finished', (e: unknown) => e);
      await new Promise(r => setTimeout(r, 200));
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await outcome).toBeInstanceOf(Error);
      for (let i = 0; i < 40 && !lost.length; i++) await new Promise(r => setTimeout(r, 25));
      expect(lost.length).toBeGreaterThan(0);
    } finally {
      c.release(true);
      await killer.end(); await pool.end(); await d.drop();
    }
  });
});
