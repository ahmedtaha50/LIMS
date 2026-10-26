// The update gate (desktop/updater.cjs) against a stub of the local server: the order of the steps and what stops the update.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const updater = require('../../desktop/updater.cjs');

const pkg = { version: '0.2.0', gitSha: 'abc', installerSha256: 'f'.repeat(64) };
const form = { email: 'admin@x.test', password: 'pw-pw-pw-1', changeReference: 'CC-2026-014' };

/** Stub server; `h` maps "METHOD /route" to (body, headers) => [status, json]. Calls are recorded in order. */
async function stub(h) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let t = ''; req.on('data', d => t += d);
    req.on('end', () => {
      const body = t ? JSON.parse(t) : null;
      calls.push({ route: `${req.method} ${req.url}`, body, auth: req.headers.authorization });
      const f = h[`${req.method} ${req.url}`];
      const [status, json] = f ? f(body, req.headers) : [404, { error: 'no route' }];
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise(r => srv.close(r)) };
}
const loginOk = { 'POST /api/auth/login-local': () => [200, { token: 'T1' }] };

test('sign-in, verified backup, then the signature: in that order, with the same bearer token and the package facts', async () => {
  const s = await stub({ ...loginOk,
    'POST /api/admin/backup': () => [200, { file: 'b.bak', verified: true, problems: [] }],
    'POST /api/system/software-update': () => [200, { ok: true, updateId: 'U1' }] });
  const r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' });
  await s.close();
  assert.deepEqual(r, { ok: true, backupFile: 'b.bak', updateId: 'U1' });
  assert.deepEqual(s.calls.map(c => c.route), ['POST /api/auth/login-local', 'POST /api/admin/backup', 'POST /api/system/software-update']);
  assert.equal(s.calls[2].auth, 'Bearer T1');
  assert.deepEqual(s.calls[2].body, { changeReference: 'CC-2026-014', fromVersion: '0.1.0', toVersion: '0.2.0', toGitSha: 'abc', installerSha256: 'f'.repeat(64), password: form.password });
});

test('a backup that did not verify stops the update before any signature is recorded', async () => {
  const s = await stub({ ...loginOk, 'POST /api/admin/backup': () => [200, { file: 'b.bak', verified: false, problems: ['frame 3 damaged'] }] });
  const r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' });
  await s.close();
  assert.equal(r.ok, false);
  assert.match(r.error, /backup before the update did not verify/);
  assert.match(r.error, /frame 3 damaged/);
  assert.ok(!s.calls.some(c => c.route.includes('software-update')));
});

test('a backup answering verified:false without a problem list also stops the update', async () => {
  const s = await stub({ ...loginOk, 'POST /api/admin/backup': () => [200, { file: 'b.bak', verified: false, problems: [] }] });
  const r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' });
  await s.close();
  assert.equal(r.ok, false);
  assert.ok(!s.calls.some(c => c.route.includes('software-update')));
});

test('a server without the software-update route, a refused signature and a failed sign-in each stop the update with a clear message', async () => {
  let s = await stub({ ...loginOk, 'POST /api/admin/backup': () => [200, { file: 'b', verified: true, problems: [] }] });
  let r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' }); await s.close();
  assert.equal(r.ok, false); assert.match(r.error, /cannot record a software update/);

  s = await stub({ ...loginOk, 'POST /api/admin/backup': () => [200, { file: 'b', verified: true, problems: [] }], 'POST /api/system/software-update': () => [401, { error: 'Invalid credentials' }] });
  r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' }); await s.close();
  assert.equal(r.ok, false); assert.match(r.error, /not authorised: Invalid credentials/);

  s = await stub({ 'POST /api/auth/login-local': () => [401, { error: 'Invalid credentials' }] });
  r = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' }); await s.close();
  assert.equal(r.ok, false); assert.match(r.error, /Sign-in failed/);
  assert.equal(s.calls.length, 1, 'nothing after a failed sign-in');
});

test('an account with an authenticator needs its code; the code goes to the second login step', async () => {
  const s = await stub({ 'POST /api/auth/login-local': () => [200, { requiresTotp: true, tempToken: 'TT' }],
    'POST /api/auth/totp-verify': (b) => (b.code === '123456' && b.tempToken === 'TT' ? [200, { token: 'T2' }] : [401, { error: 'Invalid authenticator code.' }]),
    'POST /api/admin/backup': () => [200, { file: 'b', verified: true, problems: [] }],
    'POST /api/system/software-update': (b) => [200, { ok: b.totpCode === '654321', updateId: 'U2' }] });
  const none = await updater.authorise({ origin: s.origin, pkg, form, currentVersion: '0.1.0' });
  assert.match(none.error, /enter its code/);
  const ok = await updater.authorise({ origin: s.origin, pkg, form: { ...form, loginCode: '123456', signCode: '654321' }, currentVersion: '0.1.0' });
  await s.close();
  assert.equal(ok.ok, true);
});

test('missing change reference, e-mail or password is refused without calling the server', async () => {
  const s = await stub({});
  assert.match((await updater.authorise({ origin: s.origin, pkg, form: { ...form, changeReference: '  ' }, currentVersion: '0.1.0' })).error, /change reference/);
  assert.match((await updater.authorise({ origin: s.origin, pkg, form: { ...form, password: '' }, currentVersion: '0.1.0' })).error, /password are required/);
  await s.close();
  assert.equal(s.calls.length, 0);
});

test('findPackage locates the installer next to the manifest and refuses a manifest naming a path', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-feed-'));
  assert.match(updater.findPackage(d).error, /No release-manifest/);
  fs.writeFileSync(path.join(d, 'release-manifest.json'), JSON.stringify({ installer: { name: '../evil.exe' } }));
  assert.match(updater.findPackage(d).error, /does not name an installer/);
  fs.writeFileSync(path.join(d, 'release-manifest.json'), JSON.stringify({ installer: { name: 'Setup.exe' } }));
  assert.equal(updater.findPackage(d).installerPath, path.join(d, 'Setup.exe'));
});
