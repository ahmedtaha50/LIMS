// Drives the real client (the built bundle in a real Chromium) against a running, initialised server and checks roadmap M06
// (r1-client-shell): the acceptance criteria and the defects the review named. The data layer behind it is covered, without a browser, by
// tests/api/client-session.test.ts; the screens' markup by tests/unit/client. What only a browser can show is here:
//   * the idle lock over a half-typed form (the typed value is still there and the save then succeeds),
//   * the client idle timer and its 60 s warning (a fake clock jumps forward; no test waits 15 minutes),
//   * a token that dies under a mounted Dashboard or Reagents view: an inline "Session expired" state, never a white screen,
//   * TOTP sign-in with a real token, the forced password change, logout that ends the session on the server, an Arabic name.
//
// Needs: a server that serves the bundle under test (see docs/changes/r1-client-shell.md), PostgreSQL access for arranging users and
// for expiring sessions the way time would, and Playwright with Chromium.
// Usage:  BASE_URL=http://127.0.0.1:3108 SQL_HOST=127.0.0.1 SQL_USER=lims SQL_PASSWORD=lims SQL_DB_NAME=<the server's database> node tests/client-shell.cjs
// Env:    ADMIN_EMAIL / ADMIN_PASSWORD  an existing account whose password the script knows (default: the installer-test administrator);
//         its password hash is copied to the users the script creates.   PLAYWRIGHT_PATH   (default /opt/node-tools/node_modules/playwright)
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3108';
const SQL = { host: process.env.SQL_HOST || '127.0.0.1', user: process.env.SQL_USER || 'lims', password: process.env.SQL_PASSWORD || 'lims', db: process.env.SQL_DB_NAME };
const KNOWN_EMAIL = process.env.ADMIN_EMAIL || 'bootstrap@example.invalid';
const PASSWORD = process.env.ADMIN_PASSWORD || 'bootstrap-password-123';
const NEW_PASSWORD = 'Zq7!velvet-Harbor-2026';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RUN = Date.now().toString(36);
if (!SQL.db) { console.error('SQL_DB_NAME is required (the database the server at BASE_URL uses).'); process.exit(2); }

const psql = (sql) => execFileSync('psql', ['-h', SQL.host, '-U', SQL.user, SQL.db, '-qAtc', sql], { env: { ...process.env, PGPASSWORD: SQL.password }, encoding: 'utf8' }).trim();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let seq = 0;
function makeUser({ name, role = 'Analyst', mustChange = false, totp = false }) {
  const n = ++seq;
  const id = `usr-cs-${RUN}-${n}`;
  const email = `cs.${RUN}.${n}@gxp.test`;
  psql(`INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training, must_change_password, totp_secret, totp_enabled)
        SELECT '${id}', 'uid-${id}', $q$${name}$q$, '${role}', '${email}', password_hash, true, ${mustChange}, ${totp ? `'${TOTP_SECRET}'` : 'NULL'}, ${totp}
        FROM users WHERE lower(email) = lower('${KNOWN_EMAIL}')`);
  return { id, email, name };
}
const sessionsOf = (userId) => psql(`SELECT id FROM sessions WHERE user_id = '${userId}' AND revoked_at IS NULL ORDER BY created_at DESC`).split('\n').filter(Boolean);
const makeIdle = (userId) => psql(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = '${userId}' AND revoked_at IS NULL`);
const revoke = (userId) => psql(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'browser test' WHERE user_id = '${userId}' AND revoked_at IS NULL`);

