import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './core/config.js';
import { createPool } from './core/db.js';
import { migrate } from './migrate/runner.js';
import { loadRoutes } from './routes/index.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL, cfg.DB_POOL_MAX, (e) => console.error(`database connection lost: ${e.message}`));
const m = await migrate(pool, here(import.meta.url.endsWith('.ts') ? '../migrations' : '../../migrations'));
if (m.applied.length) console.log(`migrations applied: ${m.applied.join(', ')}`);
const client = here(import.meta.url.endsWith('.ts') ? '../dist/client' : '../client');
const app = createApp({ pool, routes: await loadRoutes(here('./routes')), ...(existsSync(client) ? { staticDir: client } : {}) });
const server = app.listen(cfg.PORT, cfg.HOST, () => console.log(`B-Pharma EBR listening on http://${cfg.HOST}:${cfg.PORT}`));
const stop = () => { server.close(() => void pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
