// Release integrity (roadmap M36, Annex 11 s.10 / 21 CFR 11.10(a)): the signed manifest of an installed baseline, the start-up
// check against it, and the check of an update package. Plain CommonJS with no dependency: loaded by the Electron shell
// (desktop/main.cjs, desktop/updater.cjs), by scripts/make-release-manifest.cjs in CI and by the installer tests.
//
// What the manifest proves: every file under dist/, dist-server/, desktop/, drizzle/, scripts/release/ and package.json is
// the file the build produced. With a public key shipped (desktop/release-public-key.pem) the manifest itself is signed (Ed25519),
// so changing a file AND its hash in the manifest is detected too. The shell (desktop/main.cjs) and the Electron runtime are
// outside the manifest: protecting them is the job of the Authenticode signature of the installer (docs/release-procedure.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COVERED = ['dist', 'dist-server', 'desktop', 'drizzle', 'scripts/release'];
const COVERED_FILES = ['package.json'];
const MANIFEST_NAME = 'release-manifest.json';
const PUBLIC_KEY_FILE = path.join('desktop', 'release-public-key.pem');

const sha256File = (f) => {
  const h = crypto.createHash('sha256'), fd = fs.openSync(f, 'r'), buf = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
};
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/** Every regular file below `dir` (sorted by JS comparison, never by locale). */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f)); else if (e.isFile()) out.push(f);
  }
  return out;
}
/** relative path -> sha256 of every covered file */
function hashTree(root) {
  const files = {};
  for (const d of COVERED) for (const f of walk(path.join(root, d))) files[rel(root, f)] = sha256File(f);
  for (const f of COVERED_FILES) if (fs.existsSync(path.join(root, f))) files[f] = sha256File(path.join(root, f));
  return Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]]));
}

/** The newest migration id (file name without .sql) in drizzle/, compared as text: ids are zero-padded. */
function latestSchemaVersion(root) {
  const dir = path.join(root, 'drizzle');
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f)).map(f => f.slice(0, -4)).sort();
  return ids.length ? ids[ids.length - 1] : null;
}

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const keyId = (publicPem) => crypto.createHash('sha256').update(crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

function buildManifest({ root, gitSha, installer, builtAt }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const m = { format: 1, product: pkg.name, version: pkg.version, gitSha: gitSha || 'unknown', schemaVersion: latestSchemaVersion(root),
    builtAt: builtAt || new Date().toISOString(), files: hashTree(root) };
  if (installer) {
    const st = fs.statSync(installer);
    m.installer = { name: path.basename(installer), bytes: st.size, sha256: sha256File(installer) };
  }
  return m;
}
function signManifest(manifest, privatePem) {
  const body = { ...manifest }; delete body.signature;
  const pub = crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' });
  return { ...body, signature: { alg: 'Ed25519', keyId: keyId(pub), value: crypto.sign(null, Buffer.from(canonical(body)), privatePem).toString('base64') } };
}
/** null when the signature is valid, else the reason. */
function checkSignature(manifest, publicPem) {
  const s = manifest.signature;
  if (!s || s.alg !== 'Ed25519' || typeof s.value !== 'string') return 'the manifest is not signed';
  const body = { ...manifest }; delete body.signature;
  try {
    return crypto.verify(null, Buffer.from(canonical(body)), crypto.createPublicKey(publicPem), Buffer.from(s.value, 'base64')) ? null : 'the signature does not match the manifest';
  } catch (e) { return 'the signature could not be checked: ' + e.message; }
}

function readPublicKey(root) {
  try { return fs.readFileSync(path.join(root, PUBLIC_KEY_FILE), 'utf8'); } catch { return null; }
}

/**
 * Check an installed tree against its manifest.
 * requireManifest: a packaged build must have one (a missing manifest is a failure); an unpackaged development tree may not.
 * publicKeyPem: defaults to desktop/release-public-key.pem; when a key exists the signature is mandatory.
 * Returns { ok, status: 'ok'|'ok-unsigned'|'no-manifest'|'fail', signed, version, gitSha, schemaVersion, errors:[{file,kind}] }.
 */
function verifyInstall({ root, requireManifest = true, publicKeyPem, manifestPath }) {
  const mf = manifestPath || path.join(root, MANIFEST_NAME);
  const fail = (errors, extra = {}) => ({ ok: false, status: 'fail', signed: false, errors, ...extra });
  if (!fs.existsSync(mf)) {
    return requireManifest ? fail([{ file: MANIFEST_NAME, kind: 'manifest' }]) : { ok: true, status: 'no-manifest', signed: false, errors: [] };
  }
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return fail([{ file: MANIFEST_NAME, kind: 'manifest' }]); }
  if (!m || m.format !== 1 || !m.files || typeof m.files !== 'object') return fail([{ file: MANIFEST_NAME, kind: 'manifest' }]);
  const info = { version: m.version, gitSha: m.gitSha, schemaVersion: m.schemaVersion };
  const pub = publicKeyPem === undefined ? readPublicKey(root) : publicKeyPem;
  let signed = false;
  if (pub) {
    const why = checkSignature(m, pub);
    if (why) return fail([{ file: MANIFEST_NAME, kind: 'signature', detail: why }], info);
    signed = true;
  }
  const errors = [];
  const actual = hashTree(root);
  for (const [f, h] of Object.entries(m.files)) {
    if (!(f in actual)) errors.push({ file: f, kind: 'missing' });
    else if (actual[f] !== h) errors.push({ file: f, kind: 'changed' });
  }
  for (const f of Object.keys(actual)) if (!(f in m.files)) errors.push({ file: f, kind: 'unexpected' });
  if (errors.length) return fail(errors, { ...info, signed });
  return { ok: true, status: signed ? 'ok' : 'ok-unsigned', signed, errors: [], ...info };
}

