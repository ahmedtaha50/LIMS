import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Pool } from '../../server/core/db.js';

/**
 * The PostgreSQL server the tests use. Defaults to the development role of AGENTS.md; CI sets TEST_ADMIN_URL.
 * The tests never skip when it is unreachable: a run that tested nothing must not look green.
 */
export const adminUrl = () => process.env.TEST_ADMIN_URL ?? 'postgres://ebr:ebr@127.0.0.1:5432/postgres';
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = '/' + db; return u.toString(); };

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  try { await c.connect(); }
  catch (e) { throw new Error(`PostgreSQL is not reachable at ${adminUrl().replace(/:[^:@/]*@/, ':***@')} (${e instanceof Error ? e.message : e}). Start it (pg_ctlcluster 16 main start) or set TEST_ADMIN_URL. The tests do not skip.`); }
  try { return await fn(c); } finally { await c.end(); }
}

/** An empty database of its own: created now, dropped by `drop()`. The name says it is a test database. */
export async function freshDatabase(label = 't'): Promise<{ name: string; url: string; pool: Pool; drop: () => Promise<void> }> {
  const name = `ebr_test_${label}_${randomBytes(4).toString('hex')}`;
  await admin(c => c.query(`CREATE DATABASE "${name}"`));
  const url = withDb(adminUrl(), name);
  const pool = createPool(url, 5);
  return {
    name, url, pool,
    drop: async () => { await pool.end(); await admin(c => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)); },
  };
}
