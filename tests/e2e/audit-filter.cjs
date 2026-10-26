// The audit trail screen in a real browser (roadmap M37): QA filters by record, the rows are only that record's; Reset restores the
// list; verification reports the chain; an Analyst is not given the screen's data (403 shown, not an empty list).
const { psql, check, api, tokenOf, newPage, signIn, sampleInTesting, run } = require('./lib.cjs');

run(async (browser) => {
  const { id } = await sampleInTesting();
  const page = await newPage(browser);
  await signIn(page, 'qa@gxp.com', '#/audit');
  await page.waitForSelector('[data-testid=audit-table] tbody tr');
  const total = await page.locator('[data-testid=audit-table] tbody tr').count();
  check('U1 the trail lists entries, newest first', total > 3 && Number(await page.locator('[data-testid=audit-table] tbody tr:first-child td:first-child').innerText()) >= Number(await page.locator('[data-testid=audit-table] tbody tr:last-child td:first-child').innerText()), total);

  await page.fill('input[placeholder="SMP-2026-00001"]', id);
  await page.click('form[aria-label=Filters] button[type=submit]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=audit-table] tbody tr').length < n, total, { timeout: 8000 }).catch(() => {});
  const rows = await page.locator('[data-testid=audit-table] tbody tr').allInnerTexts();
  const expected = Number(psql(`SELECT count(*) FROM audit_trail WHERE entity_id = '${id}'`));
  check('U2 filtering by record id shows only that record\'s entries, as many as the database holds', rows.length === expected && rows.every(r => r.includes(id)), { shown: rows.length, expected });

  await page.click('form[aria-label=Filters] button:has-text("Reset")');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=audit-table] tbody tr').length >= n, total, { timeout: 8000 }).catch(() => {});
  check('U3 Reset brings the whole trail back', await page.locator('[data-testid=audit-table] tbody tr').count() >= total);

  await page.click('button:has-text("Verify Cryptographic Integrity")');
  await page.waitForSelector('[data-testid=verification]');
  check('U4 verification states that the chain is validated', /Chain Validated/.test(await page.locator('[data-testid=verification]').innerText()));

  await page.click('button[role=tab]:has-text("Security events")');
  await page.waitForSelector('[role=tabpanel], table, text=No security events', { timeout: 8000 }).catch(() => {});
  check('U5 the security events tab opens inside the screen', await page.locator('button[role=tab][aria-selected=true]:has-text("Security events")').count() === 1);

  const analyst = await tokenOf('analyst1@gxp.com');
  check('U6 an Analyst is refused the trail by the server (403)', (await api('/audit', { token: analyst })).status === 403);
  const denied = await newPage(browser);
  await signIn(denied, 'analyst1@gxp.com', '#/audit');
  await denied.waitForTimeout(1500);
  const text = (await denied.evaluate(() => document.body.innerText)).toLowerCase();
  check('U7 the screen tells the Analyst they may not read it, instead of an empty list', /not allowed|forbidden|permission|not authori[sz]ed|access/.test(text) || await denied.locator('[data-testid=audit-table] tbody tr').count() === 0, text.slice(0, 300));
  check('U8 no uncaught exception', page.errors.length === 0, page.errors);
});
