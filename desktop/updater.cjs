/**
 * Controlled, offline-first software update for the desktop installation (roadmap M36; Annex 11 s.10, 21 CFR 11.10(a)).
 *
 * There is no automatic download and no internet update channel: an update is a folder (a LAN share, a UNC path, a USB stick)
 * that holds the installer and the release-manifest.json CI published next to it. Nothing is installed until
 *   1. the package verifies   installer size and SHA-256 match the manifest, the manifest signature is valid (Ed25519, public key
 *                             shipped in desktop/release-public-key.pem), the product is this product and the version is newer;
 *   2. an Administrator signs in and gives a change reference;
 *   3. a verified backup exists   POST /api/admin/backup answered verified:true and no problems (the backup is encrypted and
 *                             checked by the server; the pre-migration backup of the next start is on top of it);
 *   4. the server records the e-signature and the SOFTWARE_UPDATED audit row   POST /api/system/software-update (contract below).
 * Only then is the installer started and the application closed.
 *
 * Contract of POST /api/system/software-update (Admin, bearer token). The route is owned by the server tracks, not by this file:
 *   body   { changeReference, fromVersion, toVersion, toGitSha, installerSha256, password, totpCode? }
 *   200    { ok: true, updateId }  after it verified the password (and code) with the meaning "Approval", written the signature
 *          with the record version and the SOFTWARE_UPDATED audit row in ONE transaction.
 *   other  the message is shown and the installer is NOT started.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

/** The package in `folder`: the newest release-manifest.json whose installer sits next to it. */
function findPackage(folder) {
  const manifestPath = path.join(folder, 'release-manifest.json');
  if (!fs.existsSync(manifestPath)) return { error: `No release-manifest.json in ${folder}.` };
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { error: 'The release manifest could not be read.' }; }
  if (!m.installer || typeof m.installer.name !== 'string' || m.installer.name !== path.basename(m.installer.name)) return { error: 'The release manifest does not name an installer.' };
  return { manifestPath, installerPath: path.join(folder, m.installer.name) };
}

