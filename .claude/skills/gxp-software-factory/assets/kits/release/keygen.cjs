// Creates the release signing key pair (Ed25519), once (docs/release-procedure.md):
//   node scripts/release/keygen.cjs <folder>
// Writes <folder>/release-signing-key.pem (PRIVATE: keep it in the CI secret store as RELEASE_SIGNING_KEY, never in the repository)
// and <folder>/release-public-key.pem (commit it as desktop/release-public-key.pem; from then on every start and every update
// requires a valid signature). Refuses to overwrite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = path.resolve(process.argv[2] || '.');
const priv = path.join(dir, 'release-signing-key.pem'), pub = path.join(dir, 'release-public-key.pem');
if (fs.existsSync(priv) || fs.existsSync(pub)) { console.error('A key already exists there; not overwriting.'); process.exit(1); }
const k = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(priv, k.privateKey, { mode: 0o600 });
fs.writeFileSync(pub, k.publicKey);
console.log(`written ${priv} (secret) and ${pub} (public)`);
