// Drives the real Electron shell in "Built-in database" mode (roadmap M40): the shell initialises, starts, supervises and stops its own
// PostgreSQL; the application runs as the unprivileged lims_app, the installer step as lims_owner.
// Needs a built tree (npm run build), the PostgreSQL 16 server binaries (LIMS_PG_BIN or /usr/lib/postgresql/16/bin; the data folder is
// the shell's own, nothing in the machine's PostgreSQL is touched) and a display (xvfb-run -a). As root the embedded server runs as "postgres".
// Windows (bundled binaries, DPAPI, icacls) is NOT covered by this test.
// Usage: xvfb-run -a node tests/desktop-embedded.cjs      env: PLAYWRIGHT_PATH, LIMS_PG_BIN
const { _electron } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const BIN = [process.env.LIMS_PG_BIN, '/usr/lib/postgresql/16/bin'].find(d => d && fs.existsSync(path.join(d, 'initdb')));
if (!BIN) { console.log('SKIP no PostgreSQL 16 server binaries (set LIMS_PG_BIN)'); process.exit(0); }
const runAs = process.getuid && process.getuid() === 0 ? `${execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim()}:${execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim()}` : '';
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 60000, step = 250) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const launch = (userData, extra = {}) => _electron.launch({
  executablePath: require(path.join(__dirname, '..', 'node_modules', 'electron')),
  args: ['--no-sandbox', '--password-store=basic', `--user-data-dir=${userData}`, path.join(__dirname, '..')],
  env: { ...process.env, LIMS_DEV_PLAINTEXT_SECRETS: '1', LIMS_PG_BIN: BIN, LIMS_PG_RUN_AS: runAs, ...extra },
});
const appWindow = (app) => app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));
const ready = async (origin) => { try { return (await fetch(origin + '/api/ready')).status === 200; } catch { return false; } };
const psql = (port, user, password, db, sql) => spawnSync(path.join(BIN, 'psql'), ['-X', '-A', '-t', '-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db, '-c', sql],
  { env: { PATH: process.env.PATH, PGPASSWORD: password }, encoding: 'utf8' });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-embedded-ud-'));
  fs.chmodSync(userData, 0o755); // the embedded server runs as another account in the sandbox and must reach pgdata
  let app = null;
  const fill = async (setup) => {
    await setup.fill('#bp', 'embedded-test-backup-passphrase'); await setup.fill('#bp2', 'embedded-test-backup-passphrase');
    await setup.fill('#an', 'Embedded Test'); await setup.fill('#ae', 'embedded@example.invalid'); await setup.fill('#ap', 'embedded-test-password-1');
  };
  try {
    // ---- the free-disk guard stops a first run that cannot fit --------------------------------------------------
    app = await launch(userData, { LIMS_PG_MIN_FREE_MB: '999999999' });
    let setup = await app.firstWindow();
    await setup.waitForSelector('#go');
    check('the built-in database is the default choice, "existing PostgreSQL" is an option', await setup.isChecked('#mode-builtin') && await setup.locator('#mode-external').count() === 1);
    check('no database fields are asked for in built-in mode', !(await setup.isVisible('#host')) && !(await setup.isVisible('#pw')));
    await fill(setup); await setup.click('#go');
    const refused = await waitFor(async () => { const t = await setup.textContent('#msg').catch(() => ''); return /disk space/i.test(t) ? t : null; }, 30000);
    check('not enough free disk space is refused with a clear message', !!refused, refused);
    check('nothing was created after the refusal', !fs.existsSync(path.join(userData, 'pgdata')) && !fs.existsSync(path.join(userData, 'config.json')));
    await app.close();

    // ---- first run: no database input at all ----------------------------------------------------------------------
    app = await launch(userData);
    setup = await app.firstWindow();
    await setup.waitForSelector('#go');
    await fill(setup); await setup.click('#go');
    const page = await waitFor(() => appWindow(app), 120000);
    if (!page) throw new Error('application window never opened; setup says: ' + await setup.textContent('#msg').catch(() => '?'));
    const origin = new URL(page.url()).origin;
    check('server answers /api/ready', await ready(origin));

    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    check('config records the built-in mode and a port other than 5432', cfg.mode === 'embedded' && cfg.pgPort >= 20000 && cfg.pgPort < 30000 && cfg.pgPort !== 5432, cfg);
    const raw = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
    const dec = (s) => app.evaluate(({ safeStorage }, e) => safeStorage.decryptString(Buffer.from(e, 'base64')), s);
    const ownerPw = await dec(cfg.ownerPassword), appPw = await dec(cfg.appPassword);
    check('owner and app passwords are random, different, and not in the config in clear', ownerPw.length >= 32 && appPw.length >= 32 && ownerPw !== appPw && !raw.includes(ownerPw) && !raw.includes(appPw));
    const pgdata = path.join(userData, 'pgdata');
    check('data lives in the user data folder', fs.existsSync(path.join(pgdata, 'PG_VERSION')));

    const p = cfg.pgPort;
    check('timezone is UTC', psql(p, 'lims_owner', ownerPw, 'lims', 'show timezone').stdout.trim() === 'UTC');
    check('the application runs as lims_app (it holds connections)', psql(p, 'lims_owner', ownerPw, 'lims', "select count(*) from pg_stat_activity where usename='lims_app'").stdout.trim() > 0);
    check('lims_app cannot create tables', /permission denied/.test(psql(p, 'lims_app', appPw, 'lims', 'create table nope(a int)').stderr));
    check('lims_app cannot change the audit trail', /permission denied/.test(psql(p, 'lims_app', appPw, 'lims', "update audit_trail set action='x'").stderr)
      && /permission denied/.test(psql(p, 'lims_app', appPw, 'lims', 'delete from audit_trail').stderr));
    check('lims_app is not a superuser and has a statement timeout', psql(p, 'lims_owner', ownerPw, 'lims', "select rolsuper::text||(select count(*) from pg_db_role_setting s where s.setrole=r.oid and array_to_string(s.setconfig,',') like '%statement_timeout%') from pg_roles r where rolname='lims_app'").stdout.trim() === 'false1');
    check('lims_owner is a different login from lims_app', psql(p, 'lims_owner', ownerPw, 'lims', 'select current_user').stdout.trim() === 'lims_owner');
    check('the first administrator exists', psql(p, 'lims_owner', ownerPw, 'lims', "select count(*) from users where email='embedded@example.invalid'").stdout.trim() === '1');
    check('the running server wrote through lims_app (its service principal exists)', psql(p, 'lims_owner', ownerPw, 'lims', "select count(*) from users where role='Service'").stdout.trim() === '1');
    // backup and restore need the owner's rights: the server takes them from the owner pool while requests run as lims_app
    const login = await (await fetch(origin + '/api/auth/login-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'embedded@example.invalid', password: 'embedded-test-password-1' }) })).json().catch(() => ({}));
    if (login.token) {
      const bk = await fetch(origin + '/api/admin/backup', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + login.token }, body: JSON.stringify({ password: 'embedded-test-password-1', passphrase: 'embedded-test-backup-passphrase' }) });
      const body = await bk.json().catch(() => ({}));
      check('a backup taken by the running server (as lims_app + owner pool) verifies', bk.status === 200 && body.verified === true, { status: bk.status, body });
    } else check('administrator can sign in for the backup check', false, login);
    check('a wrong password is refused', /password authentication failed/.test(psql(p, 'lims_app', 'wrong', 'lims', 'select 1').stderr));

    // ---- a killed postgres comes back within 15 s with its data ------------------------------------------------------
    psql(p, 'lims_owner', ownerPw, 'lims', 'create table m40_keep(a int); insert into m40_keep values (1),(2)');
    const pid = Number(fs.readFileSync(path.join(pgdata, 'postmaster.pid'), 'utf8').split('\n')[0]);
    const t0 = Date.now();
    process.kill(pid, 'SIGKILL');
    const back = await waitFor(() => psql(p, 'lims_owner', ownerPw, 'lims', 'select count(*) from m40_keep').stdout.trim() === '2', 15000, 300);
    check('after kill -9 the database is back within 15 s with its data', !!back, Date.now() - t0);
    check('and the application server still answers', await waitFor(() => ready(origin), 15000));

    // ---- quitting stops postgres --------------------------------------------------------------------------------------
    const pid2 = Number(fs.readFileSync(path.join(pgdata, 'postmaster.pid'), 'utf8').split('\n')[0]);
    await app.close();
    const gone = await waitFor(() => !alive(pid2) && !fs.existsSync(path.join(pgdata, 'postmaster.pid')), 20000);
    check('quitting leaves no postgres process', !!gone, { pid2, pidFile: fs.existsSync(path.join(pgdata, 'postmaster.pid')) });

    // ---- second start: no setup, same data ----------------------------------------------------------------------------
    app = await launch(userData);
    const w2 = await waitFor(() => appWindow(app), 90000);
    check('second start opens the application without the setup screen', !!w2);
    check('the data survived the restart', psql(p, 'lims_owner', ownerPw, 'lims', 'select count(*) from m40_keep').stdout.trim() === '2');
    check('the same port is used again', JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).pgPort === p);
    await app.close(); app = null;
  } finally {
    if (app) await app.close().catch(() => {});
    try { const pf = path.join(userData, 'pgdata', 'postmaster.pid'); if (fs.existsSync(pf)) process.kill(Number(fs.readFileSync(pf, 'utf8').split('\n')[0]), 'SIGTERM'); } catch {}
  }
  const failed = results.filter(x => !x).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
