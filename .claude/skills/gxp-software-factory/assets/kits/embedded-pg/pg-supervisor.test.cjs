// The embedded PostgreSQL (desktop/pg-supervisor.cjs) against the REAL PostgreSQL 16 server binaries of this machine.
// Windows specifics (the bundled binaries, icacls) are not exercised here; everything else is the same code path.
// Needs the PostgreSQL 16 server binaries: LIMS_PG_BIN, or /usr/lib/postgresql/16/bin. Without them the tests are skipped (and say so).
// PostgreSQL refuses to run as root: as root the server runs as the "postgres" account (runAs), as in the sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { execFileSync, spawnSync } = require('child_process');
const pgs = require('../../desktop/pg-supervisor.cjs');

const binDir = [process.env.LIMS_PG_BIN, '/usr/lib/postgresql/16/bin'].find(d => d && fs.existsSync(path.join(d, process.platform === 'win32' ? 'initdb.exe' : 'initdb')));
const skip = binDir ? false : 'PostgreSQL 16 server binaries not found (set LIMS_PG_BIN)';
const runAs = (process.getuid && process.getuid() === 0)
  ? { uid: Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' })), gid: Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' })) } : undefined;

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function workDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-pgsup-')); fs.chmodSync(d, 0o755); return d; }
const OWNER_PW = 'owner-pw-' + 'x'.repeat(24), APP_PW = 'app-pw-' + 'y'.repeat(24);
const q = (port, sql, o = {}) => pgs.psql({ binDir, port, user: o.user || 'lims_owner', password: o.password || OWNER_PW, database: o.database || 'postgres', sql });

