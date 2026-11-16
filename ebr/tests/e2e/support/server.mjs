// Starts the BUILT server (dist/) on a fresh database for the browser tests and drops the database when stopped.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const admin = process.env.TEST_ADMIN_URL ?? 'postgres://ebr:ebr@127.0.0.1:5432/postgres';
const name = `ebr_test_e2e_${randomBytes(4).toString('hex')}`;
const url = new URL(admin); url.pathname = '/' + name;
const q = async (sql) => { const c = new pg.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
await q(`CREATE DATABASE "${name}"`);
// accounts for the browser tests, created through the real migrations and password hashing of the built server
const { migrate } = await import('../../../dist/server/migrate/runner.js');
const { hashPassword } = await import('../../../dist/server/identity/password.js');
{
  const c = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await migrate(c, new URL('../../../migrations', import.meta.url).pathname);
  const pw = await hashPassword('e2e password long enough');
  await c.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('e2e-operator', 'E2E Operator', $1, '{operator}', false), ('e2e-new-tablet', 'E2E New tablet', $1, '{operator}', true), ('e2e-new-desktop', 'E2E New desktop', $1, '{operator}', true)", [pw]);
  await c.end();
}
const child = spawn(process.execPath, ['dist/server/main.js'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), PORT: process.env.E2E_PORT ?? '4103', NODE_ENV: 'production' } });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('exit', (code) => { if (!stopping) { console.error(`server exited with ${code}`); void q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).finally(() => process.exit(1)); } });
