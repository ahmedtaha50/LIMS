import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './core/config.js';
import { createPool } from './core/db.js';
import { authorizer, bootstrapAdmin } from './identity/index.js';
import { migrate } from './migrate/runner.js';
import { loadRoutes } from './routes/index.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL, cfg.DB_POOL_MAX, (e) => console.error(`database connection lost: ${e.message}`));
const m = await migrate(pool, here(import.meta.url.endsWith('.ts') ? '../migrations' : '../../migrations'));
if (m.applied.length) console.log(`migrations applied: ${m.applied.join(', ')}`);
// A new installation (r3-deploy, E19#1): the first administrator from EBR_BOOTSTRAP_ADMIN_USER / _PASSWORD, only while the
// database has no account at all. The password must be changed at the first sign-in; nothing happens on later starts.
if (process.env.EBR_BOOTSTRAP_ADMIN_USER && process.env.EBR_BOOTSTRAP_ADMIN_PASSWORD) {
  const created = await bootstrapAdmin(pool, process.env.EBR_BOOTSTRAP_ADMIN_USER, process.env.EBR_BOOTSTRAP_ADMIN_PASSWORD);
  if (created) console.log(`first administrator ${process.env.EBR_BOOTSTRAP_ADMIN_USER} created: change the password at the first sign-in`);
}
const client = here(import.meta.url.endsWith('.ts') ? '../dist/client' : '../client');
const app = createApp({ pool, routes: await loadRoutes(here('./routes')), authorize: authorizer(pool), ...(existsSync(client) ? { staticDir: client } : {}) });
const server = app.listen(cfg.PORT, cfg.HOST, () => console.log(`B-Pharma EBR listening on http://${cfg.HOST}:${cfg.PORT}`));
const stop = () => { server.close(() => void pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
