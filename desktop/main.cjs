/**
 * Electron shell for B-Pharma LIMS (single-PC deployment).
 * - Runs the bundled Express server (dist-server/server.cjs) as a supervised child on 127.0.0.1 only, on a port that is
 *   chosen once and then kept, so the origin (and the browser storage scoped to it) survives restarts.
 * - The child's output is kept in <userData>/logs/server.log (rotating, credentials redacted). If the child dies it is
 *   restarted after a short back-off and the restart is written to that log (SERVER_RESTART).
 * - DB password and JWT secret are generated/stored encrypted with safeStorage (DPAPI on Windows).
 * - Database (roadmap M40): "Built-in database" (default) runs a private PostgreSQL 16 from the installer's resources in
 *   <userData>/pgdata on a saved loopback port, supervised by desktop/pg-supervisor.cjs: restarted after a crash, stopped on quit.
 *   Two logins with generated passwords: lims_owner (installer, migrations, backup/restore) and lims_app (the request path, no DDL, no
 *   change to the append-only tables). "Connect to an existing PostgreSQL" keeps the earlier behaviour (one login that the user gives).
 * - Renderer is sandboxed: no node integration, context isolation, no preload on the application window, navigation
 *   locked to the exact local origin, only the microphone/camera permission granted (to that origin).
 * - The IPC bridge (preload.cjs) exists only in the setup window and the update window (bridgeWindow), and their IPC handlers check the sender.
 * - Release integrity (roadmap M36): at every start the installed files are checked against the release manifest
 *   (scripts/release/manifest-lib.cjs). A packaged build with a missing, changed or unexpected file does not start; the files are
 *   named in the dialog and in <userData>/logs/release-events.jsonl (SYSTEM_INTEGRITY_FAIL). A start writes SERVER_START there.
 *   Updates are installed only from a verified package after an Administrator's e-signature (desktop/updater.cjs).
 */
const { app, BrowserWindow, ipcMain, dialog, safeStorage, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const { pathToFileURL } = require('url');
const os = require('os');

const root = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const logDir = () => path.join(app.getPath('userData'), 'logs');
const setupFile = path.join(__dirname, 'setup.html');
const setupUrl = pathToFileURL(setupFile).href;
const releaseLib = () => require(path.join(root, 'scripts', 'release', 'manifest-lib.cjs'));
const updater = require('./updater.cjs');
const pgs = require('./pg-supervisor.cjs');
let pgSup = null, pendingEmbedded = null, quitState = 0;
let supervisor = null, win = null, setupWin = null, updateWin = null, origin = null, integrity = null, pendingUpdate = null;

// Developer/CI escape hatch for headless Linux only: never honoured in a packaged build or on Windows.
const devPlaintext = process.env.LIMS_DEV_PLAINTEXT_SECRETS === '1' && !app.isPackaged && process.platform !== 'win32';
if (devPlaintext) safeStorage.setUsePlainTextEncryption?.(true);

function enc(s) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential protection is unavailable; refusing to store secrets in clear text.');
  return safeStorage.encryptString(s).toString('base64');
}
const dec = (s) => safeStorage.decryptString(Buffer.from(s, 'base64'));

function loadConfig() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return null; } }
function saveConfig(c) { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c), { mode: 0o600 }); }

