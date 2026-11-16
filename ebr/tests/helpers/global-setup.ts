import pg from 'pg';
import { adminUrl } from './db.js';

/** Fails the whole run at once, with the reason, when the database server is not there. */
export default async function setup() {
  const c = new pg.Client({ connectionString: adminUrl() });
  try { await c.connect(); await c.query('SELECT 1'); }
  catch (e) { throw new Error(`PostgreSQL is not reachable for the tests (${e instanceof Error ? e.message : e}). The tests do not skip: start the database or set TEST_ADMIN_URL.`); }
  finally { await c.end().catch(() => undefined); }
}
