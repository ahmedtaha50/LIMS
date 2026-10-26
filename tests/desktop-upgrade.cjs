// Drives the real Electron shell through the upgrade of a v0.1.0 installation that holds data: the case a user hit when
// the first-run screen had no way to give the pre-migration backup a passphrase.
// Needs a built tree (npm run build), PostgreSQL with a role that may create databases, and a display (xvfb-run -a).
// Usage: xvfb-run -a node tests/desktop-upgrade.cjs      env: SQL_HOST SQL_USER SQL_PASSWORD (defaults 127.0.0.1 lims lims)
const { _electron } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const { execFileSync } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims' };
const DB = `lims_desk_upgrade_${process.pid}`;
const FIX = path.join(__dirname, 'upgrade', 'fixtures');
const pgEnv = { ...process.env, PGPASSWORD: SQL.password };
const psql = (db, sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, db, '-qAtc', sql], { env: pgEnv, encoding: 'utf8' }).trim();
const psqlFile = (db, f) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', f], { env: pgEnv, encoding: 'utf8' });
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 60000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); } }
const launch = (userData) => _electron.launch({
  executablePath: require(path.join(__dirname, '..', 'node_modules', 'electron')),
  args: ['--no-sandbox', '--password-store=basic', `--user-data-dir=${userData}`, path.join(__dirname, '..')],
  env: { ...process.env, LIMS_DEV_PLAINTEXT_SECRETS: '1' },
});
const appWindow = (app) => app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));

(async () => {
  psql('postgres', `drop database if exists ${DB}`); psql('postgres', `create database ${DB}`);
  for (const f of ['v0.1.0.schema.sql', 'v0.1.0.protections.sql', 'v0.1.0.data.sql']) psqlFile(DB, path.join(FIX, f));
  const usersBefore = psql(DB, 'select string_agg(id||email||role, \',\' order by id) from users');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-upgrade-ud-'));
  let app = await launch(userData);
  try {
    const setup = await app.firstWindow();
    await setup.waitForSelector('#go');
    const msg = async () => setup.textContent('#msg');
    const submit = async (bp, bp2) => {
      await setup.click('#mode-external'); // the built-in database is the default (roadmap M40); an upgrade of an existing PostgreSQL
      await setup.fill('#host', SQL.host); await setup.fill('#db', DB); await setup.fill('#user', SQL.user); await setup.fill('#pw', SQL.password);
      await setup.fill('#bp', bp); await setup.fill('#bp2', bp2);
      await setup.click('#go');
      return waitFor(async () => { if (appWindow(app)) return 'opened'; const t = await msg().catch(() => ''); return /Working/.test(t) || !t ? null : t; });
    };

    const r1 = await submit('', '');
    check('upgrade without a backup passphrase is refused with a clear message', /backup passphrase is required/i.test(r1 || ''), r1);
    check('nothing was migrated after the refusal', psql(DB, "select count(*) from information_schema.columns where table_schema='public' and table_name='users' and column_name='login_failed_attempts'") === '0');

    const r2 = await submit('first-passphrase-1', 'other-passphrase-2');
    check('mismatched passphrases are refused in the form', /do not match/i.test(r2 || ''), r2);

    const r3 = await submit('correct horse battery', 'correct horse battery');
    check('upgrade with a passphrase opens the application', r3 === 'opened', r3);
    const backups = fs.existsSync(path.join(userData, 'backups')) ? fs.readdirSync(path.join(userData, 'backups'), { recursive: true }).filter(f => /\.bak/.test(String(f))) : [];
    check('a pre-migration backup was written to the backups folder', backups.length > 0, backups);
    // the server adds its own scheduler principal at start (src/server/jobs/principal.ts); every user that was there stays unchanged
    const kept = usersBefore.split(',').every(u => psql(DB, `select count(*) from users where id||email||role = '${u}'`) === '1');
    check('every existing user kept unchanged (id, e-mail, role)', kept, { usersBefore, all: psql(DB, 'select string_agg(id, \',\') from users') });
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    check('backup passphrase is stored, not in clear text', typeof cfg.backupPassphrase === 'string' && !cfg.backupPassphrase.includes('correct horse'));
    await app.close();

    // second start: no setup window, the stored configuration (with the passphrase) starts the server directly
    app = await launch(userData);
    const w = await waitFor(async () => appWindow(app), 60000);
    check('second start opens the application without the setup screen', !!w);
  } finally {
    await app.close().catch(() => {});
    try { psql('postgres', `drop database if exists ${DB}`); } catch {}
  }
  const failed = results.filter(x => !x).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
