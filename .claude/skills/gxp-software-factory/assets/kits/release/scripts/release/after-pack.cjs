// electron-builder afterPack hook (roadmap M36): writes release-manifest.json from the files that were PACKAGED.
//
// Why here and not before packaging: electron-builder does not copy package.json as it is (it writes a smaller one), so a manifest
// computed from the source tree never matches the installed application, and the start-up check (desktop/main.cjs checkIntegrity)
// refuses to start. Hashing the packaged folder describes exactly what the installer puts on disk.
// A manifest staged earlier by scripts/make-release-manifest.cjs (release.yml does) is replaced.
// Signed with RELEASE_SIGNING_KEY (Ed25519 PEM) when set; otherwise written unsigned (hashes only).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./manifest-lib.cjs');

function appFolder(context) {
  const dir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : path.join(context.appOutDir, 'resources', 'app');
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`after-pack: the application folder was not found at ${dir} (asar packaging would hide the files from the integrity check; keep "asar": false).`);
  }
  return dir;
}

exports.default = async function afterPack(context) {
  const root = appFolder(context);
  let gitSha = process.env.GITHUB_SHA;
  if (!gitSha) { try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: context.packager.projectDir || process.cwd(), encoding: 'utf8' }).trim(); } catch { gitSha = 'unknown'; } }
  let m = lib.buildManifest({ root, gitSha });
  if (process.env.RELEASE_SIGNING_KEY) m = lib.signManifest(m, process.env.RELEASE_SIGNING_KEY);
  else console.warn('after-pack: RELEASE_SIGNING_KEY is not set: the release manifest is written unsigned (hashes only).');
  fs.writeFileSync(path.join(root, lib.MANIFEST_NAME), JSON.stringify(m, null, 2) + '\n');
  console.log(`after-pack: ${lib.MANIFEST_NAME}: ${Object.keys(m.files).length} packaged files, version ${m.version}, git ${String(m.gitSha).slice(0, 10)}, schema ${m.schemaVersion}, ${m.signature ? 'signed ' + m.signature.keyId : 'unsigned'}`);
};
