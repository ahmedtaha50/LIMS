// Starts the server bundle of an application folder and waits for /api/ready (roadmap M36, DEV-06). Used by the Windows job
// (tests/installer/silent-install.ps1) after a silent install, and runnable on Linux against the build tree:
//   node tests/installer/boot-check.cjs <app-folder> [--port 3199] [--timeout 60]
// env: SQL_HOST SQL_USER SQL_PASSWORD SQL_DB_NAME (an existing, empty database; the installer's own init-db creates the schema).
// It checks the integrity manifest, runs dist-server/init-db.cjs, starts dist-server/server.cjs on 127.0.0.1, fails if /api/ready
// has not answered 200 within the timeout, then stops the server.
const { spawn, spawnSync } = require('child_process');
const http = require('http'), path = require('path'), fs = require('fs');
const a = process.argv.slice(2);
const opt = (n, d) => { const i = a.indexOf(n); return i > -1 ? a[i + 1] : d; };
const root = path.resolve(a[0] || '.');
const port = Number(opt('--port', 3199)), timeoutS = Number(opt('--timeout', 60));
// The Electron binary runs the bundles as Node when asked; a plain node does the same on Linux.
const node = opt('--node', process.env.LIMS_NODE || process.execPath);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DIST_DIR: path.join(root, 'dist'),
  JWT_SECRET: process.env.JWT_SECRET || 'boot-check-only-secret-0123456789abcdef', BACKUP_PASSPHRASE: process.env.BACKUP_PASSPHRASE || 'boot-check-passphrase-1',
  SCHEMA_FILE: path.join(root, 'desktop', 'schema.sql'), ADMIN_EMAIL: 'bootcheck@example.invalid', ADMIN_NAME: 'Boot Check', ADMIN_PASSWORD: 'boot-check-password-123' };
const fail = (m) => { console.error('FAIL ' + m); process.exit(1); };

if (!fs.existsSync(path.join(root, 'release-manifest.json'))) fail('no release-manifest.json in ' + root);
const v = spawnSync(process.execPath, [path.join(root, 'scripts', 'release', 'verify.cjs'), root], { encoding: 'utf8' });
process.stdout.write(v.stdout); process.stderr.write(v.stderr);
if (v.status !== 0) fail('integrity check');
const init = spawnSync(node, [path.join(root, 'dist-server', 'init-db.cjs')], { env, cwd: root, encoding: 'utf8' });
if (init.status !== 0) fail('init-db: ' + (init.stdout + init.stderr).slice(-800));
console.log('PASS schema created by the installed init-db');

const server = spawn(node, [path.join(root, 'dist-server', 'server.cjs')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
let exited = false; server.on('exit', () => { exited = true; });
const ready = () => new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/api/ready', timeout: 2000 }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)).on('timeout', function () { this.destroy(); }));
(async () => {
  const end = Date.now() + timeoutS * 1000;
  let ok = false;
  while (Date.now() < end && !exited) { if (await ready()) { ok = true; break; } await new Promise(r => setTimeout(r, 500)); }
  server.kill();
  if (!ok) { console.error(log.slice(-1500)); fail(`/api/ready did not answer 200 within ${timeoutS} s${exited ? ' (the server exited)' : ''}`); }
  console.log(`PASS /api/ready answered 200 within ${timeoutS} s`);
  process.exit(0);
})();
