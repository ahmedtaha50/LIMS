// Demo data for an EMPTY installation (E33):   EBR_DEMO_PASSWORD='...' npm run demo-data
// In the Docker installation:   docker compose ... exec -e EBR_DEMO_PASSWORD='...' app node dist/server/demo/cli.js
// The password comes from the environment (never from the command line). It is the password of every demo account.
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { createPool } from '../core/db.js';
import { migrate } from '../migrate/runner.js';
import { fillDemo } from './index.js';

const password = process.env.EBR_DEMO_PASSWORD ?? '';
if (!password) { console.error('set EBR_DEMO_PASSWORD: the password of every demo account (12 characters at least)'); process.exit(2); }
const pool = createPool(loadConfig().DATABASE_URL, 4);
try {
  // from the sources (server/demo/cli.ts) or the build (dist/server/demo/cli.js): the migrations of the installation
  await migrate(pool, fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../migrations' : '../../../migrations', import.meta.url)));
  const r = await fillDemo(pool, password);
  console.log(`demo data written:
  accounts  ${r.accounts.join(', ')} (password: the one you gave; QA sets up its authenticator at the first sign-in)
  logbooks  ${r.logbooks.join(', ')} (cleaned and calibrated; built-in types reviewed by demo-qa)
  lots      ${r.lots.join(', ')} (released by demo-qa)
  recipe    ${r.recipe} (effective): sign in as demo-supervisor and create a batch from it`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally { await pool.end(); }
