// Capacity test (E16): run with `npm run test:perf` after `npm run build`.
//
// Two instances of the BUILT server on one fresh database, behind a round-robin proxy. USERS operators (default 300) arrive
// over RAMP_S seconds (a shift starting); each signs in, opens the batch list, opens its own batch and records its steps.
// Halfway through, instance B is stopped. Passes when: p95 of every operation except sign-in is below 500 ms, sign-in p95
// is reported, no write failed, and every step answered 200 is in the database (nothing recorded was lost).
// Results: tests/perf/results.json. This machine is not the reference server: the numbers say what THIS machine did.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../../server/identity/password.js';
import { startProxy } from './proxy.js';

// THINK_MS: the time an operator spends between two steps (weighing, mixing, reading). 15 s is still several times faster than
// a real shift, where a step takes minutes; THINK_MS=0 is the worst case of every step signed back to back.
const USERS = Number(process.env.USERS ?? 300), RAMP_S = Number(process.env.RAMP_S ?? 60), THINK_MS = Number(process.env.THINK_MS ?? 15000), STEPS = 4, PW = 'capacity test password';
const PORTS = [4201, 4202], PROXY = 4200;
const admin = process.env.TEST_ADMIN_URL ?? 'postgres://ebr:ebr@127.0.0.1:5432/postgres';
const dbName = `ebr_test_perf_${randomBytes(4).toString('hex')}`;
const dbUrl = (() => { const u = new URL(admin); u.pathname = '/' + dbName; return u.toString(); })();
const q = async (url: string, sql: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function startInstance(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/server/main.js', import.meta.url))], { env: { ...process.env, DATABASE_URL: dbUrl, PORT: String(port), NODE_ENV: 'production', DB_POOL_MAX: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`instance ${port} did not start`)), 20_000);
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(child); } });
    child.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${port}] ${d}`));
  });
}

type Sample = { op: string; ms: number; status: number };
const samples: Sample[] = [];
const failures: Array<{ op: string; status: number; body: string }> = [];
async function timed(op: string, url: string, init: RequestInit) {
  const t = performance.now();
  const r = await fetch(url, init).catch(e => ({ status: 0, ok: false, headers: new Headers(), text: async () => String(e) }) as unknown as Response);
  const body = await r.text();
  samples.push({ op, ms: performance.now() - t, status: r.status });
  return { status: r.status, body, headers: r.headers };
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!.toFixed(1) : 0; };

async function main() {
  await q(admin, `CREATE DATABASE "${dbName}"`);
  const a = await startInstance(PORTS[0]!);                        // A migrates the empty database first
  const b = await startInstance(PORTS[1]!);
  const proxy = await startProxy(PROXY, PORTS);
  const base = `http://127.0.0.1:${PROXY}`;
  try {
    // ---- data: users, one effective recipe, one batch per user (prepared directly: not what is measured)
    const hash = await hashPassword(PW);
    const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });
    await pool.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) SELECT 'op' || g, 'Operator ' || g, $1, '{operator}', false FROM generate_series(1, $2) g", [hash, USERS]);
    await pool.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('sup', 'Supervisor', $1, '{supervisor}', false)", [hash]);
    const m = (await pool.query<{ id: string }>("INSERT INTO mbr_masters (code, product_name) VALUES ('PERF', 'Capacity product') RETURNING id")).rows[0]!.id;
    const steps = Array.from({ length: STEPS }, (_, i) => ({ key: `v${i}`, label: `Value ${i}`, type: 'data', unit: 'kg', min: 0, max: 100, decimals: 1, critical: false }));
    await pool.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name) VALUES ($1, 1, 'effective', $2, 'x', 'x')", [m, JSON.stringify({ batchSize: { value: 1, unit: 'kg' }, phases: [{ key: 'p', label: 'P', steps }] })]);
    const sup = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sup', password: PW }) });
    const supCookie = (sup.headers.get('set-cookie') ?? '').split(';')[0]!;
    for (let i = 1; i <= USERS; i++) {
      const r = await fetch(`${base}/api/batches`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: supCookie }, body: JSON.stringify({ mbrMasterId: m, batchNumber: `PERF-${i}` }) });
      if (r.status !== 201) throw new Error(`batch ${i}: ${r.status} ${await r.text()}`);
    }
    await pool.end();

    // ---- the shift: users arrive over RAMP_S seconds; instance B stops halfway
    let stoppedAt = 0, recorded = 0;
    // a maintenance stop: B finishes what it is doing and accepts no new connection; the proxy sends new requests to A
    const stopper = (async () => { await sleep((RAMP_S * 1000) / 2); b.kill('SIGTERM'); stoppedAt = Date.now(); })();
    const started = Date.now();
    await Promise.all(Array.from({ length: USERS }, async (_, k) => {
      await sleep((k * RAMP_S * 1000) / USERS);
      const u = `op${k + 1}`;
      const login = await timed('sign_in', `${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) });
      if (login.status !== 200) { failures.push({ op: 'sign_in', status: login.status, body: login.body.slice(0, 200) }); return; }
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      const h = { 'content-type': 'application/json', cookie };
      const list = await timed('batch_list', `${base}/api/batches?number=PERF-${k + 1}`, { headers: h });
      if (list.status !== 200) { failures.push({ op: 'batch_list', status: list.status, body: list.body.slice(0, 200) }); return; }
      const mine = (JSON.parse(list.body) as Array<{ id: string; batchNumber: string }>).find(x => x.batchNumber === `PERF-${k + 1}`);
      if (!mine) return;
      const opened = await timed('batch_open', `${base}/api/batches/${mine.id}`, { headers: h });
      if (opened.status !== 200) { failures.push({ op: 'batch_open', status: opened.status, body: opened.body.slice(0, 200) }); return; }
      let d = JSON.parse(opened.body);
      for (let s = 0; s < STEPS; s++) {
        const st = d.steps[s];
        const r = await timed('step_record', `${base}/api/batches/${mine.id}/steps/${st.id}/record`, { method: 'POST', headers: h, body: JSON.stringify({ version: st.version, input: { value: 10 + s }, password: PW }) });
        if (r.status !== 200) { failures.push({ op: 'step_record', status: r.status, body: r.body.slice(0, 200) }); break; }
        recorded++;
        d = JSON.parse(r.body);
        if (THINK_MS) await sleep(THINK_MS * (0.7 + 0.6 * Math.random()));
      }
    }));
    await stopper;
    const elapsed = (Date.now() - started) / 1000;

    // ---- nothing recorded is lost
    const inDb = Number((await q(dbUrl, "SELECT count(*) FROM batch_steps WHERE state = 'done'")).rows[0].count);
    const ops = [...new Set(samples.map(s => s.op))];
    const byOp = Object.fromEntries(ops.map(op => { const xs = samples.filter(s => s.op === op); return [op, { n: xs.length, failed: xs.filter(s => s.status !== 200).length, p50: pct(xs.map(s => s.ms), 50), p95: pct(xs.map(s => s.ms), 95), max: pct(xs.map(s => s.ms), 100) }]; }));
    const result = {
      machine: `${(await import('node:os')).cpus().length} cores, ${Math.round((await import('node:os')).totalmem() / 2 ** 30)} GiB, shared by both instances, PostgreSQL, the proxy and the simulated users`,
      users: USERS, rampSeconds: RAMP_S, thinkMs: THINK_MS, stepsPerUser: STEPS, elapsedSeconds: +elapsed.toFixed(1),
      failures: Object.entries(failures.reduce<Record<string, number>>((m, f) => { const k = `${f.op} ${f.status}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, n]) => ({ what: k, n, example: failures.find(f => `${f.op} ${f.status}` === k)!.body })),
      instanceStoppedAfterSeconds: +((stoppedAt - started) / 1000).toFixed(1), byOperation: byOp,
      recordedAnswered200: recorded, recordedInDatabase: inDb, expectedSteps: USERS * STEPS,
    };
    const ok = Object.entries(byOp).every(([op, v]) => v.failed === 0 && (op === 'sign_in' || v.p95 < 500)) && recorded === USERS * STEPS && inDb === recorded;
    writeFileSync(fileURLToPath(new URL('./results.json', import.meta.url)), JSON.stringify({ ...result, verdict: ok ? 'PASS' : 'FAIL' }, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, verdict: ok ? 'PASS' : 'FAIL' }, null, 2));
    process.exitCode = ok ? 0 : 1;
  } finally {
    proxy.close(); a.kill('SIGTERM'); b.kill('SIGKILL');
    await sleep(500);
    await q(admin, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
  }
}
await main();
