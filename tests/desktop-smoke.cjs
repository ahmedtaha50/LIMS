// Drives the real Electron app: first-run setup form -> server start -> login page loads on 127.0.0.1.
// Usage: xvfb-run -a node tests/desktop-smoke.cjs   (env: SQL_PASSWORD, optional LIMS_USER/DB/HOST)
const { _electron } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const path = require('path'), os = require('os'), fs = require('fs');
(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-ud-'));
  const app = await _electron.launch({
    executablePath: require(path.join(__dirname, '..', 'node_modules', 'electron')),
    args: ['--no-sandbox', '--password-store=basic', `--user-data-dir=${userData}`, path.join(__dirname, '..')],
  });
  app.process().stdout.on('data', d => process.stderr.write('[main] ' + d)); app.process().stderr.on('data', d => process.stderr.write('[main!] ' + d));
  const setup = await app.firstWindow();
  await setup.waitForSelector('#go');
  await setup.click('#mode-external');
  await setup.fill('#host', process.env.LIMS_HOST || '127.0.0.1');
  await setup.fill('#db', process.env.LIMS_DB || 'lims_desk');
  await setup.fill('#user', process.env.LIMS_USER || 'lims');
  await setup.fill('#pw', process.env.SQL_PASSWORD || 'lims');
  await setup.fill('#bp', 'smoke-backup-passphrase'); await setup.fill('#bp2', 'smoke-backup-passphrase');
  await setup.click('#go');
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    await new Promise(r => setTimeout(r, 500));
    page = app.windows().find(w => w.url().startsWith('http://127.0.0.1'));
  }
  if (!page) throw new Error('main window never loaded the local server; setup says: ' + JSON.stringify(app.windows().map(w=>w.url())) + ' ' + (await setup.textContent('#msg').catch(()=>'?')));
  await page.waitForLoadState('domcontentloaded');
  const title = await page.title(), url = page.url();
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  const exposed = await page.evaluate(() => typeof require + '/' + typeof process);
  console.log(JSON.stringify({ url, title, passwordStoredEncrypted: cfg.password !== (process.env.SQL_PASSWORD || 'lims'), rendererSandboxed: exposed === 'undefined/undefined' }));
  const ok = url.startsWith('http://127.0.0.1:') && cfg.password !== (process.env.SQL_PASSWORD || 'lims') && exposed === 'undefined/undefined';
  await app.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
