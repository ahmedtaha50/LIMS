// Drives the real Electron shell against a copy of the application folder with a release manifest (roadmap M36):
//   untouched   -> starts (setup window), writes SERVER_START with the integrity result
//   one byte changed in dist-server/server.cjs -> does not start, writes SYSTEM_INTEGRITY_FAIL naming the file, no window opens
// Needs a display (xvfb-run -a) and playwright:   xvfb-run -a node tests/installer/desktop-integrity.cjs
const { _electron } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const path = require('path'), os = require('os'), fs = require('fs');
const { execFileSync } = require('child_process');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

const repo = path.resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`); };
const events = (ud) => { try { return fs.readFileSync(path.join(ud, 'logs', 'release-events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

function makeApp() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-integ-app-'));
  fs.cpSync(path.join(repo, 'desktop'), path.join(app, 'desktop'), { recursive: true });
  fs.cpSync(path.join(repo, 'scripts', 'release'), path.join(app, 'scripts', 'release'), { recursive: true });
  fs.mkdirSync(path.join(app, 'dist-server'), { recursive: true }); fs.writeFileSync(path.join(app, 'dist-server', 'server.cjs'), '// server\n');
  fs.mkdirSync(path.join(app, 'drizzle')); fs.writeFileSync(path.join(app, 'drizzle', '0010_a.sql'), 'select 1;');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'bpharma-lims', version: '7.7.7', main: 'desktop/main.cjs' }));
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'make-release-manifest.cjs'), '--root', app, '--git-sha', 'deadbeefcafe'], { stdio: 'pipe' });
  return app;
}
const launch = (app, ud) => _electron.launch({
  executablePath: require(path.join(repo, 'node_modules', 'electron')),
  args: ['--no-sandbox', '--password-store=basic', `--user-data-dir=${ud}`, app],
  env: { ...process.env, LIMS_DEV_PLAINTEXT_SECRETS: '1', LIMS_INTEGRITY_NO_DIALOG: '1' },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. untouched
  let app = makeApp(), ud = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-integ-ud-'));
  let e = await launch(app, ud);
  const w = await e.firstWindow();
  check('an untouched installation opens its first window', /setup/.test(w.url()), w.url());
  const ev = events(ud);
  check('SERVER_START is recorded with version, git sha and integrity', ev.some(x => x.type === 'SERVER_START' && x.version === '7.7.7' && x.gitSha === 'deadbeefcafe' && x.integrity === 'ok-unsigned'), ev);
  await e.close();

  // 2. one byte changed
  app = makeApp(); ud = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-integ-ud-'));
  fs.appendFileSync(path.join(app, 'dist-server', 'server.cjs'), ' ');
  let opened = false, exited = false;
  try {
    e = await launch(app, ud);
    e.process().on('exit', () => { exited = true; });
    for (let i = 0; i < 40 && !exited; i++) { await sleep(250); if (e.windows().length) opened = true; }
  } catch (err) { exited = true; }
  const bad = events(ud);
  check('a changed byte stops the start: the application quits and opens no window', exited && !opened, { exited, opened });
  const fail = bad.find(x => x.type === 'SYSTEM_INTEGRITY_FAIL');
  check('SYSTEM_INTEGRITY_FAIL names dist-server/server.cjs', fail && fail.files.some(f => f.file === 'dist-server/server.cjs' && f.kind === 'changed'), bad);
  check('no SERVER_START is written for the refused start', !bad.some(x => x.type === 'SERVER_START'), bad);
  try { await e.close(); } catch { /* already gone */ }

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
