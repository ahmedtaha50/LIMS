/**
 * The built-in PostgreSQL of the desktop installation (roadmap M40). No Electron API in this file: desktop/main.cjs calls it, and
 * tests/installer/pg-supervisor.test.cjs runs it against the PostgreSQL 16 binaries of a Linux machine.
 *
 *  - provision():          initdb of a private cluster in the user's data folder: scram-sha-256 for every rule (no trust), data
 *                          checksums, UTF-8, loopback only, UTC, an idle-in-transaction timeout; the folder is restricted to the
 *                          installing user. The superuser of the cluster is lims_owner (DDL and migrations). It is never used by
 *                          the request path: the application connects as lims_app (src/db/roles.ts), created by init-db.
 *  - superviseEmbedded():  starts postgres directly (so the process is ours), polls pg_isready, restarts it after a crash with a
 *                          back-off, replaces a postgres left behind by a crashed application, and stops it gracefully
 *                          (fast shutdown through pg_ctl, which also works on Windows where signals do not).
 *  - bootstrapDatabase() / finalizeAppRole(): the database and the role settings, through psql with the password on stdin's
 *                          environment (never on a command line).
 *  - findBinDir() / verifyBinaries(): where the binaries are, and that the bundled executables are the ones recorded at build time.
 *
 * Windows-only parts: the bundled binaries (desktop/pg-fetch.cjs) and icacls in restrictDataDir(). They have NOT been run on Windows.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');

const WIN = process.platform === 'win32';
const exe = (name) => (WIN ? name + '.exe' : name);
const OWNER_ROLE = 'lims_owner';
const MARK = '# --- B-Pharma LIMS (managed by desktop/pg-supervisor.cjs) ---';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The environment of a PostgreSQL child: nothing inherited that would redirect it (PGOPTIONS, PGTZ, PGHOST ...) or carry a secret. */
function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^PG/i.test(k) && !/^(SQL_|JWT_SECRET|BACKUP_PASSPHRASE|MIGRATION_BACKUP_PASSPHRASE|LIMS_APP_DB_PASSWORD|ADMIN_PASSWORD)/.test(k)) out[k] = v;
  return out;
}

/** The bundled folder in a packaged build (and nothing else); in a development tree LIMS_PG_BIN, else the system's PostgreSQL 16. */
function findBinDir({ isPackaged, resourcesPath, env = process.env }) {
  const has = (d) => !!d && fs.existsSync(path.join(d, exe('postgres'))) && fs.existsSync(path.join(d, exe('initdb')));
  if (isPackaged) { const d = path.join(resourcesPath || '', 'pgsql', 'bin'); return has(d) ? d : null; }
  for (const d of [env.LIMS_PG_BIN, '/usr/lib/postgresql/16/bin']) if (has(d)) return d;
  return null;
}

/** The recorded hashes (PG_BINARIES.json, written by desktop/pg-fetch.cjs) against the files that are installed. */
function verifyBinaries(root) {
  const errors = [];
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(root, 'PG_BINARIES.json'), 'utf8')); } catch (e) { return { ok: false, version: null, errors: ['PG_BINARIES.json is missing or unreadable: ' + e.message] }; }
  for (const [rel, want] of Object.entries(rec.files || {})) {
    try {
      const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
      if (got !== want) errors.push(`${rel}: hash differs from the recorded one`);
    } catch { errors.push(`${rel}: missing`); }
  }
  if (!Object.keys(rec.files || {}).length) errors.push('PG_BINARIES.json lists no files');
  return { ok: errors.length === 0, version: rec.version || null, errors };
}

