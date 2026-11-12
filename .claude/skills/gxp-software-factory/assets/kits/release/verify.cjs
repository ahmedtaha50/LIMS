// Checks an installed or unpacked application folder against its release manifest (IT, IQ evidence, CI):
//   node scripts/release/verify.cjs <app-folder> [--public-key <pem>]     exit 0 = integrity OK, 1 = mismatch (files listed), 2 = usage
const fs = require('fs');
const path = require('path');
const lib = require('./manifest-lib.cjs');
const args = process.argv.slice(2);
const k = args.indexOf('--public-key');
const pubFile = k > -1 ? args.splice(k, 2)[1] : null;
if (!args[0]) { console.error('usage: node scripts/release/verify.cjs <app-folder> [--public-key <pem>]'); process.exit(2); }
const root = path.resolve(args[0]);
const r = lib.verifyInstall({ root, requireManifest: true, ...(pubFile ? { publicKeyPem: fs.readFileSync(pubFile, 'utf8') } : {}) });
for (const e of r.errors) console.error(`${e.kind.toUpperCase()} ${e.file}${e.detail ? ' (' + e.detail + ')' : ''}`);
console.log(r.ok ? `integrity OK (${r.status}): version ${r.version}, git ${String(r.gitSha).slice(0, 10)}, schema ${r.schemaVersion}` : 'INTEGRITY FAILED');
process.exit(r.ok ? 0 : 1);
