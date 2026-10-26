// A deviation through the quality screen in a real browser (roadmap M27 and M37): an Analyst raises it, QA triages and classifies it, the
// server refuses the approval until a root cause is recorded (the reason is shown in the signature dialog), then QA approves it with an
// electronic signature. A refused step shows the server's message; a change control offers its own fields.
const { psql, check, newPage, signIn, run, RUN } = require('./lib.cjs');

const submitSignature = async (page, password = 'password') => {
  await page.waitForSelector('[role=dialog] input[type=password]');
  await page.fill('[role=dialog] input[type=password]', password);
  const reason = page.locator('[role=dialog] textarea');
  if (await reason.count()) await reason.last().fill('Closure accepted by the quality unit');
  await page.locator('[role=dialog] input[type=checkbox]').last().check();
  await page.locator('[role=dialog] button[type=submit]').last().click();
};

run(async (browser) => {
  const title = `E2E pH meter used past calibration ${RUN}`;
  const analyst = await newPage(browser);
  await signIn(analyst, 'analyst1@gxp.com', '#/qms');
  await analyst.waitForSelector('text=Quality management');
  await analyst.click('button:has-text("Raise")');
  await analyst.fill('input[placeholder="Title"]', title);
  await analyst.locator('form[aria-label="Raise a quality record"] button[type=submit]').click();
  await analyst.waitForSelector('text=raised (audit logged)');
  const id = (await analyst.locator('header .font-mono').first().innerText()).trim();
  check('Q1 an Analyst raises a deviation: the screen confirms it and shows the record number', /^DEV-\d{4}-\d{4}$/.test(id), id);

  await analyst.getByRole('button', { name: 'QA Triage', exact: true }).click();
  await analyst.waitForSelector('text=moved to QA Triage');
  check('Q2 the Analyst can send it to triage but is not offered the quality unit\'s next step', await analyst.getByRole('button', { name: 'Investigation', exact: true }).count() === 0);

  await analyst.selectOption('select[aria-label="Target type"]', 'Sample');
  await analyst.fill('input[aria-label="Target id"]', 'SMP-DOES-NOT-EXIST');
  await analyst.locator('form[aria-label="Add a link"] button[type=submit]').click();
  check('Q3 a link the server refuses shows the server\'s message', await analyst.waitForSelector('text=There is no Sample SMP-DOES-NOT-EXIST').then(() => true, () => false));

  const qa = await newPage(browser);
  await signIn(qa, 'qa@gxp.com', `#/qms/${id}`);
  await qa.waitForSelector(`text=${id}`);
  await qa.selectOption('form[aria-label="Edit the record"] select[aria-label="Classification"]', 'Minor');
  await qa.click('form[aria-label="Edit the record"] button:has-text("Save")');
  await qa.waitForSelector('text=saved (audit logged)');
  await qa.getByRole('button', { name: 'Investigation', exact: true }).click();
  await qa.waitForSelector('text=moved to Investigation');
  await qa.getByRole('button', { name: 'QA Approved (sign)' }).click();
  await submitSignature(qa);
  const refusal = await qa.waitForSelector('text=has no root cause recorded', { timeout: 10000 }).then(() => true, () => false);
  check('Q4 approving without a root cause is refused by the server and the reason is shown in the signature dialog', refusal);
  check('Q5 the refused approval left no signature behind', psql(`SELECT count(*) FROM signatures WHERE entity_id = '${id}'`) === '0');

  await qa.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await qa.waitForSelector('input[type=password]', { state: 'detached' });
  const versionOf = async () => Number(((await qa.locator('header:has(.font-mono)').first().innerText()).match(/version (\d+)/) || [])[1]);
  const before = await versionOf();
  await qa.locator('label:has-text("Root cause") textarea').fill('Calibration reminder not configured for the pH meter');
  await qa.click('form[aria-label="Edit the record"] button:has-text("Save")');
  // the screen reloads the record before it lets a signature through: wait for the new version, not for a toast that is already there
  await qa.waitForFunction((v) => Number((document.querySelector('header .font-mono')?.closest('header')?.innerText.match(/version (\d+)/) || [])[1]) > v, before);
  const beforeApproval = await versionOf();
  await qa.getByRole('button', { name: 'QA Approved (sign)' }).click();
  await submitSignature(qa);
  const signed = await qa.waitForSelector('text=QA Approved, signed (audit logged)', { timeout: 10000 }).then(() => true, () => false);
  await qa.waitForFunction((v) => Number((document.querySelector('header .font-mono')?.closest('header')?.innerText.match(/version (\d+)/) || [])[1]) > v, beforeApproval, { timeout: 10000 }).catch(() => {}); // the screen has reloaded the record
  const sigs = psql(`SELECT count(*) FROM signatures WHERE entity_id = '${id}' AND signer_role = 'QA'`);
  check('Q6 with the root cause recorded, QA\'s signature is accepted and stored for the record', signed && sigs === '1', { signed, sigs });
  const state = psql(`SELECT state FROM qms_records WHERE id = '${id}'`);
  check('Q7 the record has moved on in the database after the signed approval', state !== 'Investigation' && state !== 'Draft', state);

  // closing is a second signature, and a closed record is locked
  const closeButton = qa.getByRole('button', { name: /^Closed.*\(sign\)/ });
  const offered = await closeButton.waitFor({ timeout: 10000 }).then(() => true, () => false);
  if (offered) {
    await closeButton.click();
    await submitSignature(qa);
    await qa.waitForSelector('text=Closed, signed (audit logged)', { timeout: 10000 }).catch(() => {});
  }
  const closed = psql(`SELECT state FROM qms_records WHERE id = '${id}'`);
  check('Q8 QA closes the approved record with a second signature, and the database says Closed', offered && closed === 'Closed' && psql(`SELECT count(*) FROM signatures WHERE entity_id = '${id}'`) === '2', { offered, closed });
  check('Q9 a closed record offers no further move', offered && await qa.getByRole('button', { name: /\(sign\)$/ }).count() === 0);

  await qa.click('button:has-text("Raise")');
  await qa.selectOption('form[aria-label="Raise a quality record"] select[aria-label="Type"]', 'ChangeControl');
  await qa.fill('input[placeholder="Title"]', `E2E new HPLC column supplier ${RUN}`);
  await qa.locator('form[aria-label="Raise a quality record"] button[type=submit]').click();
  await qa.waitForSelector('label:has-text("Emergency change")', { timeout: 10000 }).catch(() => {}); // the earlier "raised" toast may still be on screen: wait for the new record's own fields
  check('Q10 a change control offers its change type and the emergency flag', await qa.locator('label:has-text("Emergency change") input[type=checkbox]').count() === 1 && await qa.locator('label:has-text("Change type") select').count() === 1);
  check('Q11 no uncaught exception', analyst.errors.length === 0 && qa.errors.length === 0, [...analyst.errors, ...qa.errors]);
});