/** Free space on the disk that holds `dir` (or its nearest existing parent). */
function checkDisk(dir, minBytes) {
  let p = path.resolve(dir);
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  let freeBytes;
  try { const s = fs.statfsSync(p); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { return { ok: true, freeBytes: null, message: '' }; } // cannot tell: do not block
  const ok = freeBytes >= minBytes;
  const mb = (n) => Math.round(n / 1048576).toLocaleString('en-US');
  return { ok, freeBytes, message: ok ? '' : `Not enough free disk space for the database: ${mb(freeBytes)} MB free on the disk of ${p}, at least ${mb(minBytes)} MB are needed.` };
}

function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
}
const run = (file, args, o = {}) => new Promise((resolve) => {
  execFile(file, args, { env: cleanEnv(), windowsHide: true, uid: o.runAs?.uid, gid: o.runAs?.gid, timeout: o.timeout || 120000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') + String(stderr || '') }));
});

/** Windows: only the installing user may read the data folder. Elsewhere the mode 0700 that initdb sets is kept. NOT RUN ON WINDOWS. */
async function restrictDataDir(dir) {
  if (!WIN) { try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ } return; }
  const user = process.env.USERNAME;
  if (!user) throw new Error('Cannot restrict the database folder: USERNAME is not set.');
  const r = await run('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
  if (r.code !== 0) throw new Error('Cannot restrict the database folder to the current user: ' + r.out.trim());
}

/** initdb + the managed settings. Idempotent: an existing cluster is left as it is. */
async function provision({ binDir, dataDir, port, ownerPassword, runAs }) {
  if (fs.existsSync(path.join(dataDir, 'PG_VERSION'))) return { created: false };
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 16) throw new Error('The owner password must be at least 16 characters.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (runAs) fs.chownSync(dataDir, runAs.uid, runAs.gid);
  const pwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-pw-'));
  const pwFile = path.join(pwDir, 'pw');
  try {
    fs.writeFileSync(pwFile, ownerPassword, { mode: 0o600 });
    if (runAs) { fs.chownSync(pwDir, runAs.uid, runAs.gid); fs.chownSync(pwFile, runAs.uid, runAs.gid); }
    const r = await run(path.join(binDir, exe('initdb')), ['-D', dataDir, '-U', OWNER_ROLE, '-A', 'scram-sha-256', '--pwfile', pwFile, '-E', 'UTF8', '--no-locale', '--data-checksums'], { runAs });
    if (r.code !== 0) throw new Error('initdb failed: ' + r.out.trim().split('\n').slice(-6).join(' | '));
  } finally { fs.rmSync(pwDir, { recursive: true, force: true }); }
  // Settings. The port and the listen address are also given on the command line at every start, so a stale file cannot move them.
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), [
    '', MARK,
    "listen_addresses = '127.0.0.1'",
    "unix_socket_directories = ''",
    "timezone = 'UTC'", "log_timezone = 'UTC'",
    "idle_in_transaction_session_timeout = '60s'",
    "password_encryption = 'scram-sha-256'",
    'max_connections = 60',
    "log_line_prefix = '%m [%p] %u@%d '",
    ''].join('\n'));
  await restrictDataDir(dataDir);
  return { created: true };
}

/** psql with the SQL on stdin and the password in the environment of the child. Returns stdout; throws the server's message on error. */
function psql({ binDir, port, user, password, database = 'postgres', sql }) {
  const r = spawnSync(path.join(binDir, exe('psql')), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', database, '-f', '-'],
    { input: sql, encoding: 'utf8', env: { ...cleanEnv(), PGPASSWORD: password, PGCONNECT_TIMEOUT: '15' }, windowsHide: true, timeout: 120000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'psql failed').trim());
  return r.stdout;
}

/** The database, owned by lims_owner, UTC, closed to PUBLIC (lims_app is granted CONNECT by init-db). Idempotent. */
function bootstrapDatabase({ binDir, port, ownerPassword, database }) {
  if (!DB_NAME.test(database)) throw new Error('Invalid database name.');
  const c = { binDir, port, user: OWNER_ROLE, password: ownerPassword };
  const exists = psql({ ...c, sql: `select 1 from pg_database where datname = '${database}'` }).trim() === '1';
  if (!exists) psql({ ...c, sql: `create database "${database}" owner ${OWNER_ROLE} encoding 'UTF8' template template0` });
  psql({ ...c, sql: `alter database "${database}" set timezone to 'UTC'; revoke connect on database "${database}" from public;` });
}

/** Per-role limits of the request role, after init-db created it: statement timeout and a connection ceiling. Idempotent. */
function finalizeAppRole({ binDir, port, ownerPassword, database, role = 'lims_app' }) {
  const c = { binDir, port, user: OWNER_ROLE, password: ownerPassword, database };
  if (psql({ ...c, sql: `select 1 from pg_roles where rolname = '${role}'` }).trim() !== '1') throw new Error(`The database role ${role} does not exist; init-db has not run.`);
  psql({ ...c, sql: `alter role ${role} set statement_timeout = '120s'; alter role ${role} set idle_in_transaction_session_timeout = '60s'; alter role ${role} connection limit 40;` });
}

