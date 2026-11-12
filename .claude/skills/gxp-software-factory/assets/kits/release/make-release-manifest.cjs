// Writes the release manifest (roadmap M36): hashes of dist/, dist-server/, desktop/, drizzle/, scripts/release/ and package.json,
// the version, git sha and schema version; with --installer also the installer's size and hash; signed (Ed25519) when
// RELEASE_SIGNING_KEY (PEM, PKCS#8) is set.
//
//   node scripts/make-release-manifest.cjs                         stage: <root>/release-manifest.json, packaged with the application
//   node scripts/make-release-manifest.cjs --installer release/B-Pharma-LIMS-Setup-0.2.0.exe --out release/release-manifest.json
//                                                                   publish: the same body plus the installer, to ship next to it
// Options: --root <dir>  --git-sha <sha>  --out <file>  --installer <file>
// The version comes from package.json; CI sets it from the tag (scripts/release/set-version.cjs) before the build.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./release/manifest-lib.cjs');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
let gitSha = arg('--git-sha') || process.env.GITHUB_SHA;
if (!gitSha) { try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { gitSha = 'unknown'; } }
const installer = arg('--installer');
const out = path.resolve(arg('--out') || path.join(root, lib.MANIFEST_NAME));

let m = lib.buildManifest({ root, gitSha, installer: installer && path.resolve(installer) });
if (process.env.RELEASE_SIGNING_KEY) m = lib.signManifest(m, process.env.RELEASE_SIGNING_KEY);
else console.warn('RELEASE_SIGNING_KEY is not set: the manifest is written unsigned (hashes only).');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
console.log(`${path.relative(process.cwd(), out)}: ${Object.keys(m.files).length} files, version ${m.version}, git ${m.gitSha.slice(0, 10)}, schema ${m.schemaVersion}, ${m.signature ? 'signed ' + m.signature.keyId : 'unsigned'}${m.installer ? ', installer ' + m.installer.sha256.slice(0, 12) : ''}`);
