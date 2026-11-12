// CycloneDX 1.5 software bill of materials from package-lock.json (roadmap M36). No network, no dependency.
//   node scripts/release/make-sbom.cjs [--lock package-lock.json] [--out release/sbom.cdx.json] [--git-sha <sha>]
// One component per locked package (the lock lists the exact versions and sha512 integrity of what npm ci installs);
// scope "optional" for dev-only tooling, since this project bundles its runtime code at build time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const lockFile = path.resolve(arg('--lock') || path.join(__dirname, '..', '..', 'package-lock.json'));
const out = path.resolve(arg('--out') || path.join(__dirname, '..', '..', 'release', 'sbom.cdx.json'));
const gitSha = arg('--git-sha') || process.env.GITHUB_SHA || 'unknown';

const lockText = fs.readFileSync(lockFile, 'utf8');
const lock = JSON.parse(lockText);
const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const purl = (name, version) => 'pkg:npm/' + (name.startsWith('@') ? '%40' + name.slice(1) : name) + '@' + version;

const components = Object.entries(lock.packages || {})
  .filter(([key, p]) => key && p.version && !p.link)
  .map(([key, p]) => {
    const name = nameOf(key);
    const c = { type: 'library', 'bom-ref': purl(name, p.version) + (key.split('node_modules/').length > 2 ? '#' + key : ''), name, version: p.version, purl: purl(name, p.version), scope: p.dev ? 'optional' : 'required' };
    if (p.integrity && p.integrity.startsWith('sha512-')) c.hashes = [{ alg: 'SHA-512', content: Buffer.from(p.integrity.slice(7), 'base64').toString('hex') }];
    if (p.license) c.licenses = [{ license: { id: String(p.license) } }];
    if (p.resolved) c.externalReferences = [{ type: 'distribution', url: p.resolved }];
    return c;
  })
  .sort((a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : a['bom-ref'] > b['bom-ref'] ? 1 : 0));

const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  serialNumber: 'urn:uuid:' + crypto.randomUUID(),
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ name: 'scripts/release/make-sbom.cjs' }],
    component: { type: 'application', name: lock.name, version: lock.version, 'bom-ref': purl(lock.name, lock.version),
      properties: [{ name: 'git.sha', value: gitSha }, { name: 'package-lock.sha256', value: crypto.createHash('sha256').update(lockText).digest('hex') }] },
  },
  components,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sbom, null, 2) + '\n');
console.log(`${path.relative(process.cwd(), out)}: ${components.length} components`);