/**
 * Supervises one postgres. onEvent(type, detail): PG_START, PG_READY, PG_EXIT, PG_RESTART, PG_GIVE_UP, PG_ORPHAN_STOPPED, PG_STOP.
 * start() resolves when the server accepts connections and rejects (clearly) when it cannot start; stop() is idempotent.
 */
function superviseEmbedded({ binDir, dataDir, port, logFile, runAs, onEvent = () => {}, onGiveUp = () => {} }) {
  let child = null, stopping = false, giveUp = false, timer = null, exits = [], startedAt = 0;
  const ctl = (args) => run(path.join(binDir, exe('pg_ctl')), ['-D', dataDir, ...args], { runAs, timeout: 90000 });
  const ready = async () => (await run(path.join(binDir, exe('pg_isready')), ['-h', '127.0.0.1', '-p', String(port), '-t', '2'])).code === 0;
  const pidFile = path.join(dataDir, 'postmaster.pid');

  /** A postmaster that survived a crashed application: stop it cleanly (fast shutdown) so the data directory is free. */
  async function reapOrphan() {
    if (!fs.existsSync(pidFile)) return;
    const st = await ctl(['status']);
    if (st.code === 0) {
      const r = await ctl(['stop', '-m', 'fast', '-w', '-t', '60']);
      onEvent('PG_ORPHAN_STOPPED', { ok: r.code === 0, detail: r.out.trim().slice(0, 200) });
    }
  }
  function spawnOnce() {
    const out = fs.openSync(logFile, 'a', 0o600);
    if (runAs) { try { fs.fchownSync(out, runAs.uid, runAs.gid); } catch { /* best effort */ } }
    const c = spawn(path.join(binDir, exe('postgres')), ['-D', dataDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1'],
      { env: cleanEnv(), stdio: ['ignore', out, out], windowsHide: true, uid: runAs?.uid, gid: runAs?.gid });
    fs.closeSync(out);
    child = c; startedAt = Date.now();
    onEvent('PG_START', { pid: c.pid, port });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopping) return;
      const now = Date.now();
      exits = exits.filter(t => now - t < 120000); exits.push(now);
      onEvent('PG_EXIT', { code, signal, uptimeMs: now - startedAt });
      if (exits.length > 8) { giveUp = true; onEvent('PG_GIVE_UP', { exits: exits.length }); onGiveUp(); return; }
      const delay = Math.min(500 * 2 ** (exits.length - 1), 5000);
      timer = setTimeout(async () => {
        timer = null;
        if (stopping) return;
        try { await reapOrphan(); } catch { /* the next exit retries */ }
        if (stopping) return;
        onEvent('PG_RESTART', { delayMs: delay });
        spawnOnce();
        waitReady(60000).then(() => onEvent('PG_READY', { restarted: true }), () => {});
      }, delay);
    });
    c.on('error', (e) => onEvent('PG_EXIT', { error: e.message }));
  }
  async function waitReady(ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (stopping) throw new Error('stopped');
      if (giveUp) throw new Error('PostgreSQL stopped repeatedly. See ' + logFile);
      if (await ready()) return;
      if (Date.now() > end) throw new Error('PostgreSQL did not become ready. See ' + logFile);
      await sleep(250);
    }
  }
  return {
    port,
    async start() {
      stopping = false; giveUp = false; exits = [];
      await reapOrphan();
      if (!(await portFree(port))) throw new Error(`Port ${port} is already in use by another program, so the built-in database cannot start. Close that program or choose another port.`);
      spawnOnce();
      await waitReady(90000);
      onEvent('PG_READY', { restarted: false });
    },
    /** Marks this supervisor as no longer responsible for the process (it was lost with the application); touches nothing. Tests only. */
    detach() { stopping = true; if (timer) clearTimeout(timer); timer = null; child = null; },
    async stop() {
      stopping = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const c = child;
      if (!c && !fs.existsSync(pidFile)) return;
      const exited = c ? new Promise(r => c.once('exit', r)) : Promise.resolve();
      await ctl(['stop', '-m', 'fast', '-w', '-t', '45']);
      const done = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
      if (!done && c) { try { c.kill('SIGKILL'); } catch { /* gone */ } await Promise.race([exited, sleep(3000)]); }
      child = null;
      onEvent('PG_STOP', {});
    },
  };
}

module.exports = { OWNER_ROLE, cleanEnv, findBinDir, verifyBinaries, checkDisk, portFree, provision, psql, bootstrapDatabase, finalizeAppRole, superviseEmbedded };