// ---- release integrity and the release-event log ---------------------------------------------------------------
/** One line per event; the server's owner imports these into the audit trail (docs/release-procedure.md). */
function releaseEvent(type, detail) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), 'release-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, ...detail }) + '\n');
  } catch { /* the dialog still tells the operator */ }
}
function appVersion() { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } }
/** Checks the installed files against the release manifest. A packaged build must have a manifest; a development tree need not. */
function checkIntegrity() {
  let r;
  try { r = releaseLib().verifyInstall({ root, requireManifest: app.isPackaged }); }
  catch (e) { r = { ok: false, status: 'fail', errors: [{ file: 'scripts/release/manifest-lib.cjs', kind: 'manifest', detail: e.message }] }; }
  integrity = r;
  if (!r.ok) { releaseEvent('SYSTEM_INTEGRITY_FAIL', { version: r.version, gitSha: r.gitSha, files: r.errors }); return false; }
  releaseEvent('SERVER_START', { version: r.version || appVersion(), gitSha: r.gitSha, schemaVersion: r.schemaVersion, integrity: r.status });
  return true;
}
function integrityLine() {
  if (!integrity) return 'integrity not checked';
  if (integrity.status === 'ok') return 'integrity OK (signed release manifest)';
  if (integrity.status === 'ok-unsigned') return 'integrity OK (file hashes only: the manifest is not signed)';
  if (integrity.status === 'no-manifest') return 'integrity not checked (development tree without a release manifest)';
  return 'INTEGRITY FAILED';
}
function showAbout() {
  const r = integrity || {};
  dialog.showMessageBox({ type: 'info', title: 'About B-Pharma LIMS', message: 'B-Pharma LIMS ' + (r.version || appVersion()),
    detail: [`Version: ${r.version || appVersion()}`, `Git revision: ${r.gitSha || 'n/a'}`, `Schema version: ${r.schemaVersion || 'n/a'}`, `Integrity: ${integrityLine()}`,
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`].join('\n') });
}

// ---- port: chosen once, then kept ------------------------------------------------------------------------------
function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
}
function osFreePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
/** A free port below the operating systems' ephemeral ranges (outgoing connections take ports from those and could collide later). */
async function anyFreePort() {
  for (let i = 0; i < 20; i++) { const p = 20000 + crypto.randomInt(10000); if (await portFree(p)) return p; }
  return osFreePort();
}
/** The stored port if it is still free, else a new one (stored, so the next start uses it). */
async function stablePort(c) {
  if (Number.isInteger(c.port) && c.port > 1023 && c.port < 65536 && await portFree(c.port)) return c.port;
  c.port = await anyFreePort();
  saveConfig(c);
  return c.port;
}

function waitUp(port, tries = 60) {
  return new Promise((res, rej) => {
    const t = () => http.get({ host: '127.0.0.1', port, path: '/api/ready' }, r => { r.resume(); if (r.statusCode === 200) res(); else retry(); })
      .on('error', retry);
    const retry = () => (--tries > 0 ? setTimeout(t, 500) : rej(new Error('The server did not become ready. See ' + path.join(logDir(), 'server.log'))));
    t();
  });
}
/** Connection variables. Built-in: the owner connection for the installer step, plus the unprivileged request login for the server. */
function dbEnv(c, { server = false } = {}) {
  if (c.mode !== 'embedded') return { SQL_HOST: c.host, SQL_DB_NAME: c.database, SQL_USER: c.user, SQL_PASSWORD: dec(c.password) };
  const env = { SQL_HOST: '127.0.0.1', SQL_PORT: String(c.pgPort), SQL_DB_NAME: c.database, SQL_USER: pgs.OWNER_ROLE, SQL_PASSWORD: dec(c.ownerPassword) };
  if (server) Object.assign(env, { SQL_APP_USER: 'lims_app', SQL_APP_PASSWORD: dec(c.appPassword) }); // the owner pool is used only for backup and restore
  return env;
}

// ---- built-in PostgreSQL ------------------------------------------------------------------------------------------
const pgDataDir = () => path.join(app.getPath('userData'), 'pgdata');
const pgBin = () => pgs.findBinDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env });
/** Development and CI only (never in a packaged build): run the embedded server as another account (PostgreSQL refuses to run as root). */
function pgRunAs() {
  const m = !app.isPackaged && /^(\d+):(\d+)$/.exec(process.env.LIMS_PG_RUN_AS || '');
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : undefined;
}
const minFreeMb = (fresh) => (!app.isPackaged && Number(process.env.LIMS_PG_MIN_FREE_MB)) || (fresh ? 2048 : 512);
const NO_BUNDLE = 'The built-in database files are missing from this installation. Reinstall from the validated installer, or choose "Connect to an existing PostgreSQL".';

/** Starts (once) the supervised PostgreSQL of an embedded configuration. A stored port that another program has taken is replaced and saved. */
async function startPostgres(c) {
  if (pgSup) return;
  const bin = pgBin();
  if (!bin) throw new Error(NO_BUNDLE);
  if (app.isPackaged) {
    const v = pgs.verifyBinaries(path.dirname(bin));
    if (!v.ok) { releaseEvent('SYSTEM_INTEGRITY_FAIL', { component: 'postgresql', files: v.errors }); throw new Error('The bundled database files do not match the recorded hashes, so the database was not started:\n' + v.errors.slice(0, 6).join('\n')); }
  }
  fs.mkdirSync(logDir(), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const sup = pgs.superviseEmbedded({ binDir: bin, dataDir: pgDataDir(), port: c.pgPort, logFile: path.join(logDir(), 'postgres.log'), runAs: pgRunAs(),
      onEvent: (type, detail) => { if (type !== 'PG_START' && type !== 'PG_STOP') releaseEvent('DATABASE_' + type, detail); },
      onGiveUp: () => dialog.showErrorBox('B-Pharma LIMS', `The built-in database stopped repeatedly and was not restarted again.\nSee ${path.join(logDir(), 'postgres.log')}.`) });
    try { await sup.start(); pgSup = sup; return; }
    catch (e) {
      await sup.stop().catch(() => {});
      if (attempt === 0 && /already in use/.test(e.message)) { c.pgPort = await anyFreePort(); if (!pendingEmbedded) saveConfig(c); continue; }
      throw e;
    }
  }
}
function backupEnv(c) {
  const env = { BACKUP_DIR: path.join(app.getPath('userData'), 'backups') };
  if (c.backupPassphrase) env.BACKUP_PASSPHRASE = dec(c.backupPassphrase);
  return env;
}
function runInit(c, extra) {
  return new Promise((resolve) => {
    let out = '';
    const p = fork(path.join(root, 'dist-server', 'init-db.cjs'), [], {
      cwd: root, silent: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SCHEMA_FILE: path.join(root, 'desktop', 'schema.sql'), ...dbEnv(c), ...backupEnv(c),
        ...(c.mode === 'embedded' ? { LIMS_APP_ROLE: 'required', LIMS_APP_DB_PASSWORD: dec(c.appPassword) } : {}), ...extra },
    });
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', code => resolve({ code, out: out.trim() }));
  });
}

async function startServer(c) {
  const port = await stablePort(c);
  const { superviseServer } = require(path.join(root, 'dist-server', 'supervisor.cjs'));
  if (supervisor) await supervisor.stop();
  supervisor = superviseServer({
    entry: path.join(root, 'dist-server', 'server.cjs'),
    cwd: root,
    execArgv: ['--enable-source-maps'],
    logDir: logDir(),
    env: { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      DIST_DIR: path.join(root, 'dist'), JWT_SECRET: dec(c.jwtSecret), ...dbEnv(c, { server: true }), ...backupEnv(c),
      LIMS_RELEASE_GIT_SHA: integrity?.gitSha || '', LIMS_RELEASE_INTEGRITY: integrity?.status || '' },
    onGiveUp: () => dialog.showErrorBox('B-Pharma LIMS', `The server stopped repeatedly and was not restarted again.\nSee ${path.join(logDir(), 'server.log')}.`),
  });
  await waitUp(port);
  origin = `http://127.0.0.1:${port}`;
  return origin;
}

// ---- what a window may do ----------------------------------------------------------------------------------------
const strip = (u) => String(u).split(/[?#]/)[0];
function sameOrigin(u) { try { return !!origin && new URL(u).origin === origin; } catch { return false; } }

/** Navigation stays on `allow`; anything else is refused. New windows are never opened; http(s) links go to the browser. */
function lockNavigation(wc, allow) {
  const guard = (e, u) => { if (!allow(u)) e.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    try { const p = new URL(url); if ((p.protocol === 'https:' || p.protocol === 'http:') && !sameOrigin(url)) shell.openExternal(url); } catch { /* not a URL */ }
    return { action: 'deny' };
  });
}

/** Only the LIMS origin may use the microphone (voice notes) and camera (barcode scanner); everything else is refused. */
function installPermissionHandlers() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((wc, permission, callback, details) => callback(permission === 'media' && sameOrigin(details?.requestingUrl || wc.getURL())));
  s.setPermissionCheckHandler((wc, permission, requestingOrigin) => permission === 'media' && sameOrigin(requestingOrigin));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Application', submenu: [
      { label: 'Backup…', click: () => { if (!origin) return; const w = new BrowserWindow({ width: 620, height: 640, title: 'Backup', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged } });
          lockNavigation(w.webContents, sameOrigin); w.loadURL(origin + '/backup.html'); } },
      { label: 'Open backups folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'backups')) },
      { label: 'Open log folder', click: () => shell.openPath(logDir()) },
      { label: 'Database connection…', click: showSetup },
      { label: 'Install update from file…', click: chooseUpdate },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    { label: 'Help', submenu: [{ label: 'About B-Pharma LIMS', click: showAbout }] },
  ]));
}

