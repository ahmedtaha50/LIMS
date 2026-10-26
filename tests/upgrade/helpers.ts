/**
 * Helpers for the migration tests: scratch databases, the v0.1.0 fixture, and the product's installer run as a
 * child process (exactly how the desktop shell and tests/helpers/globalSetup.ts run it).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import { afterAll } from 'vitest';
import { baseName, connectionConfig, dropDatabase, sqlEnv, withAdmin } from '../helpers/db';

export const ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(__dirname, 'fixtures');

export interface Scratch {
  name: string;
  pool: pg.Pool;
  /** SQL_* variables pointing at this database, for child processes. */
  env: Record<string, string>;
}

const created: Scratch[] = [];
let counter = 0;

/** An empty database of its own, dropped after the file's last test. */
export async function scratchDb(label: string): Promise<Scratch> {
  const name = `${baseName()}_up${process.pid}_${label.replace(/[^a-z0-9]/gi, '_')}_${++counter}`.slice(0, 63);
  await withAdmin(async c => { await dropDatabase(c, name); await c.query(`CREATE DATABASE "${name}"`); });
  const s: Scratch = {
    name,
    pool: new pg.Pool({ ...connectionConfig(name), max: 4 }),
    env: { ...sqlEnv(), SQL_DB_NAME: name },
  };
  created.push(s);
  return s;
}

afterAll(async () => {
  for (const s of created.splice(0)) {
    await s.pool.end().catch(() => {});
    await withAdmin(c => dropDatabase(c, s.name)).catch(() => {});
  }
});

/** The database exactly as a v0.1.0 installation left it: schema.sql, the triggers, and real signed data. */
export async function loadV010(s: Scratch, opts: { data?: boolean } = {}) {
  const files = ['v0.1.0.schema.sql', 'v0.1.0.protections.sql'];
  if (opts.data !== false) files.push('v0.1.0.data.sql');
  for (const f of files) await s.pool.query(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export interface RunResult { status: number | null; stdout: string; stderr: string }

/** Runs a TypeScript entry point of the product the way the harness does (node --import tsx) and returns its output. */
export function runTs(script: string, args: string[], env: Record<string, string>): RunResult {
  // The product reads its connection from SQL_* only. A PGPASSWORD (or PGUSER, PGHOST...) left in the developer's shell must
  // not reach the child: node-postgres falls back to it, which hid a pool whose password was lost (the pre-migration backup).
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^PG(PASSWORD|PASSFILE|USER|HOST|PORT|DATABASE|SERVICE|SERVICEFILE)$/.test(k)));
  const r = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The installer entry point (src/server/init-db.ts). */
export function runInitDb(s: Scratch, extraEnv: Record<string, string> = {}): RunResult {
  return runTs('src/server/init-db.ts', [], {
    ...s.env,
    ADMIN_EMAIL: 'bootstrap@example.invalid', ADMIN_NAME: 'Bootstrap', ADMIN_PASSWORD: 'bootstrap-password-123',
    ...extraEnv,
  });
}

export async function columnTypes(pool: pg.Pool, table: string): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`, [table]);
  return Object.fromEntries(rows.map(r => [r.column_name, r.data_type]));
}

export async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query(`select to_regclass($1) as t`, [`public.${table}`]);
  return rows[0].t !== null;
}