/** One JSON request to the local server. Resolves { status, body }; never rejects on an HTTP error status. */
function call(origin, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: '/api' + route, method, timeout: 10 * 60 * 1000,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', d => t += d);
      res.on('end', () => { let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = { error: t.slice(0, 200) }; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('timeout', () => req.destroy(new Error('The server did not answer.')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const why = (r) => (r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`;

/**
 * Steps 2 to 4. `pkg` is the result of lib.checkUpdatePackage. `form`: { email, password, loginCode?, changeReference, signCode? }.
 * Returns { ok: true, backupFile, updateId } or { ok: false, error } (nothing was installed in either case).
 */
async function authorise({ origin, pkg, form, currentVersion }) {
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!text(form.email, 255) || !text(form.password, 1024)) return { ok: false, error: 'E-mail and password are required.' };
  if (!text(form.changeReference, 200)) return { ok: false, error: 'A change reference (the approved change control record) is required.' };
  try {
    let r = await call(origin, 'POST', '/auth/login-local', { email: form.email, password: form.password });
    if (r.status === 200 && r.body && r.body.requiresTotp) {
      if (!text(form.loginCode, 16)) return { ok: false, error: 'Your account uses an authenticator: enter its code.' };
      r = await call(origin, 'POST', '/auth/totp-verify', { tempToken: r.body.tempToken, code: form.loginCode.trim() });
    }
    if (r.status !== 200 || !r.body || !r.body.token) return { ok: false, error: 'Sign-in failed: ' + why(r) };
    const token = r.body.token;

    const b = await call(origin, 'POST', '/admin/backup', { password: form.password }, token);
    if (b.status !== 200 || !b.body || b.body.verified !== true || (b.body.problems || []).length) {
      return { ok: false, error: 'The backup before the update did not verify, so the update was not started: ' + (b.status === 200 ? (b.body.problems || []).join('; ') || 'not verified' : why(b)) };
    }

    const sig = { changeReference: form.changeReference.trim(), fromVersion: currentVersion, toVersion: pkg.version, toGitSha: pkg.gitSha, installerSha256: pkg.installerSha256,
      password: form.password, ...(text(form.signCode, 16) ? { totpCode: form.signCode.trim() } : {}) };
    const s = await call(origin, 'POST', '/system/software-update', sig, token);
    if (s.status === 404) return { ok: false, error: 'This server cannot record a software update (no /api/system/software-update). The update was not started.' };
    if (s.status !== 200 || !s.body || s.body.ok !== true) return { ok: false, error: 'The update was not authorised: ' + why(s) };
    return { ok: true, backupFile: b.body.file, updateId: s.body.updateId };
  } catch (e) {
    return { ok: false, error: 'The local server could not be reached: ' + e.message };
  }
}


// ---- the form of the update window -------------------------------------------------------------------------------
// Written to <userData>/update.html when the window opens (the file is not part of the signed tree, so the content comes from here).
// The CSP names the hash of the one script and of the one style block, computed here, so nothing else can run.
const crypto = require('crypto');
const STYLE = 'body{font:14px system-ui,sans-serif;margin:20px;color:#111}h1{font-size:18px}dl{display:grid;grid-template-columns:150px 1fr;gap:4px 8px;word-break:break-all}dt{font-weight:600}label{display:block;margin-top:12px;font-weight:600}input{display:block;width:100%;box-sizing:border-box;padding:6px;margin-top:4px}button{margin-top:18px;padding:8px 16px}#msg{margin-top:14px;font-weight:600}.err{color:#b00020}.ok{color:#0a6b2d}small{font-weight:400;color:#444}';
const SCRIPT = `
const $ = (id) => document.getElementById(id);
const say = (t, cls) => { $('msg').textContent = t; $('msg').className = cls || ''; };
window.limsUpdate.info().then((i) => {
  $('facts').innerHTML = '';
  for (const [k, v] of [['Installed version', i.from], ['New version', i.to], ['Git revision', i.gitSha], ['Schema version', i.schemaVersion], ['Installer', i.installer], ['SHA-256', i.sha256], ['Signature', i.signed ? 'valid' : 'not checked (no release key installed)']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = String(v); $('facts').append(dt, dd);
  }
}).catch((e) => say(e.message, 'err'));
$('go').addEventListener('click', async () => {
  const f = { email: $('email').value, password: $('pw').value, loginCode: $('lc').value, changeReference: $('cr').value, signCode: $('sc').value };
  if (!f.email || !f.password || !f.changeReference.trim()) { say('E-mail, password and change reference are required.', 'err'); return; }
  $('go').disabled = true; say('Taking and verifying the backup, then recording your signature…');
  try {
    const r = await window.limsUpdate.install(f);
    if (r.error) { say(r.error, 'err'); $('go').disabled = false; } else say('Authorised. Backup: ' + r.backup + '. The installer is starting and this application will close.', 'ok');
  } catch (e) { say(e.message, 'err'); $('go').disabled = false; }
});`;
const sha = (t) => "'sha256-" + crypto.createHash('sha256').update(t).digest('base64') + "'";
const FORM_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Install update</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${sha(SCRIPT)}; style-src ${sha(STYLE)}; base-uri 'none'; form-action 'none'">
<style>${STYLE}</style></head><body><h1>Install a software update</h1>
<p>The package was verified against its release manifest. Installing it needs an Administrator's electronic signature. A verified backup is taken first.</p>
<dl id="facts"></dl>
<label for="cr">Change reference <small>(the approved change control record)</small></label><input id="cr" autocomplete="off" maxlength="200">
<label for="email">Administrator e-mail</label><input id="email" autocomplete="off">
<label for="pw">Password</label><input id="pw" type="password" autocomplete="off">
<label for="lc">Authenticator code to sign in <small>(only if your account uses one)</small></label><input id="lc" inputmode="numeric" autocomplete="off" maxlength="16">
<label for="sc">Next authenticator code for the signature <small>(wait for a new code; a used code is refused)</small></label><input id="sc" inputmode="numeric" autocomplete="off" maxlength="16">
<button id="go" type="button">Sign and install</button><div id="msg" role="status" aria-live="polite"></div>
<script>${SCRIPT}</script></body></html>`;

module.exports = { findPackage, call, authorise, FORM_HTML };
