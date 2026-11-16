// Starts the BUILT server (dist/) on a fresh database for the browser tests and drops the database when stopped.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const admin = process.env.TEST_ADMIN_URL ?? 'postgres://ebr:ebr@127.0.0.1:5432/postgres';
const name = `ebr_test_e2e_${randomBytes(4).toString('hex')}`;
const url = new URL(admin); url.pathname = '/' + name;
const q = async (sql) => { const c = new pg.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
await q(`CREATE DATABASE "${name}"`);
const child = spawn(process.execPath, ['dist/server/main.js'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), PORT: process.env.E2E_PORT ?? '4103', NODE_ENV: 'production' } });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('exit', (code) => { if (!stopping) { console.error(`server exited with ${code}`); void q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).finally(() => process.exit(1)); } });