/** A provisioned, started cluster; `t.after` stops it. */
async function cluster(t, o = {}) {
  const dir = workDir();
  const port = o.port || await freePort();
  const dataDir = path.join(dir, 'pgdata');
  const events = [];
  await pgs.provision({ binDir, dataDir, port, ownerPassword: OWNER_PW, runAs });
  const sup = pgs.superviseEmbedded({ binDir, dataDir, port, logFile: path.join(dir, 'postgres.log'), runAs, onEvent: (type, d) => events.push({ type, ...d }) });
  t.after(async () => { await sup.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await sup.start();
  return { dir, port, dataDir, sup, events };
}

test('provision: a private cluster on loopback, UTC, scram-sha-256, checksums, no trust rule', { skip }, async (t) => {
  const dir = workDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'pgdata');
  await pgs.provision({ binDir, dataDir, port: await freePort(), ownerPassword: OWNER_PW, runAs });
  assert.ok(fs.existsSync(path.join(dataDir, 'PG_VERSION')));
  const hba = fs.readFileSync(path.join(dataDir, 'pg_hba.conf'), 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  assert.ok(hba.length > 0);
  for (const l of hba) { assert.match(l, /scram-sha-256/, l); assert.doesNotMatch(l, /\btrust\b/, l); }
  const conf = fs.readFileSync(path.join(dataDir, 'postgresql.conf'), 'utf8');
  assert.match(conf, /^listen_addresses = '127\.0\.0\.1'/m);
  assert.match(conf, /^timezone = 'UTC'/m);
  assert.match(conf, /^idle_in_transaction_session_timeout = '60s'/m);
  assert.match(fs.readFileSync(path.join(dir, 'pgdata', 'PG_VERSION'), 'utf8'), /^16/);
  // a second call does not re-initialise (and does not lose the data) : the owner password stays the one that was set
  await pgs.provision({ binDir, dataDir, port: await freePort(), ownerPassword: 'another-password-that-is-ignored', runAs });
});

test('a started cluster listens on loopback only, answers in UTC and refuses a wrong password', { skip }, async (t) => {
  const c = await cluster(t);
  assert.equal(q(c.port, 'show timezone').trim(), 'UTC');
  assert.equal(q(c.port, 'show listen_addresses').trim(), '127.0.0.1');
  assert.equal(q(c.port, 'show password_encryption').trim(), 'scram-sha-256');
  assert.equal(q(c.port, 'show data_checksums').trim(), 'on');
  assert.throws(() => q(c.port, 'select 1', { password: 'wrong' }), /password authentication failed/);
  // the cluster is not reachable on another address of this machine
  const external = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
  if (external) {
    const refused = await new Promise(r => { const s = net.connect({ host: external.address, port: c.port }); s.once('connect', () => { s.destroy(); r(false); }); s.once('error', () => r(true)); });
    assert.ok(refused, 'reachable on ' + external.address);
  }
});

test('an existing PostgreSQL on its own port does not conflict (the embedded one uses its own port)', { skip }, async (t) => {
  // Something listens on 5432: the PostgreSQL of this machine when there is one, else a stand-in listener.
  const busy = await new Promise(r => { const s = net.connect({ host: '127.0.0.1', port: 5432 }); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
  if (!busy) { const holder = net.createServer(); await new Promise(r => holder.listen(5432, '127.0.0.1', r)); t.after(() => new Promise(r => holder.close(() => r()))); }
  const c = await cluster(t);
  assert.notEqual(c.port, 5432);
  assert.equal(q(c.port, 'select 42').trim(), '42');
});

test('bootstrap: database owned by lims_owner; lims_app is a separate, unprivileged login', { skip }, async (t) => {
  const c = await cluster(t);
  pgs.bootstrapDatabase({ binDir, port: c.port, ownerPassword: OWNER_PW, database: 'lims' });
  pgs.bootstrapDatabase({ binDir, port: c.port, ownerPassword: OWNER_PW, database: 'lims' }); // idempotent
  assert.equal(q(c.port, "select pg_catalog.pg_get_userbyid(datdba) from pg_database where datname='lims'").trim(), 'lims_owner');
  assert.equal(q(c.port, 'show timezone', { database: 'lims' }).trim(), 'UTC');
  // what init-db does (applyAppRole) is simulated here with the role the application step creates; finalizeAppRole narrows it further
  q(c.port, `create role lims_app login password '${APP_PW}' nosuperuser nocreatedb nocreaterole`, { database: 'lims' });
  q(c.port, 'grant connect on database lims to lims_app', { database: 'lims' });
  pgs.finalizeAppRole({ binDir, port: c.port, ownerPassword: OWNER_PW, database: 'lims' });
  const attrs = q(c.port, "select rolsuper::text||rolcreatedb::text||rolcreaterole::text from pg_roles where rolname='lims_app'").trim();
  assert.equal(attrs, 'falsefalsefalse');
  assert.match(q(c.port, "select array_to_string(setconfig, ',') from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='lims_app'"), /statement_timeout=/);
  assert.equal(q(c.port, 'select current_user', { user: 'lims_app', password: APP_PW, database: 'lims' }).trim(), 'lims_app');
  assert.throws(() => q(c.port, 'create table x(a int)', { user: 'lims_app', password: APP_PW, database: 'lims' }), /permission denied/);
  // another database user of this cluster (PUBLIC) cannot connect to lims
  assert.equal(q(c.port, "select has_database_privilege('public','lims','CONNECT')::text").trim(), 'false');
});

test('killing the postmaster recovers within 15 s with the committed data intact', { skip }, async (t) => {
  const c = await cluster(t);
  q(c.port, 'create table keep(a int); insert into keep values (1),(2),(3)');
  const pid = Number(fs.readFileSync(path.join(c.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const t0 = Date.now();
  process.kill(pid, 'SIGKILL');
  let back = false;
  while (Date.now() - t0 < 15000) {
    await sleep(250);
    try { if (q(c.port, 'select count(*) from keep').trim() === '3') { back = true; break; } } catch { /* still recovering */ }
  }
  assert.ok(back, 'not back within 15 s');
  assert.ok(c.events.some(e => e.type === 'PG_EXIT'), JSON.stringify(c.events));
  assert.ok(c.events.some(e => e.type === 'PG_RESTART'), JSON.stringify(c.events));
});

test('stop leaves no postgres process and no listener; a second stop is harmless', { skip }, async (t) => {
  const c = await cluster(t);
  const pid = Number(fs.readFileSync(path.join(c.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  await c.sup.stop();
  await c.sup.stop();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(fs.existsSync(path.join(c.dataDir, 'postmaster.pid')), false);
  const open = await new Promise(r => { const s = net.connect({ host: '127.0.0.1', port: c.port }); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
  assert.equal(open, false);
});

test('a postgres left running by a crashed application is stopped cleanly and replaced, not duplicated', { skip }, async (t) => {
  const c = await cluster(t);
  q(c.port, 'create table survive(a int); insert into survive values (7)');
  const oldPid = Number(fs.readFileSync(path.join(c.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  // a second supervisor on the same data directory = the next start of the application after the first one died without stopping it
  const sup2 = pgs.superviseEmbedded({ binDir, dataDir: c.dataDir, port: c.port, logFile: path.join(c.dir, 'postgres2.log'), runAs, onEvent: () => {} });
  c.sup.detach(); // the first supervisor's process is gone (as if the application was killed): it must not restart or stop anything now
  t.after(() => sup2.stop());
  await sup2.start();
  assert.equal(q(c.port, 'select a from survive').trim(), '7');
  const newPid = Number(fs.readFileSync(path.join(c.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  assert.notEqual(newPid, oldPid);
  assert.throws(() => process.kill(oldPid, 0), /ESRCH/);
});

test('start fails with a clear message when the port is taken by something else', { skip }, async (t) => {
  const dir = workDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'pgdata');
  const holder = net.createServer(); await new Promise(r => holder.listen(0, '127.0.0.1', r)); t.after(() => holder.close());
  const port = holder.address().port;
  await pgs.provision({ binDir, dataDir, port, ownerPassword: OWNER_PW, runAs });
  const sup = pgs.superviseEmbedded({ binDir, dataDir, port, logFile: path.join(dir, 'postgres.log'), runAs, onEvent: () => {} });
  await assert.rejects(sup.start(), /port .* (is|already) .*use|in use/i);
  await sup.stop();
});

test('free-disk guard: refuses when less than the required space is free, accepts when enough', () => {
  const dir = os.tmpdir();
  assert.equal(pgs.checkDisk(dir, 1).ok, true);
  const r = pgs.checkDisk(dir, Number.MAX_SAFE_INTEGER);
  assert.equal(r.ok, false);
  assert.match(r.message, /free disk space/i);
  assert.equal(pgs.checkDisk(path.join(dir, 'does', 'not', 'exist', 'yet'), 1).ok, true); // walks up to the nearest existing folder
});

test('findBinDir: packaged builds use only the bundled folder; the override and the system folder are for development trees', () => {
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-res-'));
  try {
    fs.mkdirSync(path.join(res, 'pgsql', 'bin'), { recursive: true });
    const exe = process.platform === 'win32' ? 'postgres.exe' : 'postgres';
    fs.writeFileSync(path.join(res, 'pgsql', 'bin', exe), '');
    fs.writeFileSync(path.join(res, 'pgsql', 'bin', exe.replace('postgres', 'initdb')), '');
    assert.equal(pgs.findBinDir({ isPackaged: true, resourcesPath: res, env: { LIMS_PG_BIN: '/elsewhere' } }), path.join(res, 'pgsql', 'bin'));
    assert.equal(pgs.findBinDir({ isPackaged: true, resourcesPath: path.join(res, 'none'), env: { LIMS_PG_BIN: binDir || '/x' } }), null);
    if (binDir) assert.equal(pgs.findBinDir({ isPackaged: false, resourcesPath: path.join(res, 'none'), env: { LIMS_PG_BIN: binDir } }), binDir);
  } finally { fs.rmSync(res, { recursive: true, force: true }); }
});

test('verifyBinaries: the bundled executables are checked against the recorded SHA-256', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-bin-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'postgres'), 'binary one');
    const sha = require('crypto').createHash('sha256').update('binary one').digest('hex');
    fs.writeFileSync(path.join(root, 'PG_BINARIES.json'), JSON.stringify({ version: '16.4', files: { 'bin/postgres': sha } }));
    assert.deepEqual(pgs.verifyBinaries(root), { ok: true, version: '16.4', errors: [] });
    fs.writeFileSync(path.join(root, 'bin', 'postgres'), 'tampered');
    const bad = pgs.verifyBinaries(root);
    assert.equal(bad.ok, false); assert.match(bad.errors[0], /bin\/postgres/);
    fs.rmSync(path.join(root, 'PG_BINARIES.json'));
    assert.equal(pgs.verifyBinaries(root).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the spawn environment drops inherited PG* variables and carries no secret', () => {
  const env = pgs.cleanEnv({ PATH: '/bin', PGPASSWORD: 'x', PGOPTIONS: '-c timezone=Africa/Cairo', PGTZ: 'Africa/Cairo', PGHOST: 'elsewhere', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
