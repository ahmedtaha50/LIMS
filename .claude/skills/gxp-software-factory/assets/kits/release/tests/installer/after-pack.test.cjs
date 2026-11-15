// The release manifest must describe the files that are INSTALLED, not the files that were built.
// Regression for the first packaged build (v0.2.0-build.1): the installer shipped without release-manifest.json (build.yml never
// wrote one) and, once a manifest was staged, electron-builder rewrote package.json inside the package, so its hash no longer
// matched and the application refused to start ("The installed files do not match the release manifest").
// scripts/release/after-pack.cjs (electron-builder afterPack hook) writes the manifest from the packaged tree.
// Plain node:test, no database, independent of file modes, the user and localhost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const lib = require(path.join(repo, 'scripts', 'release', 'manifest-lib.cjs'));
const makeManifest = path.join(repo, 'scripts', 'make-release-manifest.cjs');
const afterPack = require(path.join(repo, 'scripts', 'release', 'after-pack.cjs'));

function tree(root, version = '9.9.9') {
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  put('package.json', JSON.stringify({ name: 'bpharma-lims', version, devDependencies: { vite: '1' }, scripts: { build: 'x' } }, null, 2));
  put('dist/index.html', '<html>app</html>');
  put('dist-server/server.cjs', 'console.log("server")');
  put('desktop/main.cjs', '// main');
  put('drizzle/0010_a.sql', 'select 1;');
  put('scripts/release/manifest-lib.cjs', '// lib');
  return put;
}
/** What electron-builder does to the application folder: copies the files, and writes its own, smaller package.json. */
function packaged(source, platform = 'linux') {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-pack-'));
  const sub = platform === 'darwin' ? path.join('Product.app', 'Contents', 'Resources', 'app') : path.join('resources', 'app');
  const app = path.join(out, sub);
  fs.cpSync(source, app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'bpharma-lims', version: '9.9.9', main: 'desktop/main.cjs' }));
  return { out, app, context: { appOutDir: out, electronPlatformName: platform, packager: { appInfo: { productFilename: 'Product' } } } };
}

test('a manifest staged from the source tree does not match the packaged application (the bug)', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  execFileSync(process.execPath, [makeManifest, '--root', src, '--git-sha', 'abc']);
  const { app } = packaged(src);
  const r = lib.verifyInstall({ root: app, requireManifest: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => `${e.file}:${e.kind}`), ['package.json:changed']);
});

test('a package without any manifest is refused (what build.yml produced)', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  const { app } = packaged(src);
  const r = lib.verifyInstall({ root: app, requireManifest: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].kind, 'manifest');
});

test('afterPack writes the manifest from the packaged files, so the application starts', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  const { app, context } = packaged(src);
  await afterPack.default(context);
  const r = lib.verifyInstall({ root: app, requireManifest: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok-unsigned');
  const m = JSON.parse(fs.readFileSync(path.join(app, 'release-manifest.json'), 'utf8'));
  assert.equal(m.version, '9.9.9');
  assert.equal(m.files['package.json'], crypto.createHash('sha256').update(fs.readFileSync(path.join(app, 'package.json'))).digest('hex'));
});

test('afterPack replaces a manifest that was staged earlier (release.yml stages one before packaging)', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  execFileSync(process.execPath, [makeManifest, '--root', src, '--git-sha', 'abc']);
  const { app, context } = packaged(src);
  await afterPack.default(context);
  assert.equal(lib.verifyInstall({ root: app, requireManifest: true }).ok, true);
});

test('after packaging, any changed, missing or extra file is still detected', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  const { app, context } = packaged(src);
  await afterPack.default(context);
  fs.appendFileSync(path.join(app, 'dist-server', 'server.cjs'), '\n//x');
  fs.rmSync(path.join(app, 'drizzle', '0010_a.sql'));
  fs.writeFileSync(path.join(app, 'dist', 'extra.js'), '1');
  const r = lib.verifyInstall({ root: app, requireManifest: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => `${e.file}:${e.kind}`).sort(), ['dist-server/server.cjs:changed', 'dist/extra.js:unexpected', 'drizzle/0010_a.sql:missing']);
});

test('afterPack signs the manifest when RELEASE_SIGNING_KEY is set, and the signature is checked', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  const { app, context } = packaged(src);
  const before = process.env.RELEASE_SIGNING_KEY; process.env.RELEASE_SIGNING_KEY = privateKey;
  try { await afterPack.default(context); } finally { if (before === undefined) delete process.env.RELEASE_SIGNING_KEY; else process.env.RELEASE_SIGNING_KEY = before; }
  const ok = lib.verifyInstall({ root: app, requireManifest: true, publicKeyPem: publicKey });
  assert.equal(ok.ok, true); assert.equal(ok.signed, true);
  const other = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  assert.equal(lib.verifyInstall({ root: app, requireManifest: true, publicKeyPem: other.publicKey }).ok, false);
});

test('on macOS the application folder is inside the .app bundle', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-src-')); tree(src);
  const { app, context } = packaged(src, 'darwin');
  await afterPack.default(context);
  assert.equal(lib.verifyInstall({ root: app, requireManifest: true }).ok, true);
});

test('afterPack fails loudly when the application folder is not where it expects it', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-pack-'));
  await assert.rejects(() => afterPack.default({ appOutDir: out, electronPlatformName: 'win32', packager: { appInfo: { productFilename: 'Product' } } }), /application folder/);
});

test('package.json registers the hook', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.build.afterPack, 'scripts/release/after-pack.cjs');
});
