/**
 * Per-test-file database. Gives the file its own copy of the template and points SQL_DB_NAME at it.
 * Importing this module registers the cleanup hook for the file; the copy is dropped after the last test.
 */
import pg from 'pg';
import { afterAll } from 'vitest';
import { baseName, connectionConfig, createFromTemplate, dropDatabase, sqlEnv, templateName, withAdmin } from './db';

export interface TestDb {
  name: string;
  /** Separate from the application's own pool; use it to arrange or inspect rows with plain SQL. */
  pool: pg.Pool;
}

let current: Promise<TestDb> | null = null;

/**
 * Must run BEFORE the first import of src/db/index, which reads SQL_DB_NAME once. Idempotent per file.
 */
export function useTestDb(): Promise<TestDb> {
  if (!current) {
    current = (async () => {
      const name = `${baseName()}_t${process.pid}`;
      await withAdmin(c => createFromTemplate(c, name, templateName()));
      // src/db/index reads these without defaults; make the harness's effective settings visible to it.
      Object.assign(process.env, sqlEnv(), { SQL_DB_NAME: name });
      return { name, pool: new pg.Pool({ ...connectionConfig(name), max: 4 }) };
    })();
  }
  return current;
}

afterAll(async () => {
  if (!current) return;
  const t = await current;
  const appPool: pg.Pool | undefined = (globalThis as any)._postgresPool;
  await Promise.allSettled([appPool?.end(), t.pool.end()]);
  await withAdmin(c => dropDatabase(c, t.name));
  current = null;
});
