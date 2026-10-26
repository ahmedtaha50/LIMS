import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

declare global {
  var _postgresPool: pg.Pool | undefined;
  var _postgresAppPool: pg.Pool | undefined;
}

/** Optional ceiling for one statement (milliseconds). Unset: whatever the server or the role says (the built-in database sets it on lims_app). */
const statementTimeoutMs = () => {
  const n = Number(process.env.SQL_STATEMENT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function newPool(user: string | undefined, password: string | undefined) {
  const pool = new pg.Pool({
    host: process.env.SQL_HOST,
    // The built-in PostgreSQL (desktop/pg-supervisor.cjs) listens on its own loopback port, never on 5432.
    port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
    user,
    password,
    database: process.env.SQL_DB_NAME,
    max: 10,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
  });

  // Timestamps are timestamptz, so the instant never depends on the session zone; UTC keeps date_trunc, ::date and the text
  // form of timestamps identical on every machine (the desktop installs run in Cairo and anywhere else). A SET after connect,
  // not the `options` start-up parameter, because connection poolers such as PgBouncer reject that parameter. The client
  // runs its queries in order, so this one precedes the first query of whoever receives the connection.
  pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'UTC'").catch((err) => console.error('Could not set the session time zone to UTC:', err));
    const ms = statementTimeoutMs();
    if (ms) client.query(`SET statement_timeout = ${ms}`).catch((err) => console.error('Could not set the statement timeout:', err));
  });

  pool.on('error', (err: any) => {
    // Ignore routine connection drops
    if (err.message && err.message.includes('terminating connection due to administrator command')) {
      return;
    }
    console.error('Unexpected error on idle SQL pool client:', err);
  });
  return pool;
}

/** The owner connection (SQL_USER): installer, migrations, backup and restore. */
export const createPool = () => {
  if (!global._postgresPool) global._postgresPool = newPool(process.env.SQL_USER, process.env.SQL_PASSWORD);
  return global._postgresPool;
};

/**
 * The connection for request handling. With SQL_APP_USER set (the built-in database of the desktop installation, roadmap M40) it is
 * the unprivileged lims_app role (src/db/roles.ts); otherwise it is the owner connection, as before.
 */
export const createAppPool = () => {
  if (!process.env.SQL_APP_USER) return createPool();
  if (!global._postgresAppPool) global._postgresAppPool = newPool(process.env.SQL_APP_USER, process.env.SQL_APP_PASSWORD);
  return global._postgresAppPool;
};

const pool = createAppPool();

export const db = drizzle(pool, { schema });

// Backup and restore (src/server/jobs/backupService.ts) take their connection from db.$client and need the owner's rights (a restore
// drops and re-creates tables). With a separate request role, $client therefore stays the owner pool, which connects only when used.
if (pool !== global._postgresPool) Object.defineProperty(db, '$client', { value: createPool(), configurable: true });
