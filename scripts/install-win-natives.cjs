// A lockfile generated on Linux omits Windows-only optional native packages (npm/cli#4828).
// After `npm ci` on Windows, install exactly the win32-x64 variants each parent declares.
const fs = require('fs'), cp = require('child_process');
const parents = ['rollup', 'esbuild', 'lightningcss', '@tailwindcss/oxide'];
const want = [];
for (const p of parents) {
  const f = `node_modules/${p}/package.json`; if (!fs.existsSync(f)) continue;
  const o = JSON.parse(fs.readFileSync(f, 'utf8')).optionalDependencies || {};
  for (const [name, ver] of Object.entries(o)) if (/win32-x64/.test(name)) want.push(`${name}@${ver}`);
}
console.log('installing', want.join(' '));
if (want.length) cp.execSync(`npm install --no-save --no-package-lock --no-audit --no-fund ${want.join(' ')}`, { stdio: 'inherit' });
