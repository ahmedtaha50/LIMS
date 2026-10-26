// A Certificate of Analysis from the sample screen in a real browser (roadmap M25 and M37): QA signs the issue with the catalogue meaning,
// the original PDF is made and verified, a controlled copy downloads as a PDF, re-issue is offered; a sample still in Testing has no
// certificate panel; an Analyst gets no signing action. The browser composes no certificate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { psql, check, newPage, signIn, sign, approvedSample, sampleInTesting, run } = require('./lib.cjs');

run(async (browser) => {
  const approved = await approvedSample();
  const page = await newPage(browser);
  await signIn(page, 'qa@gxp.com', `#/samples/${approved.id}`);
  await page.waitForSelector('section[aria-label="Certificate of Analysis"]');
  check('C1 the sample screen of an Approved sample has no browser-made certificate button', await page.locator('text=Download CoA').count() === 0);

  await page.getByRole('button', { name: 'Issue certificate (sign)' }).click();
  const dialogText = await sign(page, { meaning: 'Authorisation of Certificate of Analysis' });
  check('C2 the signature dialog shows the catalogue meaning of the certificate and the issue is signed', /Authorisation of Certificate of Analysis/.test(dialogText));
  const issued = await page.waitForSelector('text=/COA-\\d{4}-\\d{4}-v1 issued/', { timeout: 15000 }).then(() => true, () => false);
  check('C3 the screen reports the certificate number it was given', issued);
  const ready = await page.waitForSelector('text=The original PDF is ready.', { timeout: 40000 }).then(() => true, () => false);
  check('C4 the original PDF is made by the job and reported ready', ready);
  const doc = psql(`SELECT d.label || '|' || d.status || '|' || (d.pdf_sha256 = r.pdf_sha256) FROM coa_documents d JOIN report_runs r ON r.document_id = d.id AND r.purpose = 'Original' WHERE d.sample_id = '${approved.id}'`);
  check('C5 the register holds the issued certificate, and the hash of its stored PDF is the one recorded with it', /^COA-\d{4}-\d{4}-v1\|Issued\|true$/.test(doc), doc);

  await page.getByRole('button', { name: 'Verify original' }).click();
  check('C6 verifying the original reports the document intact', await page.waitForSelector('text=are intact', { timeout: 15000 }).then(() => true, () => false));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Controlled copy (PDF)' }).click()]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-')), 'copy.pdf');
  await download.saveAs(file);
  check('C7 a controlled copy downloads as a PDF', fs.readFileSync(file).subarray(0, 5).toString() === '%PDF-', download.suggestedFilename());
  check('C8 re-issue is offered for the current certificate', await page.getByRole('button', { name: 'Re-issue (sign)' }).count() === 1);

  const testing = await sampleInTesting();
  await page.goto(page.url().replace(/#\/samples\/.*/, `#/samples/${testing.id}`));
  await page.waitForSelector(`text=${testing.id}`);
  await page.waitForTimeout(800);
  check('C9 a sample still in Testing has no certificate panel', await page.locator('section[aria-label="Certificate of Analysis"]').count() === 0);

  const analyst = await newPage(browser);
  await signIn(analyst, 'analyst2@gxp.com', `#/samples/${approved.id}`);
  await analyst.waitForSelector('section[aria-label="Certificate of Analysis"]');
  await analyst.waitForTimeout(500);
  check('C10 an Analyst sees the panel but is offered no signing action', await analyst.locator('text=(sign)').count() === 0);
  check('C11 no uncaught exception', page.errors.length === 0 && analyst.errors.length === 0, [...page.errors, ...analyst.errors]);
});