/** The application window: no preload, so nothing a page script could call can reach the main process. */
function openMain(url) {
  const w = new BrowserWindow({
    width: 1400, height: 900, title: 'B-Pharma LIMS',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: !app.isPackaged },
  });
  lockNavigation(w.webContents, sameOrigin);
  w.on('closed', () => { if (win === w) win = null; });
  win = w;
  w.loadURL(url);
  return w;
}

/** The two windows with the IPC bridge (setup and update): sandboxed local pages whose IPC handlers check the sender. The one place a preload is set. */
function bridgeWindow(opts) {
  return new BrowserWindow({ ...opts, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
}

/** The window with the database-connection bridge. It shows a local file and may not navigate anywhere else. */
function showSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.focus(); return setupWin; }
  const w = bridgeWindow({ width: 760, height: 760, title: 'B-Pharma LIMS – database connection' });
  lockNavigation(w.webContents, (u) => strip(u) === setupUrl);
  w.on('closed', () => { if (setupWin === w) setupWin = null; });
  setupWin = w;
  w.loadFile(setupFile);
  return w;
}

/** An IPC call is honoured only from the top frame of the live setup window showing setup.html. */
function fromSetup(e) {
  return !!setupWin && !setupWin.isDestroyed() && e.sender === setupWin.webContents
    && !!e.senderFrame && e.senderFrame === e.sender.mainFrame && strip(e.senderFrame.url) === setupUrl;
}
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

