#!/usr/bin/env node
// Browser flows against the BUILT application (roadmap M37, r2-validation).
//
//   npm run build
//   node tests/e2e/run.cjs [--out validation/evidence/e2e-run-YYYY-MM-DD.txt] [--only a,b] [--keep]
//
// What it does: creates a throwaway database, installs it with dist-server/init-db.cjs (the shipped installer), loads the demo data,
// starts dist-server/server.cjs on a free loopback port with scratch backup/blob/anchor folders, runs each browser script in Chromium
// against it, writes one "PASS|FAIL <flow> <check id> <text>" line per check to the output file, then stops the server and drops the
// database. Exit code 0 only when every flow ran and every check passed; a flow that crashes or prints no check is a FAIL line.
//
// Needs: PostgreSQL reachable with SQL_HOST / SQL_USER / SQL_PASSWORD (default 127.0.0.1 / lims / lims; the role must be able to create a
// database), psql on the PATH, tsx (dev dependency, for the demo data), Playwright with Chromium, and axe-core for the accessibility
// scan (AXE_PATH, or node_modules/axe-core). Nothing here needs root or the name "localhost": everything uses 127.0.0.1.
const { spawn, spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('--out');
const ONLY = (arg('--only') || '').split(',').filter(Boolean);
const KEEP = process.argv.includes('--keep');

// label, script. The first two are older scripts of earlier tracks; they print "PASS <id> <text>" like the others.
const FLOWS = [
  ['client-shell', 'tests/client-shell.cjs'],
  ['ui-foundation', 'tests/ui-foundation.cjs'],
  ['login', 'tests/e2e/login-totp.cjs'],
  ['workbench', 'tests/e2e/result-workbench.cjs'],
  ['oos', 'tests/e2e/oos-flow.cjs'],
  ['qms', 'tests/e2e/qms-flow.cjs'],
  ['coa', 'tests/e2e/coa-flow.cjs'],
  ['calibrate', 'tests/e2e/calibrate-flow.cjs'],
  ['audit', 'tests/e2e/audit-filter.cjs'],
  ['scope', 'tests/e2e/scope-flow.cjs'],
  ['scan', 'tests/e2e/scan-flow.cjs'],
  ['a11y', 'tests/a11y/axe-gate.cjs'],
].filter(([label]) => !ONLY.length || ONLY.includes(label));

// Known failures of scripts this track does not own (tests/e2e/known-failures.json): shown as KNOWN, never as PASS, each tied to a deviation.
const KNOWN = JSON.parse(fs.readFileSync(path.join(__dirname, 'known-failures.json'), 'utf8')).known;
const knownFor = (flow, text) => KNOWN.find(k => k.flow === flow && text.startsWith(k.startsWith));

const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims' };
const DB = `lims_e2e_${process.pid}`;
const lines = [];
const emit = (line) => { lines.push(line); console.log(line); };

const psql = (db, sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, db, '-qAtc', sql], { env: { ...process.env, PGPASSWORD: SQL.password }, encoding: 'utf8' }).trim();
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findAxe() {
  if (process.env.AXE_PATH) return process.env.AXE_PATH;
  try { return require.resolve('axe-core/axe.min.js', { paths: [ROOT] }); } catch { return undefined; }
}

