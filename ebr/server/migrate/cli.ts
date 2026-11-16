import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { createPool } from '../core/db.js';
import { migrate } from './runner.js';

const cfg = loadConfig();
const pool = createPool(cfg.DATABASE_URL, 2);
try {
  const r = await migrate(pool, fileURLToPath(new URL('../../migrations', import.meta.url)));
  console.log(r.applied.length ? `applied: ${r.applied.join(', ')}` : `nothing to apply (${r.alreadyApplied} already applied)`);
} finally {
  await pool.end();
}
