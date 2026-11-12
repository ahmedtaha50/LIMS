// Release manifest, start-up integrity check, SBOM and update-package verification (roadmap M36).
// Plain node:test, no database:  node --test tests/installer/    (npm run test:installer)
// Independent of file modes, the user running it and the DNS name of localhost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const lib = require(path.join(repo, 'scripts', 'release', 'manifest-lib.cjs'));
const makeManifest = path.join(repo, 'scripts', 'make-release-manifest.cjs');

/** A small application tree shaped like the packaged one. */
function fakeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-rel-'));
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  put('package.json', JSON.stringify({ name: 'bpharma-lims', version: '9.9.9' }));
  put('dist/index.html', '<html>app</html>');
  put('dist/assets/app.js', 'console.log(1)');
  put('dist-server/server.cjs', 'console.log("server")');
  put('dist-server/init-db.cjs', 'console.log("init")');
  put('desktop/main.cjs', '// main');
  put('drizzle/0010_a.sql', 'select 1;');
  put('drizzle/0290_b.sql', 'select 2;');
  return { root, put };
}
const run = (args, env = {}) => execFileSync(process.execPath, [makeManifest, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
const keys = () => crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

test('the manifest lists every file under the covered folders with its hash, the version, the git sha and the schema version', () => {
  const { root } = fakeApp();
  run(['--root', root, '--git-sha', 'abc1234']);
  const m = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
  assert.equal(m.version, '9.9.9');
  assert.equal(m.gitSha, 'abc1234');
  assert.equal(m.schemaVersion, '0290_b');
  assert.deepEqual(Object.keys(m.files).sort(), ['desktop/main.cjs', 'dist-server/init-db.cjs', 'dist-server/server.cjs', 'dist/assets/app.js', 'dist/index.html', 'drizzle/0010_a.sql', 'drizzle/0290_b.sql', 'package.json']);
  assert.equal(m.files['dist-server/server.cjs'], crypto.createHash('sha256').update('console.log("server")').digest('hex'));
});

test('an untouched installation verifies; one changed byte in dist-server/server.cjs is refused and the file is named', () => {
  const { root } = fakeApp();
  run(['--root', root, '--git-sha', 'abc1234']);
  const ok = lib.verifyInstall({ root, requireManifest: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.signed, false);
  assert.equal(ok.gitSha, 'abc1234');
  fs.writeFileSync(path.join(root, 'dist-server', 'server.cjs'), 'console.log("server!")'); // one byte more
  const bad = lib.verifyInstall({ root, requireManifest: true });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [{ file: 'dist-server/server.cjs', kind: 'changed' }]);
});

test('a missing file and a file added to a covered folder are both refused', () => {
  const { root, put } = fakeApp();
  run(['--root', root, '--git-sha', 'abc1234']);
  fs.rmSync(path.join(root, 'dist', 'assets', 'app.js'));
  put('dist/assets/evil.js', 'x');
  const r = lib.verifyInstall({ root, requireManifest: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => `${e.kind}:${e.file}`).sort(), ['missing:dist/assets/app.js', 'unexpected:dist/assets/evil.js']);
});

test('a packaged build without a manifest is refused; an unpackaged tree may run without one', () => {
  const { root } = fakeApp();
  const strict = lib.verifyInstall({ root, requireManifest: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.errors[0].kind, 'manifest');
  const dev = lib.verifyInstall({ root, requireManifest: false });
  assert.equal(dev.ok, true);
  assert.equal(dev.status, 'no-manifest');
});

test('signed manifest: verifies with the public key; a changed manifest, a wrong key or a stripped signature is refused', () => {
  const { root } = fakeApp();
  const a = keys(), b = keys();
  run(['--root', root, '--git-sha', 'abc1234'], { RELEASE_SIGNING_KEY: a.privateKey });
  assert.equal(lib.verifyInstall({ root, requireManifest: true, publicKeyPem: a.publicKey }).ok, true);
  assert.equal(lib.verifyInstall({ root, requireManifest: true, publicKeyPem: a.publicKey }).signed, true);
  assert.equal(lib.verifyInstall({ root, requireManifest: true, publicKeyPem: b.publicKey }).ok, false);

  // the attacker changes server.cjs AND rewrites its hash in the manifest
  const mp = path.join(root, 'release-manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  fs.writeFileSync(path.join(root, 'dist-server', 'server.cjs'), 'evil');
  m.files['dist-server/server.cjs'] = crypto.createHash('sha256').update('evil').digest('hex');
  fs.writeFileSync(mp, JSON.stringify(m));
  const forged = lib.verifyInstall({ root, requireManifest: true, publicKeyPem: a.publicKey });
  assert.equal(forged.ok, false);
  assert.equal(forged.errors[0].kind, 'signature');

  // and strips the signature: with a public key configured an unsigned manifest is not accepted
  delete m.signature;
  fs.writeFileSync(mp, JSON.stringify(m));
  assert.equal(lib.verifyInstall({ root, requireManifest: true, publicKeyPem: a.publicKey }).ok, false);
});

test('the installer is added to the published manifest with its size and hash, and an update package is checked against it', () => {
  const { root } = fakeApp();
  const k = keys();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-rel-out-'));
  const exe = path.join(out, 'B-Pharma-LIMS-Setup-9.9.9.exe');
  fs.writeFileSync(exe, 'installer bytes');
  run(['--root', root, '--git-sha', 'abc1234', '--installer', exe, '--out', path.join(out, 'release-manifest.json')], { RELEASE_SIGNING_KEY: k.privateKey });
  const pkg = lib.checkUpdatePackage({ installerPath: exe, manifestPath: path.join(out, 'release-manifest.json'), publicKeyPem: k.publicKey, currentVersion: '9.9.8', currentSchemaVersion: '0280_tat' });
  assert.equal(pkg.ok, true, JSON.stringify(pkg));
  assert.equal(pkg.version, '9.9.9');
  fs.appendFileSync(exe, 'x');
  assert.equal(lib.checkUpdatePackage({ installerPath: exe, manifestPath: path.join(out, 'release-manifest.json'), publicKeyPem: k.publicKey, currentVersion: '9.9.8' }).ok, false);
  fs.writeFileSync(exe, 'installer bytes');
  const same = lib.checkUpdatePackage({ installerPath: exe, manifestPath: path.join(out, 'release-manifest.json'), publicKeyPem: k.publicKey, currentVersion: '9.9.9' });
  assert.equal(same.ok, false, 'an update must be newer than the installed version');
  const noKey = lib.checkUpdatePackage({ installerPath: exe, manifestPath: path.join(out, 'release-manifest.json'), currentVersion: '9.9.8', requireSignature: true });
  assert.equal(noKey.ok, false, 'a signature is required for an update when no key is configured is refused, not skipped');
});

test('the SBOM is CycloneDX 1.5 with one component per locked package, a purl and the lock file hash', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-sbom-'));
  const lock = path.join(out, 'package-lock.json');
  fs.writeFileSync(lock, JSON.stringify({ name: 'x', version: '1.2.3', lockfileVersion: 3, packages: {
    '': { name: 'x', version: '1.2.3' },
    'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'), license: 'MIT', dev: true },
    'node_modules/@scope/pkg': { version: '2.0.0', license: 'ISC' },
    'node_modules/a/node_modules/left-pad': { version: '0.0.1' },
  } }));
  const sbomFile = path.join(out, 'sbom.json');
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'release', 'make-sbom.cjs'), '--lock', lock, '--out', sbomFile, '--git-sha', 'abc1234']);
  const s = JSON.parse(fs.readFileSync(sbomFile, 'utf8'));
  assert.equal(s.bomFormat, 'CycloneDX');
  assert.equal(s.specVersion, '1.5');
  assert.equal(s.metadata.component.version, '1.2.3');
  assert.deepEqual(s.components.map(c => c.purl).sort(), ['pkg:npm/%40scope/pkg@2.0.0', 'pkg:npm/left-pad@0.0.1', 'pkg:npm/left-pad@1.3.0']);
  const lp = s.components.find(c => c.version === '1.3.0');
  assert.equal(lp.hashes[0].alg, 'SHA-512');
  assert.equal(lp.hashes[0].content, '01'.repeat(64));
  assert.equal(lp.licenses[0].license.id, 'MIT');
});

