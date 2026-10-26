// Shared helpers of the browser flows (roadmap M37). Each flow is a stand-alone script that talks to a running, seeded server (BASE_URL)
// and prints one line per check, "PASS <id> <text>" or "FAIL <id> <text> :: <detail>", exactly like tests/client-shell.cjs and
// tests/ui-foundation.cjs; tests/e2e/run.cjs provisions the database and the server and collects the lines as evidence.
//
// Env: BASE_URL (the server), SQL_HOST / SQL_USER / SQL_PASSWORD / SQL_DB_NAME (the server's database, to arrange rows and to read what the
//      browser wrote), ADMIN_EMAIL / ADMIN_PASSWORD (the demo administrator), PLAYWRIGHT_PATH, PLAYWRIGHT_BROWSERS_PATH.
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function playwrightPath() {
  if (process.env.PLAYWRIGHT_PATH) return process.env.PLAYWRIGHT_PATH;
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { return require.resolve(p, { paths: [path.join(__dirname, '..', '..')] }); } catch { if (fs.existsSync(p)) return p; } }
  throw new Error('Playwright is not installed: npm install --no-save playwright && npx playwright install chromium (or set PLAYWRIGHT_PATH).');
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
const { chromium } = require(playwrightPath());

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims', db: process.env.SQL_DB_NAME };
if (!SQL.db) { console.error('SQL_DB_NAME is required (the database the server at BASE_URL uses).'); process.exit(2); }
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@gxp.com', password: process.env.ADMIN_PASSWORD || 'password' };
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const psql = (sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, SQL.db, '-qAtc', sql], { env: { ...process.env, PGPASSWORD: SQL.password }, encoding: 'utf8' }).trim();
const q = (s) => `$q$${s}$q$`;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`); };
const info = (text) => console.log(`INFO ${text}`);

async function api(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE_URL}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const tokenOf = async (email, password = 'password') => {
  const r = await api('/auth/login-local', { method: 'POST', body: { email, password } });
  if (r.status !== 200 || !r.body.token) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
};

const launch = () => chromium.launch({ args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] });
async function newPage(browser, { width = 1400, height = 900, acceptDownloads = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|status of 40[0-9]|status of 409|status of 423/.test(m.text())) page.errors.push('console: ' + m.text()); });
  return page;
}
/** Signs in through the real form and waits for the shell. `hash` is where to land (e.g. '#/samples'). */
async function signIn(page, email, hash = '', password = 'password') {
  await page.goto(BASE_URL + '/' + hash);
  await page.waitForSelector('input[type=email]');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('aside nav', { state: 'attached' });
}
/** The signature dialog: the password, the acknowledgement, submit. Returns the dialog text before submitting. */
async function sign(page, { password = 'password', reason, meaning } = {}) {
  const dialog = page.locator('[role=dialog]').last();
  await dialog.waitFor();
  // the catalogue meaning is fetched after the dialog opens: wait for it when the caller names it
  if (meaning) await page.waitForFunction((m) => [...document.querySelectorAll('[role=dialog]')].pop()?.innerText.includes(m), meaning, { timeout: 8000 }).catch(() => {});
  const text = await dialog.innerText();
  await dialog.locator('input[type=password]').fill(password);
  const area = dialog.locator('textarea');
  if (reason && await area.count()) await area.fill(reason);
  const box = dialog.locator('input[type=checkbox]');
  if (await box.count()) await box.last().check();
  await dialog.locator('button[type=submit]').click();
  return text;
}

/** Runs a flow: opens a browser, runs `fn`, prints the summary line, exits 1 on a failed check and 2 on a crash. */
function run(fn) {
  (async () => {
    const browser = await launch();
    try { await fn(browser); } finally { await browser.close(); }
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`);
    process.exit(failed.length ? 1 : 0);
  })().catch(e => { console.error(e); process.exit(2); });
}

module.exports = { BASE_URL, SQL, ADMIN, RUN, psql, q, check, info, api, tokenOf, launch, newPage, signIn, sign, run, results, os };

/** A sample of a material that has an Active specification, registered by the analyst, received (testing needs a receipt, M29) and submitted to Testing. */
async function sampleInTesting({ material, who = 'analyst1@gxp.com' } = {}) {
  const token = await tokenOf(who);
  const mat = material || psql(`SELECT s.material FROM specifications s WHERE s.status = 'Active' ORDER BY s.material LIMIT 1`);
  const created = await api('/samples', { method: 'POST', token, body: { material: mat, batch: `E2E-${RUN}-${Math.random().toString(36).slice(2, 6)}` } });
  if (created.status !== 200) throw new Error(`register ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  const rec = await api(`/custody/samples/${id}/receipt`, { method: 'POST', token, body: { condition: 'Intact', sealIntact: true, requiredStorage: 'Ambient', quantity: 100, unit: 'g' } });
  if (rec.status !== 200 && rec.status !== 201) throw new Error(`receipt ${rec.status} ${JSON.stringify(rec.body)}`);
  const sub = await api(`/samples/${id}/transition`, { method: 'POST', token, body: { action: 'submit', expectedVersion: 1 } });
  if (sub.status !== 200) throw new Error(`submit ${sub.status} ${JSON.stringify(sub.body)}`);
  return { id, material: mat, token };
}
module.exports.sampleInTesting = sampleInTesting;

/** A sample taken through the whole workflow to Approved: results entered by the analyst at the middle of their limits, signed for review by the analyst, approved by the reviewer. */
async function approvedSample(opts = {}) {
  const s = await sampleInTesting(opts);
  const rows = psql(`SELECT id || '|' || version || '|' || round(((coalesce(spec_min,0)+coalesce(spec_max,0))/2)::numeric,4) FROM results WHERE sample_id = '${s.id}' ORDER BY id`).split('\n').filter(Boolean);
  for (const row of rows) {
    const [rid, version, value] = row.split('|');
    const put = await api(`/samples/${s.id}/results/${rid}`, { method: 'PUT', token: s.token, body: { value, reason: 'routine entry', expectedVersion: Number(version) } });
    if (put.status !== 200) throw new Error(`result ${rid}: ${put.status} ${JSON.stringify(put.body)}`);
  }
  const version = () => Number(psql(`SELECT version FROM samples WHERE id = '${s.id}'`));
  const review = await api(`/samples/${s.id}/transition`, { method: 'POST', token: s.token, body: { action: 'review', expectedVersion: version(), password: 'password' } });
  if (review.status !== 200) throw new Error(`review ${review.status} ${JSON.stringify(review.body)}`);
  const reviewer = await tokenOf('reviewer@gxp.com');
  const approve = await api(`/samples/${s.id}/transition`, { method: 'POST', token: reviewer, body: { action: 'approve', expectedVersion: version(), password: 'password', reason: 'ok' } });
  if (approve.status !== 200) throw new Error(`approve ${approve.status} ${JSON.stringify(approve.body)}`);
  return s;
}
module.exports.approvedSample = approvedSample;
