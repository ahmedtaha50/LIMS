// Drives the real client (the built bundle in Chromium) against a running, initialised server and checks roadmap M24 (r2-ui-foundation):
//   * a pasted #/samples/<id> opens that sample; Back, Forward and reload keep the view (hash router)
//   * sort, filter and page survive a reload; the search is the server's; 50 000 samples render page 1 in under a second; long pages are virtual
//   * every dialog of the foundation traps the focus, closes on Esc and returns the focus; the drawer below lg; bench mode 44 px
//   * the export downloads a file whose sha256 is the one shown and the one in the audit trail
//   * a QA inbox excludes the records the QA officer entered
//   * axe (serious and critical violations) on 8 key screens
//
// Needs: a server that serves the bundle under test, PostgreSQL access to arrange rows, Playwright with Chromium, and axe-core.
// Usage:  BASE_URL=http://127.0.0.1:3100 SQL_DB_NAME=<the server's database> AXE_PATH=<.../axe-core/axe.min.js> node tests/ui-foundation.cjs
// Env:    ADMIN_EMAIL / ADMIN_PASSWORD  an account whose password the script knows; its hash is copied to the users the script creates.
//         PLAYWRIGHT_PATH (default /opt/node-tools/node_modules/playwright)   ONLY=D,G runs some scenarios   SCALE=0 skips the 50 000 rows
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims', db: process.env.SQL_DB_NAME };
const KNOWN_EMAIL = process.env.ADMIN_EMAIL || 'bootstrap@example.invalid';
const PASSWORD = process.env.ADMIN_PASSWORD || 'bootstrap-password-123';
const AXE_PATH = process.env.AXE_PATH;
const RUN = Date.now().toString(36);
if (!SQL.db) { console.error('SQL_DB_NAME is required (the database the server at BASE_URL uses).'); process.exit(2); }