async function newPage(browser, { clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  // A 401 on a dead session is the situation under test, so the browser's own "Failed to load resource" line for it is expected.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push('console: ' + m.text()); });
  if (clock) await page.clock.install();
  return page;
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
async function signIn(page, email, password = PASSWORD) {
  await page.goto(BASE_URL + '/');
  await page.waitForSelector('input[type=email]');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
}
async function reachApp(page, ms = 7000) {
  try { await page.waitForSelector('text=Sample Management', { timeout: ms }); return true; } catch { return false; }
}
const storage = (page) => page.evaluate(() => ({ session: sessionStorage.getItem('gxp_token'), local: localStorage.getItem('gxp_token') }));
const blank = (page) => page.evaluate(() => document.getElementById('root') ? document.getElementById('root').children.length === 0 || document.body.innerText.trim().length === 0 : true);

// ONLY=C,E runs just those scenarios (A..H).
async function scenario(name, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name[0])) return;
  try { await fn(); } catch (e) { check(`${name}: scenario completed`, false, String(e.message).split('\n')[0]); }
}

(async () => {
  const { generateSync } = await import('otplib');
  const code = (steps = 0) => generateSync({ secret: TOTP_SECRET, epoch: Math.floor(Date.now() / 1000) + steps * 30 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---- A. sign in, the shell, reload -------------------------------------------------------------------------------------------
  await scenario('A', async () => {
    const analyst = makeUser({ name: 'CS Analyst' });
    const page = await newPage(browser);
    await signIn(page, analyst.email);
    const entered = await reachApp(page);
    check('A1 an Analyst signs in and reaches the application', entered);
    const st = await storage(page);
    check('A2 the token is in sessionStorage as a real JWT, and not in localStorage', st.session && st.session.split('.').length === 3 && st.session !== 'undefined' && st.local === null, st);
    const text = await bodyText(page);
    check('A3 the user shown is the server\'s (GET /auth/me)', text.includes('CS Analyst') && text.includes('Analyst'));
    check('A4 no static "Validated" or "Compliant" badge anywhere on the screen', !/Validated|Compliant/.test(text), text.match(/.{0,30}(Validated|Compliant).{0,30}/)?.[0]);
    await page.click('text=Test Specifications');
    check('A5 the header shows the page title ("Test Specifications"), not the view id ("specs")', (await page.locator('header h2').innerText()).trim() === 'Test Specifications');
    await page.reload();
    check('A6 a reload keeps the session (sessionStorage) and shows the application, not the sign-in', await reachApp(page) || (await bodyText(page)).includes('Test Specifications'));
    check('A7 no uncaught exception', page.errors.length === 0, page.errors);

    // logout ends the session on the server
    const before = sessionsOf(analyst.id).length;
    await page.click('text=Sign Out');
    await page.waitForSelector('input[type=email]');
    check('A8 Sign Out returns to the sign-in screen', true);
    check('A9 and the session is ended on the server (the old call carried no Authorization header)', before >= 1 && sessionsOf(analyst.id).length === 0, { before, after: sessionsOf(analyst.id).length });
    check('A10 the token is gone from sessionStorage', (await storage(page)).session === null);
    await page.context().close();
  });

  // ---- B. Arabic name ------------------------------------------------------------------------------------------------------------
  await scenario('B', async () => {
    const u = makeUser({ name: 'أحمد الطاهر' });
    const page = await newPage(browser);
    await signIn(page, u.email);
    await reachApp(page);
    await page.reload(); // the old build rebuilt the user from the token payload with atob on every reload
    await reachApp(page);
    const side = await page.locator('aside').innerText();
    check('B1 an Arabic name is shown correctly after a reload (atob of the token payload turned it into mojibake)', side.includes('أحمد الطاهر'), side.slice(0, 120));
    await page.context().close();
  });

  // ---- C. idle lock over a half-typed form ---------------------------------------------------------------------------------------
  await scenario('C', async () => {
    const material = `CS-Material-${RUN}`;
    psql(`INSERT INTO specifications (id, material, version, effective_date, status, parameters) VALUES ('SPEC-CS-${RUN}', '${material}', 1, '2026-01-01', 'Active', '[{"name":"Assay (%)","min":98,"max":102}]'::jsonb)`);
    const u = makeUser({ name: 'CS Idle' });
    const page = await newPage(browser);
    await signIn(page, u.email);
    await reachApp(page);
    await page.fill('input[placeholder="Material Name"]', material);
    await page.fill('input[placeholder="Batch Number"]', `B-${RUN}`);
    makeIdle(u.id); // the server's idle clock has run out, as it does when the form was open for a long time
    await page.click('text=Register Sample');
    let dialog = false;
    try { await page.waitForSelector('[role=dialog] input[name=password]'); dialog = true; } catch {}
    check('C1 mid-edit, the idle session shows the re-authentication dialog (the page is not replaced)', dialog);
    const kept = await page.evaluate(() => [document.querySelector('input[placeholder="Material Name"]')?.value, document.querySelector('input[placeholder="Batch Number"]')?.value]);
    check('C2 the typed values are still in the form behind the dialog', kept[0] === material && kept[1] === `B-${RUN}`, kept);
    check('C3 the page behind the dialog cannot be used while it is locked (inert: nothing behind it can take the focus)', await page.evaluate(() => {
      const behind = document.querySelector('aside nav button');
      behind.focus();
      return !!document.querySelector('[inert]') && document.activeElement !== behind;
    }));
    check('C4 the dialog says unlocking signs nothing', /does not sign/i.test(await page.locator('[role=dialog]').innerText()));

    await page.fill('[role=dialog] input[name=password]', 'wrong-password-123');
    await page.click('[role=dialog] button[type=submit]');
    await page.waitForSelector('[role=dialog] [role=alert]');
    check('C5 a wrong password is refused inline and the page stays locked', await page.locator('[role=dialog]').count() === 1);

    await page.fill('[role=dialog] input[name=password]', PASSWORD);
    await page.click('[role=dialog] button[type=submit]');
    let saved = false;
    try { await page.waitForSelector('text=Sample Registered', { timeout: 8000 }); saved = true; } catch {}
    check('C6 after unlocking, the save succeeds without typing it again', saved);
    check('C7 exactly one sample was created (not lost, not duplicated)', psql(`SELECT count(*) FROM samples WHERE material = '${material}'`) === '1');
    check('C8 the dialog is gone and the form was reset by the successful save', await page.locator('[role=dialog]').count() === 0 && (await page.inputValue('input[placeholder="Material Name"]')) === '');
    check('C9 the same server session continues (re-authentication does not start a new one)', sessionsOf(u.id).length === 1);
    check('C10 the unlock is in the security log', Number(psql(`SELECT count(*) FROM security_events WHERE actor_id = '${u.id}' AND event_type = 'AUTH_REAUTH'`)) >= 1);

    // the same on a result entry: open the sample, correct a result (a first value is arranged in SQL: the screen asks for a reason
    // only when there is a value to correct), expire, save
    psql(`UPDATE results SET value = '98.7' WHERE sample_id IN (SELECT id FROM samples WHERE material = '${material}')`);
    await page.click(`text=${material}`);
    await page.waitForSelector('tbody tr td:last-child button');
    await page.locator('tbody tr td:last-child button').first().click();
    await page.fill('input.border-blue-500', '99.5');
    await page.fill('input[placeholder="Document scientific justification..."]', 'Re-integration of the chromatogram');
    makeIdle(u.id);
    await page.locator('button.bg-blue-100').click();
    await page.waitForSelector('[role=dialog] input[name=password]');
    const typed = await page.inputValue('input.border-blue-500');
    const reasonKept = await page.inputValue('input[placeholder="Document scientific justification..."]');
    check('C11 a result being corrected, with its reason, survives the lock', typed === '99.5' && reasonKept === 'Re-integration of the chromatogram', { typed, reasonKept });
    await page.fill('[role=dialog] input[name=password]', PASSWORD);
    await page.click('[role=dialog] button[type=submit]');
    let resultSaved = false;
    try { await page.waitForSelector('text=Result saved successfully', { timeout: 8000 }); resultSaved = true; } catch {}
    check('C12 and the result is saved after unlocking', resultSaved);
    check('C13 the value is in the database', psql(`SELECT count(*) FROM results r JOIN samples s ON s.id = r.sample_id WHERE s.material = '${material}' AND r.value = '99.5'`) === '1');
    check('C14 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- D. client idle timer ------------------------------------------------------------------------------------------------------
  await scenario('D', async () => {
    const u = makeUser({ name: 'CS Timer' });
    const page = await newPage(browser, { clock: true });
    await signIn(page, u.email);
    await reachApp(page);
    const minutes = Number(psql("SELECT coalesce((SELECT session_timeout_minutes FROM system_settings WHERE id = 'default'), 15)"));
    await page.clock.fastForward((minutes - 1) * 60 * 1000 + 5000);
    let warned = false;
    try { await page.waitForSelector('[role=alertdialog]'); warned = true; } catch {}
    check('D1 one minute before the limit a warning with a countdown appears', warned);
    check('D2 the countdown is a number of seconds up to 60', /\b([1-5]?\d|60)\b/.test(warned ? await page.locator('[role=alertdialog]').innerText() : ''));
    await page.click('text=Stay signed in');
    let closed = false;
    try { await page.waitForSelector('[role=alertdialog]', { state: 'detached' }); closed = true; } catch {}
    check('D3 "Stay signed in" closes the warning', closed);
    await page.clock.fastForward((minutes) * 60 * 1000 + 5000);
    let locked = false;
    try { await page.waitForSelector('[role=dialog] input[name=password]'); locked = true; } catch {}
    check('D4 with no activity until the limit, the screen locks and asks for the password', locked);
    check('D5 the locked dialog names inactivity as the reason', locked && /inactivity/i.test(await page.locator('[role=dialog]').innerText()));
    await page.fill('[role=dialog] input[name=password]', PASSWORD);
    await page.click('[role=dialog] button[type=submit]');
    await page.waitForSelector('[role=dialog]', { state: 'detached' });
    check('D6 unlocking brings the same page back', await reachApp(page, 3000));
    check('D7 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- E. a session that ended under a mounted view -----------------------------------------------------------------------------
  for (const [name, from, to, label] of [['Dashboard', 'Sample Management', 'Dashboard & Metrics', 'E1'], ['Reagents', 'Sample Management', 'Reagents & Standards', 'E2']]) {
    await scenario(label, async () => {
      const u = makeUser({ name: 'CS Expiry' });
      const page = await newPage(browser);
      await signIn(page, u.email);
      await reachApp(page);
      revoke(u.id); // logout elsewhere, password change, deactivation: the token is dead
      await page.click(`text=${to}`);
      let expired = false;
      try { await page.waitForSelector('text=Session expired', { timeout: 5000 }); expired = true; } catch {}
      check(`${label}a ${name}: a dead token shows an inline "Session expired" state`, expired);
      check(`${label}b ${name}: never a white screen (the page still has content and the shell)`, !(await blank(page)) && (await bodyText(page)).includes('Sign Out'));
      check(`${label}c ${name}: no uncaught exception`, page.errors.length === 0, page.errors);
      if (expired) {
        await page.click('button:has-text("Sign in again")');
        await page.waitForSelector('input[type=email]');
        check(`${label}d ${name}: "Sign in again" leads to the sign-in screen`, true);
        check(`${label}e ${name}: the dead token is no longer stored`, (await storage(page)).session === null);
      }
      await page.context().close();
    });
  }

  // ---- E3. a view that crashes for a reason that is not the session -----------------------------------------------------------------
  await scenario('E3', async () => {
    const u = makeUser({ name: 'CS Crash' });
    const page = await newPage(browser);
    await page.route('**/api/dashboard', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"error":"unexpected shape"}' }));
    await signIn(page, u.email);
    await reachApp(page);
    await page.click('text=Dashboard & Metrics');
    let shown = false;
    try { await page.waitForSelector('text=This page could not be displayed'); shown = true; } catch {}
    check('E3a a view that throws while rendering shows a message and a retry, inside the shell', shown && (await bodyText(page)).includes('Sign Out') && (await bodyText(page)).includes('Try again'));
    check('E3b it is not reported as an ended session', !(await bodyText(page)).includes('Session expired'));
    await page.click('text=Samples & Testing');
    check('E3c opening another page gives a fresh start (the boundary resets with the view)', await reachApp(page, 4000));
    check('E3d no uncaught exception escaped the boundary', !page.errors.some(e => e.startsWith('pageerror')), page.errors);
    await page.context().close();
  });

  // ---- F. TOTP -------------------------------------------------------------------------------------------------------------------
  await scenario('F', async () => {
    const u = makeUser({ name: 'CS Totp', totp: true });
    const page = await newPage(browser);
    await signIn(page, u.email);
    await page.waitForSelector('input[name=code]');
    check('F1 a TOTP user is asked for the authenticator code', /Authenticator code/i.test(await bodyText(page)));
    await page.fill('input[name=code]', '000000');
    await page.click('button[type=submit]');
    await page.waitForSelector('[role=alert]');
    check('F2 a wrong code is shown as an error on the screen, not silently', /invalid/i.test(await page.locator('[role=alert]').first().innerText()));
    await page.fill('input[name=code]', code());
    await page.click('button[type=submit]');
    check('F3 the right code reaches the application', await reachApp(page));
    const st = await storage(page);
    check('F4 with a real token (not the string "undefined")', st.session && st.session !== 'undefined' && st.session.split('.').length === 3, st);
    check('F5 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- G. forced password change ---------------------------------------------------------------------------------------------------
  await scenario('G', async () => {
    const u = makeUser({ name: 'CS Temp', mustChange: true });
    const page = await newPage(browser);
    await signIn(page, u.email);
    await page.waitForSelector('input[name=newPassword]');
    check('G1 a temporary password leads to the change-password screen, not to the application', /must change your password/i.test(await bodyText(page)) && !(await bodyText(page)).includes('Sample Management'));
    await page.fill('input[name=currentPassword]', PASSWORD);
    await page.fill('input[name=newPassword]', 'short');
    await page.fill('input[name=confirmPassword]', 'short');
    await page.click('button[type=submit]');
    await page.waitForSelector('[role=alert]');
    check('G2 a password the policy refuses is explained on the screen', /at least 8 characters/i.test(await page.locator('[role=alert]').first().innerText()));
    await page.fill('input[name=newPassword]', NEW_PASSWORD);
    await page.fill('input[name=confirmPassword]', 'something-else-entirely');
    await page.click('button[type=submit]');
    check('G3 a confirmation that does not match is refused before anything is sent', /match/i.test(await page.locator('[role=alert]').first().innerText()));
    await page.fill('input[name=confirmPassword]', NEW_PASSWORD);
    await page.click('button[type=submit]');
    check('G4 a good new password continues into the application', await reachApp(page, 9000));
    check('G5 the flag is cleared in the database', psql(`SELECT must_change_password FROM users WHERE id = '${u.id}'`) === 'f');
    check('G6 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  // ---- H. nothing is left of the old behaviour in the page the user receives ----------------------------------------------------------
  await scenario('H', async () => {
    const page = await newPage(browser);
    await page.goto(BASE_URL + '/');
    await page.waitForSelector('input[type=email]');
    const text = await bodyText(page);
    check('H1 the sign-in screen claims no compliance or validation state', !/Compliant|Validated/.test(text), text);
    await page.evaluate(() => { localStorage.setItem('gxp_token', 'old.token.value'); });
    await page.reload();
    await page.waitForSelector('input[type=email]');
    check('H2 a token an older build left in localStorage is removed and never used', (await storage(page)).local === null);
    await page.evaluate(() => sessionStorage.setItem('gxp_token', 'not.a.token'));
    await page.reload();
    await page.waitForSelector('input[type=email]');
    check('H3 a stored token the server refuses ends at the sign-in screen with a notice', /session/i.test(await bodyText(page)) && (await storage(page)).session === null, await bodyText(page));
    check('H4 no uncaught exception', page.errors.length === 0, page.errors);
    await page.context().close();
  });

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} PASS, ${failed.length} FAIL`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