test('the audit gate fails on an unwaived high advisory, passes with a current waiver and rejects an expired waiver', () => {
  const g = require(path.join(repo, 'scripts', 'release', 'audit-gate.cjs'));
  const report = { vulnerabilities: { xlsx: { name: 'xlsx', severity: 'high', via: [{ source: 1096, name: 'xlsx', severity: 'high', url: 'https://github.com/advisories/GHSA-4r6h-8v6p-xvw6' }] }, tiny: { name: 'tiny', severity: 'low', via: [{ source: 5, name: 'tiny', severity: 'low', url: 'u' }] } } };
  const now = new Date('2026-10-25T00:00:00Z');
  assert.equal(g.evaluate(report, [], now).ok, false);
  const ok = g.evaluate(report, [{ id: 'GHSA-4r6h-8v6p-xvw6', reason: 'r', expires: '2027-01-01', approvedBy: 'QA' }], now);
  assert.equal(ok.ok, true);
  assert.equal(g.evaluate(report, [{ id: 'GHSA-4r6h-8v6p-xvw6', reason: 'r', expires: '2026-01-01', approvedBy: 'QA' }], now).ok, false);
  assert.equal(g.evaluate(report, [{ id: 'GHSA-4r6h-8v6p-xvw6', reason: 'r', expires: '2027-01-01' }], now).ok, false, 'a waiver without an approver is not valid');
});