const psql = (sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, SQL.db, '-qAtc', sql], { env: { ...process.env, PGPASSWORD: SQL.password }, encoding: 'utf8' }).trim();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`); };
const info = (text) => console.log(`INFO ${text}`);

let seq = 0;
function makeUser({ name, role = 'Analyst' }) {
  const n = ++seq;
  const id = `usr-uf-${RUN}-${n}`;
  const email = `uf.${RUN}.${n}@gxp.test`;
  psql(`INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training)
        SELECT '${id}', 'uid-${id}', $q$${name}$q$, '${role}', '${email}', password_hash, true FROM users WHERE lower(email) = lower('${KNOWN_EMAIL}')`);
  return { id, email, name };
}

async function newPage(browser, { width = 1400, height = 900, bypassCSP = false } = {}) {
  // bypassCSP only for the axe scan: axe is injected as a script, which the application's CSP (script-src 'self') rightly refuses.
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, bypassCSP });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  return page;
}
async function signIn(page, email, hash = '') {
  await page.goto(BASE_URL + '/' + hash);
  await page.waitForSelector('input[type=email]');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('aside nav', { state: 'attached' }); // the shell (the sidebar is in the page, hidden below lg)
}
const hashOf = (page) => page.evaluate(() => location.hash);
const firstRowId = (page) => page.locator('tbody tr a').first().innerText();
const statusText = (page) => page.locator('main [role=status][aria-live=polite]').innerText();
const focusInDialog = (page) => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('[role=dialog]'));
async function rows(page) { await page.waitForSelector('tbody tr a'); }

async function scenario(name, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name[0])) return;
  try { await fn(); } catch (e) { check(`${name}: scenario completed`, false, String(e.message).split('\n')[0]); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const material = `UF-Material-${RUN}`;
  psql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-UF-${RUN}', '${material}', 1, '2026-01-01', 'Active', '[{"name":"Assay (%)","limit_kind":"RANGE","lower":98,"upper":102,"decimals":1,"unit":"%"}]'::jsonb)`);
  const analyst = makeUser({ name: 'UF Analyst' });
  // 240 samples of this run, registered one minute apart, cycling the states, so paging, sorting and filtering have something to show.
  psql(`INSERT INTO samples (id, material, batch, state, created_by, created_at, version)
        SELECT 'SMP-UF-${RUN}-' || lpad(g::text, 4, '0'), '${material} ' || chr(65 + g % 26), 'UFB-' || (g % 9),
               (ARRAY['Logged','Testing','Pending Review','Approved','Rejected'])[1 + g % 5], '${analyst.id}', now() - make_interval(mins => g), 1
        FROM generate_series(1, 240) g`);
  const target = `SMP-UF-${RUN}-0007`;

  // ---- D. deep link, Back, Forward, reload ---------------------------------------------------------------------------------------
  await scenario('D', async () => {
    const page = await newPage(browser);
    await signIn(page, analyst.email, `#/samples/${target}`);
    let shown = false;
    try { await page.waitForSelector(`h2:text-is("${target}")`); shown = true; } catch {}
    check('D1 a pasted #/samples/<id> opens that sample (after signing in)', shown, await hashOf(page));
    await page.reload();
    shown = false;
    try { await page.waitForSelector(`h2:text-is("${target}")`); shown = true; } catch {}
    check('D2 a reload keeps the sample open', shown && (await hashOf(page)) === `#/samples/${target}`);

    await page.click('aside nav button:has-text("Samples & Testing")');
    await rows(page);
    check('D3 the navigation changes the address', (await hashOf(page)) === '#/samples');
    await page.fill('input[type=search]', target);
    await page.waitForFunction(() => location.hash.includes('q='));
    await page.waitForSelector(`tbody tr a:text-is("${target}")`);
    await page.click(`tbody tr a:text-is("${target}")`);
    await page.waitForSelector(`h2:text-is("${target}")`);
    check('D4 a row opens the sample at its own address', (await hashOf(page)) === `#/samples/${target}`);
    await page.goBack();
    await rows(page);
    check('D5 Back returns to the list with the search it had', (await hashOf(page)).includes(`q=${encodeURIComponent(target)}`) && (await page.inputValue('input[type=search]')) === target, await hashOf(page));
    await page.goForward();
    shown = false;
    try { await page.waitForSelector(`h2:text-is("${target}")`); shown = true; } catch {}
    check('D6 Forward opens the sample again', shown);
    await page.click('main button:has(svg.lucide-arrow-left)');
    await rows(page);
    check('D7 the detail page\'s own back button returns to the same list address', (await hashOf(page)).includes('q='), await hashOf(page));
    await page.goto(BASE_URL + '/#/nowhere');
    check('D8 an unknown address says so inside the shell (no blank page)', await page.locator('text=There is no page at this address').count() === 1);
    check('D9 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- G. the grid: server-side search, filter, sort, paging, all in the URL ---------------------------------------------------------
  await scenario('G', async () => {
    const page = await newPage(browser);
    await signIn(page, analyst.email, '#/samples');
    await rows(page);
    const oldest = `SMP-UF-${RUN}-0240`;
    await page.fill('input[type=search]', `${RUN}-0240`);
    let found = false;
    try { await page.waitForSelector(`tbody tr a:text-is("${oldest}")`); found = true; } catch {}
    check('G1 the search is the server\'s: it finds a sample that is not on the first page', found);
    await page.fill('input[type=search]', material);
    await page.waitForFunction((m) => decodeURIComponent(location.hash.replace(/\+/g, ' ')).includes(m), material);
    await page.selectOption('main label:has-text("State") select', 'Testing'); // r3-i18n: the header now holds the language select, so the first select of main is not the state filter
    await page.waitForFunction(() => location.hash.includes('state=Testing'));
    await page.click('th button:has-text("Product / Material")');
    await page.waitForFunction(() => location.hash.includes('sort=material'));
    await page.selectOption('main label:has-text("Rows per page") select', '25');
    await page.waitForFunction(() => location.hash.includes('limit=25'));
    await page.waitForFunction(() => !document.querySelector('main [aria-busy=true]'));
    const total = Number(psql(`SELECT count(*) FROM samples WHERE state = 'Testing' AND material ILIKE '%${material}%'`));
    const expectFirst = psql(`SELECT id FROM samples WHERE state = 'Testing' AND material ILIKE '%${material}%' ORDER BY material ASC, id ASC OFFSET 25 LIMIT 1`);
    await page.click('main button:has-text("Next")');
    await page.waitForFunction(() => location.hash.includes('after='));
    // The hash changes before React renders the new address, so "not busy" alone can still be the old page: wait for page 2.
    try { await page.waitForFunction(() => /^26-/.test(document.querySelector('main [role=status][aria-live=polite]')?.textContent ?? '')); } catch {}
    const before ={ hash: await hashOf(page), first: await firstRowId(page), status: await statusText(page) };
    check('G2 page 2, sorted by material, filtered to Testing, is the database\'s page 2', before.first === expectFirst && before.status.includes(`26-${Math.min(50, total)} of ${total}`), { before, expectFirst, total });
    await page.reload();
    await rows(page);
    await page.waitForFunction(() => !document.querySelector('main [aria-busy=true]'));
    const after = { hash: await hashOf(page), first: await firstRowId(page), status: await statusText(page) };
    check('G3 sort, filter, page size and page survive a reload', JSON.stringify(after) === JSON.stringify(before), { before, after });
    check('G4 the controls show the state from the address after the reload', (await page.inputValue('input[type=search]')) === material
      && (await page.inputValue('main label:has-text("State") select')) === 'Testing'
      && (await page.getAttribute('th:has-text("Product / Material")', 'aria-sort')) === 'ascending');
    await page.click('main button:has-text("Previous")');
    // Wait for the new page itself, not only for "not busy": the click re-renders before the request starts.
    let back = false;
    try { await page.waitForFunction(() => /^1-25 of/.test(document.querySelector('main [role=status][aria-live=polite]')?.textContent ?? '')); back = true; } catch {}
    check('G5 Previous returns to page 1', back, await statusText(page));
    await page.fill('input[type=search]', `no-such-thing-${RUN}`);
    await page.waitForSelector('text=No samples match the search or filters.');
    check('G6 an empty result says that nothing matches (not "no samples")', true);
    await page.click('main button:has-text("Clear filters") >> nth=0');
    await rows(page);
    check('G7 Clear filters returns to the whole list', !(await hashOf(page)).includes('state=') && !(await hashOf(page)).includes('q='));
    await page.goto(BASE_URL + `/#/samples?q=${encodeURIComponent(material)}&limit=200`);
    await rows(page);
    await page.waitForFunction(() => !document.querySelector('main [aria-busy=true]'));
    const rendered = await page.locator('tbody tr a').count();
    check('G8 a 200-row page renders only the rows in view (virtual window)', rendered > 0 && rendered < 120, rendered);
    await page.locator('main div.overflow-auto').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);
    const last = await page.locator('tbody tr a').last().innerText();
    const expectedLast = psql(`SELECT id FROM samples WHERE material ILIKE '%${material}%' ORDER BY created_at DESC, id DESC OFFSET 199 LIMIT 1`);
    check('G9 scrolling to the end shows the last row of the page', last === expectedLast, { last, expectedLast });
    check('G10 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- P. 50 000 samples -----------------------------------------------------------------------------------------------------------------
  await scenario('P', async () => {
    if (process.env.SCALE === '0') { info('P skipped (SCALE=0)'); return; }
    const have = Number(psql(`SELECT count(*) FROM samples`));
    if (have < 50000) {
      psql(`INSERT INTO samples (id, material, batch, state, created_by, created_at, version)
            SELECT 'SMP-UFS-${RUN}-' || lpad(g::text, 5, '0'), 'Scale material ' || (g % 97), 'SB-' || (g % 501),
                   (ARRAY['Logged','Testing','Pending Review','Approved','Rejected'])[1 + g % 5], '${analyst.id}', now() - interval '1 year' + make_interval(secs => g), 1
            FROM generate_series(1, ${50000 - have}) g`);
      psql('ANALYZE samples');
    }
    const page = await newPage(browser);
    await signIn(page, analyst.email, '#/inbox');
    const times = [];
    for (let i = 0; i < 3; i++) {
      await page.click('aside nav button:has-text("My Tasks")');
      await page.waitForSelector('text=Waiting for you');
      const t0 = Date.now();
      await page.click('aside nav button:has-text("Samples & Testing")');
      await page.waitForSelector('tbody tr a');
      await page.waitForFunction(() => /of \d/.test(document.querySelector('main [role=status][aria-live=polite]')?.textContent || ''));
      times.push(Date.now() - t0);
    }
    const total = Number(psql(`SELECT count(*) FROM samples`));
    check(`P1 with ${total} samples, page 1 of the list renders in under 1 s (${times.join(', ')} ms)`, total >= 50000 && Math.max(...times) < 1000, times);
    const t0 = Date.now();
    await page.click('th button:has-text("Batch / Lot")');
    await page.waitForFunction(() => location.hash.includes('sort=batch'));
    await page.waitForFunction(() => !document.querySelector('main [aria-busy=true]'));
    check(`P2 re-sorting 50 000 rows by batch answers in under 1 s (${Date.now() - t0} ms)`, Date.now() - t0 < 1000);
    await page.context().close();
  });

  // ---- M. dialogs: focus trap, Esc, focus return ---------------------------------------------------------------------------------------
  await scenario('M', async () => {
    const page = await newPage(browser);
    await signIn(page, analyst.email, '#/samples');
    await rows(page);
    const opener = page.locator('main button:has-text("Bulk Import")');
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role=dialog][aria-modal=true]');
    check('M1 the dialog takes the focus when it opens', await focusInDialog(page));
    let inside = true;
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); inside = inside && await focusInDialog(page); }
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Tab'); inside = inside && await focusInDialog(page); }
    check('M2 Tab and Shift+Tab stay inside the dialog (focus trap)', inside);
    check('M3 the dialog is named by its title', (await page.getAttribute('[role=dialog]', 'aria-labelledby')) && await page.evaluate(() => { const d = document.querySelector('[role=dialog]'); return document.getElementById(d.getAttribute('aria-labelledby')).textContent === 'Bulk Sample Import'; }));
    await page.keyboard.press('Escape');
    check('M4 Esc closes it', await page.locator('[role=dialog]').count() === 0);
    check('M5 and the focus returns to the button that opened it', await page.evaluate(() => document.activeElement?.textContent?.includes('Bulk Import')));

    await page.click('main button:has-text("Export")');
    await page.waitForSelector('[role=dialog]');
    check('M6 the export dialog takes the focus', await focusInDialog(page));
    await page.keyboard.press('Escape');
    check('M7 Esc closes it and the focus returns to Export', await page.locator('[role=dialog]').count() === 0 && await page.evaluate(() => document.activeElement?.textContent?.includes('Export')));
    await page.context().close();
  });

  // ---- X. export: the file, its hash, the audit entry ----------------------------------------------------------------------------------
  await scenario('X', async () => {
    const page = await newPage(browser);
    await signIn(page, analyst.email, `#/samples?q=${encodeURIComponent(material)}&state=Approved`);
    await rows(page);
    await page.click('main button:has-text("Export")');
    await page.waitForSelector('[role=dialog]');
    await page.click('[role=dialog] button[type=submit]');
    let refused = false;
    try { await page.waitForSelector('[role=dialog] [role=alert]', { timeout: 4000 }); refused = true; } catch {}
    check('X1 an export without a reason is refused with the reason shown under the field', refused);
    await page.fill('[role=dialog] input[type=text]', 'Browser check of the export');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[role=dialog] button[type=submit]')]);
    const file = await download.path();
    const bytes = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    await page.waitForSelector('[role=dialog] dd.font-mono.text-xs');
    const shown = (await page.locator('[role=dialog] dd.font-mono.text-xs').innerText()).trim();
    const expectedRows = Number(psql(`SELECT count(*) FROM samples WHERE state = 'Approved' AND (id ILIKE '%${material}%' OR material ILIKE '%${material}%' OR batch ILIKE '%${material}%')`));
    const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n').length - 1;
    const audit = psql(`SELECT user_id || '|' || new_value FROM audit_trail WHERE action = 'Export' AND entity = 'SampleList' AND reason = 'Browser check of the export' ORDER BY sequence DESC LIMIT 1`);
    const [auditUser, auditJson] = [audit.split('|')[0], JSON.parse(audit.slice(audit.indexOf('|') + 1))];
    check('X2 the file has every matching row', lines === expectedRows, { lines, expectedRows });
    check('X3 the sha256 of the downloaded file is the one the dialog shows', sha === shown, { sha, shown });
    check('X4 the audit trail records the user, the filter, the row count and the same sha256', auditUser === analyst.id && auditJson.sha256 === sha && auditJson.rowCount === expectedRows && auditJson.filter.state === 'Approved' && auditJson.filter.q === material, auditJson);
    await page.context().close();
  });

  // ---- R. narrow screen: the navigation drawer; bench mode -------------------------------------------------------------------------------
  await scenario('R', async () => {
    const page = await newPage(browser, { width: 820, height: 1000 });
    await signIn(page, analyst.email, '#/samples');
    check('R1 below lg the sidebar is hidden and a menu button is shown', !(await page.locator('aside').isVisible()) && await page.locator('button[aria-label="Open navigation"]').isVisible());
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check('R2 no horizontal page scroll at 820 px', noScroll);
    await page.click('button[aria-label="Open navigation"]');
    await page.waitForSelector('[role=dialog] nav');
    check('R3 the drawer is a modal dialog with the navigation, and takes the focus', await focusInDialog(page));
    await page.keyboard.press('Escape');
    check('R4 Esc closes the drawer and the focus returns to the menu button', await page.locator('[role=dialog]').count() === 0 && await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open navigation'));
    await page.click('button[aria-label="Open navigation"]');
    await page.click('[role=dialog] nav button:has-text("Test Specifications")');
    check('R5 choosing a page closes the drawer and opens the page', await page.locator('[role=dialog]').count() === 0 && (await hashOf(page)) === '#/specs');

    await page.click('button:has-text("Bench mode")');
    const bench = await page.evaluate(() => document.documentElement.dataset.density);
    const heights = await page.evaluate(() => Array.from(document.querySelectorAll('main button, main input, main select')).filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height));
    check('R6 bench mode makes every visible control at least 44 px high', bench === 'bench' && heights.length > 0 && Math.min(...heights) >= 44, { bench, min: Math.min(...heights) });
    check('R7 the switch says it is on (aria-pressed)', (await page.getAttribute('button:has-text("Bench mode")', 'aria-pressed')) === 'true');
    await page.reload();
    await page.waitForSelector('main#main');
    check('R8 bench mode is remembered on this computer after a reload', await page.evaluate(() => document.documentElement.dataset.density) === 'bench');
    await page.click('button:has-text("Bench mode")');
    await page.context().close();
  });

  // ---- I. the inbox is SoD-aware -------------------------------------------------------------------------------------------------------
  await scenario('I', async () => {
    const qa = makeUser({ name: 'UF QA', role: 'QA' });
    const mine = `SMP-UFI-${RUN}-QA`;
    const theirs = `SMP-UFI-${RUN}-AN`;
    psql(`INSERT INTO samples (id, material, batch, state, created_by, created_at, version) VALUES
          ('${mine}', '${material}', 'UFI', 'Pending Review', '${analyst.id}', '2000-01-01', 1), ('${theirs}', '${material}', 'UFI', 'Pending Review', '${analyst.id}', '2000-01-02', 1)`);
    psql(`INSERT INTO results (id, sample_id, parameter, value, entered_by, entered_at, version) VALUES
          ('res-ufi-${RUN}-1', '${mine}', 'Assay (%)', '99.0', '${qa.id}', now(), 1), ('res-ufi-${RUN}-2', '${theirs}', 'Assay (%)', '99.0', '${analyst.id}', now(), 1)`);
    const page = await newPage(browser);
    await signIn(page, qa.email, '#/inbox');
    await page.waitForSelector('text=Results to review');
    const text = await page.locator('main').innerText();
    check('I1 the QA inbox offers the sample an analyst entered', text.includes(theirs));
    check('I2 and leaves out the sample the QA officer entered results for', !text.includes(mine));
    check('I3 it says the order it uses (oldest first), not "urgency"', /Oldest first/.test(text) && !/urgency/i.test(text));
    await page.click(`main a:text-is("${theirs}")`);
    await page.waitForSelector(`h2:text-is("${theirs}")`);
    check('I4 an inbox item opens the record at its address', (await hashOf(page)) === `#/samples/${theirs}`);
    await page.context().close();
  });

  // ---- A. axe on 8 key screens -------------------------------------------------------------------------------------------------------------
  await scenario('A', async () => {
    if (!AXE_PATH) { check('A0 AXE_PATH is set', false, 'set AXE_PATH to axe-core/axe.min.js'); return; }
    const qa = makeUser({ name: 'UF Axe', role: 'QA' });
    const page = await newPage(browser, { bypassCSP: true });
    const scan = async (name) => {
      await page.waitForTimeout(600);
      await page.addScriptTag({ path: AXE_PATH });
      const r = await page.evaluate(async () => {
        const res = await window.axe.run(document, { resultTypes: ['violations'] });
        return res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
      });
      check(`A ${name}: no serious or critical axe violation`, r.length === 0, r);
      return r;
    };
    await page.goto(BASE_URL + '/');
    await page.waitForSelector('input[type=email]');
    await scan('sign-in');
    await page.fill('input[type=email]', qa.email);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('main#main');
    for (const [name, hash, ready] of [
      ['inbox', '#/inbox', 'text=Waiting for you'],
      ['samples list', '#/samples', 'tbody tr a'],
      ['sample detail', `#/samples/${target}`, `h2:text-is("${target}")`],
      ['specifications', '#/specs', 'main#main'],
      ['OOS investigations', '#/oos', 'main#main'],
      ['dashboard', '#/dashboard', 'main#main'],
      ['audit trail', '#/audit', 'main#main'],
    ]) {
      await page.evaluate(h => { location.hash = h; }, hash);
      await page.waitForSelector(ready);
      await scan(name);
    }
    await page.goto(BASE_URL + '/#/samples');
    await rows(page);
    await page.click('main button:has-text("Bulk Import")');
    await page.waitForSelector('[role=dialog]');
    await scan('bulk import dialog');
    await page.context().close();
  });

  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} PASS, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})();