ipcMain.handle('config:get', (e) => {
  if (!fromSetup(e)) throw new Error('Not allowed.');
  const c = loadConfig(); return c && { mode: c.mode === 'embedded' ? 'embedded' : 'external', host: c.host, database: c.database, user: c.user, hasBackupPassphrase: !!c.backupPassphrase };
});
ipcMain.handle('config:save', async (e, f) => {
  if (!fromSetup(e)) throw new Error('Not allowed.');
  try {
    if (!f || typeof f !== 'object') return { error: 'Invalid request.' };
    const embedded = f.mode === 'embedded';
    if (f.mode !== 'embedded' && f.mode !== 'external') return { error: 'Choose the built-in database or an existing PostgreSQL.' };
    if (!embedded && (!text(f.host, 255) || !text(f.database, 63) || !text(f.user, 63) || !text(f.password, 512))) return { error: 'Host, database, user and password are required.' };
    for (const k of ['adminName', 'adminEmail', 'adminPassword']) if (f[k] !== undefined && typeof f[k] !== 'string') return { error: 'Invalid administrator details.' };
    if (f.backupPassphrase !== undefined && typeof f.backupPassphrase !== 'string') return { error: 'Invalid backup passphrase.' };
    const prev = loadConfig();
    if (f.backupPassphrase && (f.backupPassphrase.length < 12 || f.backupPassphrase.length > 512)) return { error: 'The backup passphrase must be at least 12 characters.' };
    const backupPassphrase = f.backupPassphrase ? enc(f.backupPassphrase) : prev?.backupPassphrase;
    if (!backupPassphrase) return { error: 'A backup passphrase is required (at least 12 characters). It encrypts every backup, including the one taken before a database upgrade.' };
    const admin = { ADMIN_NAME: f.adminName, ADMIN_EMAIL: f.adminEmail, ADMIN_PASSWORD: f.adminPassword };
    const jwtSecret = prev?.jwtSecret || enc(crypto.randomBytes(48).toString('hex'));
    let c;
    if (!embedded) {
      c = { mode: 'external', host: f.host, database: f.database, user: f.user, password: enc(f.password), port: prev?.port, jwtSecret, backupPassphrase };
    } else {
      const bin = pgBin();
      if (!bin) return { error: NO_BUNDLE };
      if (prev?.mode === 'embedded') c = { ...prev, backupPassphrase }; // a repeat run: the stored logins are kept (upgrade of the schema)
      else if (pendingEmbedded && fs.existsSync(path.join(pgDataDir(), 'PG_VERSION'))) c = { ...pendingEmbedded, backupPassphrase }; // an earlier attempt of this session that did not finish
      else {
        const disk = pgs.checkDisk(app.getPath('userData'), minFreeMb(true) * 1048576);
        if (!disk.ok) return { error: disk.message };
        // A data folder without a stored configuration is the leftover of an attempt that never finished: it never held data, but it is moved aside, not deleted.
        if (fs.existsSync(pgDataDir())) fs.renameSync(pgDataDir(), pgDataDir() + '.unused-' + Date.now());
        c = { mode: 'embedded', database: 'lims', pgPort: await anyFreePort(), ownerPassword: enc(crypto.randomBytes(24).toString('base64url')),
          appPassword: enc(crypto.randomBytes(24).toString('base64url')), port: prev?.port, jwtSecret, backupPassphrase };
        pendingEmbedded = c;
      }
      await pgs.provision({ binDir: bin, dataDir: pgDataDir(), port: c.pgPort, ownerPassword: dec(c.ownerPassword), runAs: pgRunAs() });
      await startPostgres(c);
      pgs.bootstrapDatabase({ binDir: bin, port: c.pgPort, ownerPassword: dec(c.ownerPassword), database: c.database });
    }
    const r = await runInit(c, admin);
    if (r.code !== 0) return { error: r.out || 'Database initialisation failed' };
    if (embedded) pgs.finalizeAppRole({ binDir: pgBin(), port: c.pgPort, ownerPassword: dec(c.ownerPassword), database: c.database });
    saveConfig(c);
    pendingEmbedded = null;
    openMain(await startServer(c));
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

// ---- controlled update (desktop/updater.cjs) ---------------------------------------------------------------------
/** The installer is chosen by hand (a share or a stick); its release-manifest.json must sit next to it. Nothing is installed here. */
async function chooseUpdate() {
  if (!origin) { dialog.showErrorBox('Install update', 'The application server is not running. Start the application first: the update needs an Administrator to sign in.'); return; }
  const pick = await dialog.showOpenDialog({ title: 'Choose the installer (release-manifest.json must be in the same folder)', properties: ['openFile'], filters: [{ name: 'Installer', extensions: ['exe', 'AppImage'] }] });
  if (pick.canceled || !pick.filePaths[0]) return;
  const installerPath = pick.filePaths[0];
  const found = updater.findPackage(path.dirname(installerPath));
  if (found.error) { dialog.showErrorBox('Install update', found.error); return; }
  const lib = releaseLib();
  const pkg = lib.checkUpdatePackage({ installerPath, manifestPath: found.manifestPath, publicKeyPem: lib.readPublicKey(root), requireSignature: app.isPackaged,
    currentVersion: appVersion(), product: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name });
  if (!pkg.ok) { dialog.showErrorBox('This update cannot be installed', pkg.reason); return; }
  pendingUpdate = { ...pkg, installerPath, manifestPath: found.manifestPath };
  showUpdate();
}

function showUpdate() {
  if (updateWin && !updateWin.isDestroyed()) { updateWin.focus(); return; }
  const file = path.join(app.getPath('userData'), 'update.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, updater.FORM_HTML);
  const w = bridgeWindow({ width: 640, height: 760, title: 'B-Pharma LIMS – install update' });
  const url = pathToFileURL(file).href;
  lockNavigation(w.webContents, (u) => strip(u) === url);
  w.on('closed', () => { if (updateWin === w) updateWin = null; pendingUpdate = null; });
  updateWin = w;
  w.loadFile(file);
}
const fromUpdate = (e) => !!updateWin && !updateWin.isDestroyed() && e.sender === updateWin.webContents && !!e.senderFrame && e.senderFrame === e.sender.mainFrame
  && path.basename(strip(e.senderFrame.url)) === 'update.html';

ipcMain.handle('update:info', (e) => {
  if (!fromUpdate(e) || !pendingUpdate) throw new Error('Not allowed.');
  return { from: appVersion(), to: pendingUpdate.version, gitSha: pendingUpdate.gitSha, schemaVersion: pendingUpdate.schemaVersion, installer: pendingUpdate.installerName, sha256: pendingUpdate.installerSha256, signed: pendingUpdate.signed };
});
ipcMain.handle('update:install', async (e, form) => {
  if (!fromUpdate(e) || !pendingUpdate) throw new Error('Not allowed.');
  if (!form || typeof form !== 'object') return { error: 'Invalid request.' };
  for (const k of ['email', 'password', 'loginCode', 'changeReference', 'signCode']) if (form[k] !== undefined && typeof form[k] !== 'string') return { error: 'Invalid request.' };
  const pkg = pendingUpdate;
  // Copy first and check the COPY: a file on a share can be swapped between the check and the start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-update-'));
  const copy = path.join(dir, pkg.installerName);
  fs.copyFileSync(pkg.installerPath, copy);
  const lib = releaseLib();
  const again = lib.checkUpdatePackage({ installerPath: copy, manifestPath: pkg.manifestPath, publicKeyPem: lib.readPublicKey(root), requireSignature: app.isPackaged, currentVersion: appVersion() });
  if (!again.ok) return { error: again.reason };
  const r = await updater.authorise({ origin, pkg: again, form, currentVersion: appVersion() });
  if (!r.ok) { releaseEvent('SOFTWARE_UPDATE_REFUSED', { toVersion: again.version, reason: r.error }); return { error: r.error }; }
  releaseEvent('SOFTWARE_UPDATE_STARTED', { fromVersion: appVersion(), toVersion: again.version, installerSha256: again.installerSha256, changeReference: String(form.changeReference).trim(), backup: r.backupFile, updateId: r.updateId });
  require('child_process').spawn(copy, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 500);
  return { ok: true, backup: r.backupFile };
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = win || setupWin; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(async () => {
    if (!checkIntegrity()) {
      const files = integrity.errors.slice(0, 12).map(x => `${x.kind}: ${x.file}${x.detail ? ' (' + x.detail + ')' : ''}`).join('\n');
      const more = integrity.errors.length > 12 ? `\n… and ${integrity.errors.length - 12} more` : '';
      if (!(process.env.LIMS_INTEGRITY_NO_DIALOG === '1' && !app.isPackaged)) {
        dialog.showErrorBox('B-Pharma LIMS cannot start', `The installed files do not match the release manifest, so the application was not started.\nContact your administrator and reinstall from the validated installer.\n\n${files}${more}\n\nLog: ${path.join(logDir(), 'release-events.jsonl')}`);
      }
      return app.quit();
    }
    installPermissionHandlers();
    buildMenu();
    const c = loadConfig();
    if (!c) return showSetup();
    try {
      if (c.mode === 'embedded') {
        const disk = pgs.checkDisk(app.getPath('userData'), minFreeMb(false) * 1048576);
        if (!disk.ok) dialog.showErrorBox('B-Pharma LIMS: low disk space', disk.message + '\nFree up space soon: a full disk stops the database.');
        await startPostgres(c);
      }
      openMain(await startServer(c));
    } catch (e) { dialog.showErrorBox('B-Pharma LIMS', e.message); showSetup(); }
  });
  // Quit order: the server first, then the database, and only then exit (no postgres.exe is left behind).
  app.on('before-quit', (e) => {
    if (quitState === 2) return;
    e.preventDefault();
    if (quitState === 1) return;
    quitState = 1;
    (async () => {
      try { await supervisor?.stop(); } catch { /* exiting */ }
      try { await pgSup?.stop(); } catch { /* exiting */ }
      quitState = 2; app.quit();
    })();
  });
  app.on('window-all-closed', () => app.quit());
}
