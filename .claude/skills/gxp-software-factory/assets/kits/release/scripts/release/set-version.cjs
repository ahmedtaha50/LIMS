// Derives the version from a release tag (roadmap M36): node scripts/release/set-version.cjs v0.2.0
// Writes it into package.json and package-lock.json before the build, so the installer name, the server bundle (__APP_VERSION__),
// the About box and the manifest all carry the tag's version. Refuses anything that is not MAJOR.MINOR.PATCH[-prerelease].
const fs = require('fs');
const path = require('path');
const tag = process.argv[2] || '';
const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!m) { console.error(`"${tag}" is not a release tag (expected vMAJOR.MINOR.PATCH).`); process.exit(1); }
const root = path.join(__dirname, '..', '..');
for (const f of ['package.json', 'package-lock.json']) {
  const file = path.join(root, f);
  if (!fs.existsSync(file)) continue;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.version = m[1];
  if (j.packages && j.packages['']) j.packages[''].version = m[1];
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
}
console.log('version set to ' + m[1]);
