import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp, type AppOptions } from '../../server/app.js';
import { migrate } from '../../server/migrate/runner.js';
import { loadRoutes } from '../../server/routes/index.js';
import { freshDatabase } from './db.js';

export const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
export const ROUTES = fileURLToPath(new URL('../../server/routes', import.meta.url));

/** The real application on a fresh, migrated database, listening on a free port. */
export async function startApp(extra: Partial<AppOptions> = {}) {
  const db = await freshDatabase('app');
  await migrate(db.pool, MIGRATIONS);
  const logs: string[] = [];
  const app = createApp({ pool: db.pool, routes: await loadRoutes(ROUTES), log: (l) => logs.push(l), ...extra });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  return { db, base, call, logs, close: async () => { await new Promise<void>(r => server.close(() => r())); await db.drop(); } };
}
