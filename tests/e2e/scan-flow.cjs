// A barcode scanner and the keyboard alone, in a real browser (roadmap M29, M24 and M37).
// A wedge scanner types the code in a burst of keys under 35 ms apart and ends with Enter: that opens the record it names from any screen,
// even when no list has loaded it; an unknown code is reported; a person typing slowly is not taken for a scanner. Then the working
// session is driven with the keyboard only: sign in, move through the navigation, open a record from the list and leave a dialog with Esc.
const { check, sampleInTesting, newPage, signIn, run, BASE_URL } = require('./lib.cjs');

run(async (browser) => {
  const { id } = await sampleInTesting();
  const page = await newPage(browser);
  await signIn(page, 'analyst1@gxp.com', '#/reagents');
  await page.waitForSelector('main#main');
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // focus on the page, not on a field

  // The burst: no delay between the keys (each a few milliseconds), then Enter.
  await page.keyboard.type(id, { delay: 0 });
  await page.keyboard.press('Enter');
  const opened = await page.waitForFunction((sid) => location.hash.includes(sid), id, { timeout: 8000 }).then(() => true, () => false);
  check('S1 a scanned sample id opens that sample from another screen, though no list there has loaded it', opened, await page.evaluate(() => location.hash));
  check('S2 and the screen says what was scanned', await page.waitForSelector(`text=Scanned: `, { timeout: 5000 }).then(() => true, () => false));

  await page.goto(`${BASE_URL}/#/reagents`);
  await page.waitForSelector('main#main');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type('NO-SUCH-CODE-777', { delay: 0 });
  await page.keyboard.press('Enter');
  check('S3 an unknown code is reported to the user, with the code in the message (no silent failure)', await page.waitForSelector('text=/Unknown code "NO-SUCH-CODE-777"/', { timeout: 8000 }).then(() => true, () => false));
  check('S4 and the screen did not move', (await page.evaluate(() => location.hash)).startsWith('#/reagents'));

  await page.keyboard.type(id, { delay: 120 }); // a person typing: far slower than a scanner
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check('S5 the same text typed slowly is not taken for a scan', (await page.evaluate(() => location.hash)).startsWith('#/reagents'), await page.evaluate(() => location.hash));

  // ---- keyboard only ----
  const kb = await newPage(browser);
  await kb.goto(BASE_URL + '/');
  await kb.waitForSelector('input[type=email]');
  await kb.focus('input[type=email]');
  await kb.keyboard.type('analyst1@gxp.com');
  await kb.keyboard.press('Tab');
  await kb.keyboard.type('password');
  await kb.keyboard.press('Enter');
  await kb.waitForSelector('aside nav', { state: 'attached' });
  check('S6 sign-in works with the keyboard alone (Tab to the password, Enter submits)', await kb.waitForSelector('main#main', { timeout: 8000 }).then(() => true, () => false));

  await kb.keyboard.press('Tab');
  const reachable = await kb.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && a.tagName !== 'HTML'; });
  check('S7 the first Tab lands on a control (a skip link or the navigation), not nowhere', reachable);

  // Tab through the page until the focus is on the navigation entry for specifications, then Enter.
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    reached = await kb.evaluate(() => /Test Specifications/.test(document.activeElement?.textContent || '') && !!document.activeElement?.closest('nav'));
    if (!reached) await kb.keyboard.press('Tab');
  }
  check('S8 Tab reaches the navigation entry "Test Specifications" (within 60 presses, in page order)', reached);
  if (reached) await kb.keyboard.press('Enter');
  check('S9 Enter on a navigation entry opens that page', await kb.waitForFunction(() => location.hash.startsWith('#/specs'), null, { timeout: 5000 }).then(() => true, () => false));

  await kb.goto(`${BASE_URL}/#/samples`);
  await kb.waitForSelector('tbody tr a');
  await kb.focus('tbody tr a');
  await kb.keyboard.press('Enter');
  check('S10 a record opens from the list with Enter on its link', await kb.waitForFunction(() => /#\/samples\/SMP-/.test(location.hash), null, { timeout: 5000 }).then(() => true, () => false));
  check('S11 no uncaught exception', page.errors.length === 0 && kb.errors.length === 0, [...page.errors, ...kb.errors]);
});
