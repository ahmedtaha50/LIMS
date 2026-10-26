/**
 * Throwaway-database helpers for the Vitest harness. Plain Node, no vitest import, because globalSetup
 * runs outside the test context; the per-file hook lives in testDb.ts.
 *
 * Names are derived from SQL_DB_NAME and never equal it, so the harness can never drop a database that holds
 * real data:   <SQL_DB_NAME>_tpl            template built once per run (schema + protections + test users)
 *              <SQL_DB_NAME>_t<pid>         one copy per test file process
 * With SQL_DB_NAME unset the base is "lims_test".
 */
import pg from 'pg';

export const TEST_PASSWORD = 'password';

/** Users present in every test database. Ids and e-mails match src/server/seed_pg.ts. */
export const TEST_USERS = [
  { id: 'usr-admin', uid: 'admin', email: 'admin@gxp.com', name: 'Test Admin', role: 'Admin' },
  { id: 'usr-qa', uid: 'qa', email: 'qa@gxp.com', name: 'Test QA Officer', role: 'QA' },
  { id: 'usr-reviewer', uid: 'reviewer', email: 'reviewer@gxp.com', name: 'Test Reviewer', role: 'Reviewer' },
  { id: 'usr-analyst1', uid: 'analyst1', email: 'analyst1@gxp.com', name: 'Test Analyst One', role: 'Analyst' },
  { id: 'usr-analyst2', uid: 'analyst2', email: 'analyst2@gxp.com', name: 'Test Analyst Two', role: 'Analyst' },
] as const;

/** The SQL_* settings the harness uses (CI exports them; locally they default to the dev superuser). */
export function sqlEnv() {
  return {
    SQL_HOST: process.env.SQL_HOST || '127.0.0.1',
    SQL_USER: process.env.SQL_USER || 'lims',
    SQL_PASSWORD: process.env.SQL_PASSWORD || 'lims',
  };
}

export function connectionConfig(database: string): pg.ClientConfig {
  const e = sqlEnv();
  return { host: e.SQL_HOST, user: e.SQL_USER, password: e.SQL_PASSWORD, database };
}

// Captured at import time: useTestDb() later points SQL_DB_NAME at the per-file copy.
const BASE = process.env.SQL_DB_NAME || 'lims_test';
export const baseName = () => BASE;
export const templateName = () => `${BASE}_tpl`;

function ident(name: string): string {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

/** Runs fn with a superuser connection to the maintenance database (needed for CREATE/DROP DATABASE). */
export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(connectionConfig('postgres'));
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

export async function dropDatabase(c: pg.Client, name: string) {
  await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
}

export async function createFromTemplate(c: pg.Client, name: string, template: string) {
  await dropDatabase(c, name);
  await c.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(template)}`);
}

export async function createEmpty(c: pg.Client, name: string) {
  await dropDatabase(c, name);
  await c.query(`CREATE DATABASE ${ident(name)}`);
}

export async function listLeftovers(c: pg.Client): Promise<string[]> {
  const like = `${baseName().replace(/[\\_%]/g, '\\$&')}\\_t%`;
  const { rows } = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [like]);
  return rows.map(r => r.datname as string);
}
