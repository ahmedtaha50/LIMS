import { expect, test } from '@playwright/test';
import { PW, asUser, go, signIn, totpNow, newBatch } from './support/api.js';

test('QA reviews the exceptions only, completes the review, releases, and gets the certified copy (E14, E15)', async ({ page, baseURL }, info) => {
  const vp = info.project.name, number = `B-REV-${vp}`;
  const sup = await asUser(baseURL!, 'e2e-supervisor'), op = await asUser(baseURL!, 'e2e-operator');
  const b = await newBatch(sup, `E2E-REV-${vp}`, number);
  const recorded = await op.post(`/api/batches/${b.id}/steps/${b.steps[0]!.id}/record`, { data: { version: b.steps[0]!.version, input: { value: 7.6 }, comment: 'probe checked, value confirmed', password: PW } });
  const after = await recorded.json();
  await sup.post(`/api/batches/${b.id}/exceptions/${after.exceptions[0].id}/deviation`, { data: { version: 1, deviationNumber: `DEV-E2E-${vp}`, password: PW } });
  const v = (await (await sup.get(`/api/batches/${b.id}`)).json()).version;
  expect((await sup.post(`/api/batches/${b.id}/complete`, { data: { version: v, password: PW } })).status()).toBe(200);

  await signIn(page, 'e2e-qa', totpNow());
  await go(page, 'Review & release', vp);
  await page.getByRole('button', { name: new RegExp(number) }).click();
  await page.getByRole('button', { name: 'Start the review' }).click();
  await expect(page.getByText(/pH: 7.6 pH is outside 6 to 7 pH.*Deviation DEV-E2E-/)).toBeVisible();
  const item = page.getByRole('form', { name: /^Reviewed/ });
  await item.getByLabel('Assessment').fill('within the deviation, no impact');
  await item.getByLabel('Your password (signature)').fill(PW);
  await item.getByRole('button', { name: /^Reviewed/ }).click();
  await expect(page.getByText(/Reviewed by e2e-qa: within the deviation/)).toBeVisible();
  await page.getByRole('form', { name: 'Complete the review' }).getByLabel('Your password (signature)').fill(PW);
  await page.getByRole('button', { name: 'Complete the review' }).click();
  await page.getByRole('form', { name: 'Release the batch' }).getByLabel('Your password (signature)').fill(PW);
  await page.getByRole('button', { name: 'Release the batch' }).click();
  await expect(page.getByText(/RELEASED by e2e-qa/)).toBeVisible();
  const pdf = await page.request.get(`/api/batches/${b.id}/certified-copy`);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).toString('latin1')).toContain(`RELEASED by e2e-qa`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
