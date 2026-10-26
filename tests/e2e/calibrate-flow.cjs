// Calibrating an instrument with an electronic signature, in a real browser (roadmap M37).
// QA opens Equipment & Calibration, signs a calibration with a new due date; a wrong password is refused on screen and records nothing;
// an Analyst is not offered the action; the signature, the audit entry and the new due date are in the database.
const { psql, q, check, newPage, signIn, sign, run, RUN } = require('./lib.cjs');

run(async (browser) => {
  const id = `INST-K-${RUN}`;
  const old = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const next = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  psql(`INSERT INTO instruments (id, name, type, status, calibration_due_date, last_calibration_date) VALUES ('${id}', ${q('Kalibrator ' + RUN)}, 'pH Meter', 'Active', '${old}', '2026-01-01')`);

  const analyst = await newPage(browser);
  await signIn(analyst, 'analyst1@gxp.com', '#/instruments');
  await analyst.waitForSelector(`text=${id}`);
  check('K1 an Analyst sees the instrument but is not offered the calibration', await analyst.locator('button:has-text("Log Cal")').count() === 0);

  const page = await newPage(browser);
  await signIn(page, 'qa@gxp.com', '#/instruments');
  // the nearest ancestor of this instrument's heading that also holds a "Log Cal" button is its card header
  const card = page.locator(`xpath=(//h3[normalize-space()="${id}"]/ancestor::div[.//button[contains(., "Log Cal")]])[last()]`);
  await card.waitFor();
  await card.locator('button:has-text("Log Cal")').click();
  await page.waitForSelector('[role=dialog]');
  await page.locator('[role=dialog] input[type=date]').fill(next);

  const versionBefore = psql(`SELECT version FROM instruments WHERE id = '${id}'`);
  await sign(page, { password: 'wrong-password' });
  const message = page.locator('[role=dialog] .bg-red-50.border-red-200 .font-medium').first();
  const shown = await message.waitFor({ timeout: 8000 }).then(() => message.innerText(), () => '');
  check('K2 a wrong password is refused on the screen with the server\'s message and nothing is recorded', /password|credential|invalid|incorrect/i.test(shown) && psql(`SELECT version FROM instruments WHERE id = '${id}'`) === versionBefore && psql(`SELECT calibration_due_date::text FROM instruments WHERE id = '${id}'`).startsWith(old), shown);

  await page.locator('[role=dialog] input[type=password]').fill('password');
  await page.locator('[role=dialog] button[type=submit]').click();
  const toast = await page.waitForSelector('text=Calibration signed and recorded', { timeout: 10000 }).then(() => true, () => false);
  const dueNow = psql(`SELECT calibration_due_date::text FROM instruments WHERE id = '${id}'`);
  check('K3 the signed calibration is recorded: the new due date is stored and the screen says so', toast && dueNow.startsWith(next), { toast, dueNow });
  const sig = psql(`SELECT meaning_code || '|' || signer_role || '|' || record_version FROM signatures WHERE entity_type = 'Instrument' AND entity_id = '${id}'`);
  check('K4 one signature with the CALIBRATION meaning by QA, bound to the new record version', sig === `CALIBRATION|QA|${psql(`SELECT version FROM instruments WHERE id = '${id}'`)}`, sig);
  check('K5 the audit trail has the calibration, in the same step', Number(psql(`SELECT count(*) FROM audit_trail WHERE entity = 'Instrument' AND entity_id = '${id}' AND action ILIKE '%calibrat%'`)) >= 1);
  check('K6 no uncaught exception', page.errors.length === 0 && analyst.errors.length === 0, [...page.errors, ...analyst.errors]);
});
