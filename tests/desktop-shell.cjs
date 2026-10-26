// Drives the real Electron shell (desktop/main.cjs) and checks the hardening of roadmap M03:
//   stable port, supervised server, no bridge in the application window, IPC sender check, exact-origin navigation,
//   permission handler, server log on disk.
// Needs a built tree (npm run build), PostgreSQL with a role that may create databases, and a display (xvfb-run -a).
// Usage: xvfb-run -a node tests/desktop-shell.cjs      env: SQL_HOST SQL_USER SQL_PASSWORD (defaults 127.0.0.1 lims lims), PLAYWRIGHT_PATH
const { _electron } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const { execFileSync } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims' };
const DB = `lims_desk_shell_${process.pid}`;
const psql = (db, sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, db, '-qAtc', sql], { env: { ...process.env, PGPASSWORD: SQL.password }, encoding: 'utf8' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`); };

async function launch(userData) {
  return _electron.launch({
    executablePath: require(path.join(__dirname, '..', 'node_modules', 'electron')),
    args: ['--no-sandbox', '--password-store=basic', `--user-data-dir=${userData}`, path.join(__dirname, '..')],
    env: { ...process.env, LIMS_DEV_PLAINTEXT_SECRETS: '1' },
  });
}
async function waitFor(fn, ms = 40000, step = 250) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const appWindow = (app) => app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));
const health = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200; } catch { return false; } };
const serverPid = (logFile) => { const m = [...fs.readFileSync(logFile, 'utf8').matchAll(/"pid":(\d+)[^\n]*"msg":"configuration loaded"/g)]; return m.length ? Number(m[m.length - 1][1]) : null; };

(async () => {
  psql('postgres', `drop database if exists ${DB}`); psql('postgres', `create database ${DB}`);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-shell-ud-'));
  const logFile = path.join(userData, 'logs', 'server.log');
  let app = await launch(userData);
  try {
    // ---- first run: setup window ---------------------------------------------------------------------------------
    const setup = await app.firstWindow();
    await setup.waitForSelector('#go');
    check('setup window has the database bridge', await setup.evaluate(() => typeof window.lims) === 'object');
    check('setup bridge answers from the setup window', await setup.evaluate(() => window.lims.getConfig().then(() => 'ok', e => e.message)) === 'ok');
    // the same bridge, same preload, in a window that shows the wrong page: refused by the sender check
    const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
      await w.loadURL('data:text/html,<p>not the setup page</p>');
      const r = await w.webContents.executeJavaScript(`window.lims.getConfig().then(() => 'allowed', e => 'denied: ' + e.message)`);
      w.destroy(); return r;
    }, path.join(__dirname, '..', 'desktop', 'preload.cjs'));
    check('IPC from another page is refused', /^denied: .*Not allowed/.test(foreign), foreign);

    await setup.click('#mode-external'); // the built-in database is the default (roadmap M40); this test is about an existing PostgreSQL
    await setup.fill('#host', SQL.host); await setup.fill('#db', DB); await setup.fill('#user', SQL.user); await setup.fill('#pw', SQL.password); await setup.fill('#bp', 'shell-test-backup-passphrase'); await setup.fill('#bp2', 'shell-test-backup-passphrase');
    await setup.fill('#an', 'Shell Test'); await setup.fill('#ae', 'shell@example.invalid'); await setup.fill('#ap', 'shell-test-password-1');
    await setup.click('#go');
    const page = await waitFor(() => appWindow(app), 60000);
    if (!page) throw new Error('application window never opened; setup says: ' + await setup.textContent('#msg').catch(() => '?'));
    await page.waitForLoadState('domcontentloaded');
    const origin = new URL(page.url()).origin; const port = Number(new URL(origin).port);

    // ---- application window ---------------------------------------------------------------------------------------
    check('application window has no bridge', await page.evaluate(() => typeof window.lims) === 'undefined');
    check('renderer is sandboxed', await page.evaluate(() => typeof require + '/' + typeof process) === 'undefined/undefined');
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    check('port chosen once and stored', cfg.port === port && port >= 20000 && port < 30000, { cfgPort: cfg.port, port });
    check('server answers /api/ready', (await fetch(`${origin}/api/ready`)).status === 200);

    // exact-origin navigation: this URL starts with the origin string but its host is 127.0.0.2
    const tricky = `${origin.replace('http://', 'http://')}@127.0.0.2:9/`;
    await page.evaluate((u) => { location.href = u; }, tricky).catch(() => {});
    await sleep(1500);
    check('navigation to a look-alike origin is blocked', page.url().startsWith(origin + '/') || page.url() === origin + '/', page.url());
    await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
    await sleep(1000);
    check('navigation to another site is blocked', page.url().startsWith(origin), page.url());

    // permissions: microphone/camera may be asked for, nothing else is granted
    const perms = await page.evaluate(async () => {
      const geo = await new Promise(res => navigator.geolocation.getCurrentPosition(() => res('granted'), e => res('denied:' + e.code)));
      const note = await Notification.requestPermission();
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', e => e.name);
      return { geo, note, media };
    });
    check('geolocation is denied', perms.geo === 'denied:1', perms);
    check('notifications are denied', perms.note === 'denied', perms);
    check('microphone request is not blocked by policy (no device here, so NotFoundError)', perms.media !== 'NotAllowedError', perms);

    // ---- supervision ----------------------------------------------------------------------------------------------
    check('server log is written under the user-data folder', fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('configuration loaded'));
    const before = serverPid(logFile);
    process.kill(before, 'SIGKILL');
    const killedAt = Date.now();
    await waitFor(async () => !(await health(port)), 5000, 50);
    const back = await waitFor(() => health(port), 10000, 100);
    check('killed server is back within 10 seconds', back && Date.now() - killedAt < 10000, Date.now() - killedAt);
    const log = fs.readFileSync(logFile, 'utf8');
    check('restart is logged as SERVER_RESTART', /"event":"SERVER_RESTART"[^\n]*"signal":"SIGKILL"/.test(log));
    await waitFor(() => serverPid(logFile) !== before, 5000);
    check('the new server process has another pid and the same port', serverPid(logFile) !== before && await health(port));

    // ---- second run: same origin ----------------------------------------------------------------------------------
    await app.close();
    app = await launch(userData);
    const page2 = await waitFor(() => appWindow(app), 60000);
    check('second start uses the same origin', page2 && new URL(page2.url()).origin === origin, page2 && page2.url());
  } catch (e) {
    check('no unexpected error', false, e.stack || String(e));
  } finally {
    await app.close().catch(() => {});
    try { psql('postgres', `drop database if exists ${DB} with (force)`); } catch {}
    fs.rmSync(userData, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