async function main() {
  for (const f of ['dist-server/server.cjs', 'dist-server/init-db.cjs', 'dist/index.html']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error(`${f} is missing: run "npm run build" first.`); process.exit(2); }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-e2e-'));
  const port = await freePort();
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || (fs.existsSync('/opt/pw-browsers') ? '/opt/pw-browsers' : path.join(os.homedir(), '.cache', 'ms-playwright'));
  const base = {
    ...process.env, SQL_HOST: SQL.host, SQL_USER: SQL.user, SQL_PASSWORD: SQL.password, SQL_DB_NAME: DB, PLAYWRIGHT_BROWSERS_PATH: browsers,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), LIMS_MASTER_KEY: crypto.randomBytes(32).toString('hex'),
    BACKUP_DIR: path.join(scratch, 'backups'), BLOB_DIR: path.join(scratch, 'blobs'), AUDIT_ANCHOR_DIR: path.join(scratch, 'anchors'), ARTIFACT_DIR: path.join(scratch, 'artifacts'),
  };
  let server;
  let code = 0;
  try {
    psql('postgres', `CREATE DATABASE ${DB}`);
    const prod = { ...base, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ADMIN_EMAIL: 'bootstrap@example.invalid', ADMIN_NAME: 'Bootstrap', ADMIN_PASSWORD: 'bootstrap-password-123' };
    const init = spawnSync(process.execPath, ['dist-server/init-db.cjs'], { cwd: ROOT, env: prod, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`init-db failed:\n${init.stdout}\n${init.stderr}`);
    psql(DB, 'DELETE FROM users'); // the demo seed wants an empty users table (README); the demo users replace the bootstrap administrator
    const seed = spawnSync(process.execPath, [require.resolve('tsx/cli', { paths: [ROOT] }), 'scripts/dev/seed/index.ts'], { cwd: ROOT, env: { ...base, NODE_ENV: 'development' }, encoding: 'utf8' });
    if (seed.status !== 0) throw new Error(`demo seed failed:\n${seed.stdout}\n${seed.stderr}`);

    const logFile = path.join(scratch, 'server.log');
    server = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server.cjs'], { cwd: ROOT, env: prod, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')] });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}:\n${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
      try { ready = (await fetch(`${url}/api/ready`)).ok; } catch { /* not yet */ }
      if (!ready) await sleep(500);
    }
    if (!ready) throw new Error(`the server did not answer ${url}/api/ready within 60 s:\n${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
    emit(`INFO bundle ${url} database ${DB} ${new Date().toISOString()}`);

    const env = { ...base, BASE_URL: url, ADMIN_EMAIL: 'admin@gxp.com', ADMIN_PASSWORD: 'password', AXE_PATH: findAxe() || '' };
    if (!env.AXE_PATH) delete env.AXE_PATH;
    for (const [label, script] of FLOWS) {
      if (!fs.existsSync(path.join(ROOT, script))) { emit(`FAIL ${label} script ${script} does not exist`); code = 1; continue; }
      const child = spawnSync(process.execPath, [script], { cwd: ROOT, env, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      let checks = 0, unexpected = 0;
      const matched = new Set();
      for (const l of (child.stdout || '').split('\n')) {
        const m = l.match(/^(PASS|FAIL) (.*)$/);
        if (m) {
          checks++;
          const known = knownFor(label, m[2]);
          if (known && m[1] === 'FAIL') { matched.add(known); emit(`KNOWN ${label} ${m[2]} (${known.deviation})`); continue; }
          if (known && m[1] === 'PASS') { code = 1; unexpected++; emit(`FAIL ${label} ${m[2].split(' ')[0]} is listed in known-failures.json but now passes: remove the entry`); continue; }
          if (m[1] === 'FAIL') { code = 1; unexpected++; }
          emit(`${m[1]} ${label} ${m[2]}`);
        } else if (l.startsWith('INFO ')) emit(`INFO ${label} ${l.slice(5)}`);
      }
      for (const k of KNOWN.filter(k => k.flow === label && !matched.has(k) && !(child.stdout || '').includes(k.startsWith))) {
        code = 1; unexpected++; emit(`FAIL ${label} ${k.startsWith.trim()} is listed in known-failures.json but was not run`);
      }
      // a non-zero exit is explained by the known failures alone; anything else (a crash, no checks) is a failure of its own
      if (!checks || (child.status !== 0 && unexpected === 0 && matched.size === 0)) {
        code = 1;
        emit(`FAIL ${label} script exit ${child.status ?? child.signal} with ${checks} check(s) :: ${(child.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`);
      }
    }
  } catch (e) {
    code = 1;
    emit(`FAIL harness ${String(e.message).split('\n')[0]}`);
    console.error(e.message);
  } finally {
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await sleep(500); if (server.exitCode === null) server.kill('SIGKILL'); }
    if (!KEEP) {
      try { psql('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch (e) { console.error(`could not drop ${DB}: ${e.message}`); }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const failed = lines.filter(l => l.startsWith('FAIL')).length, passed = lines.filter(l => l.startsWith('PASS')).length, known = lines.filter(l => l.startsWith('KNOWN')).length;
  emit(`SUMMARY ${passed} PASS, ${failed} FAIL, ${known} KNOWN (open deviations)`);
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, lines.join('\n') + '\n'); }
  process.exit(code || (failed ? 1 : 0));
}
main();