/** x.y.z[-pre] > a.b.c ? Pre-release identifiers sort below the release. */
function newerThan(a, b) {
  const p = (v) => { const [core, pre] = String(v).split('-'); return { n: core.split('.').map(x => parseInt(x, 10) || 0), pre }; };
  const A = p(a), B = p(b);
  for (let i = 0; i < 3; i++) if ((A.n[i] || 0) !== (B.n[i] || 0)) return (A.n[i] || 0) > (B.n[i] || 0);
  if (A.pre === B.pre) return false;
  if (!A.pre) return true;
  if (!B.pre) return false;
  return A.pre > B.pre;
}

/**
 * Check an update package (installer file + its published release-manifest.json) before anything is installed:
 * the manifest is signed (when a key is known; requireSignature forces a key), the installer's size and sha256 match, the version is newer
 * than the installed one and the product is the same.
 */
function checkUpdatePackage({ installerPath, manifestPath, publicKeyPem, requireSignature, currentVersion, product }) {
  const bad = (reason) => ({ ok: false, reason });
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return bad('The release manifest could not be read.'); }
  if (!m || m.format !== 1 || !m.installer || !m.version) return bad('The release manifest does not describe an installer.');
  if (requireSignature && !publicKeyPem) return bad('No release public key is installed, so the signature of this update cannot be checked.');
  if (publicKeyPem) { const why = checkSignature(m, publicKeyPem); if (why) return bad('Release manifest: ' + why + '.'); }
  if (product && m.product !== product) return bad(`The package is for ${m.product}, not ${product}.`);
  let st;
  try { st = fs.statSync(installerPath); } catch { return bad('The installer file could not be read.'); }
  if (st.size !== m.installer.bytes || sha256File(installerPath) !== m.installer.sha256) return bad('The installer does not match the release manifest (size or SHA-256).');
  if (currentVersion && !newerThan(m.version, currentVersion)) return bad(`Version ${m.version} is not newer than the installed version ${currentVersion}.`);
  return { ok: true, version: m.version, gitSha: m.gitSha, schemaVersion: m.schemaVersion, installerSha256: m.installer.sha256, installerName: m.installer.name, signed: !!publicKeyPem };
}

module.exports = { COVERED, MANIFEST_NAME, PUBLIC_KEY_FILE, sha256File, hashTree, latestSchemaVersion, canonical, keyId, buildManifest, signManifest, checkSignature, readPublicKey, verifyInstall, newerThan, checkUpdatePackage };
