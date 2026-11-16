import { expect, test } from '@playwright/test';
import { PW, asUser, go, newBatch, signIn } from './support/api.js';

test('dispensing on the tablet: an expired lot is refused, the right lot is weighed, then yield and reconciliation (E12)', async ({ page, baseURL }, info) => {
  const vp = info.project.name, number = `B-DISP-${vp}`;
  const sup = await asUser(baseURL!, 'e2e-supervisor');
  await newBatch(sup, `E2E-DISP-${vp}`, number);
  await signIn(page, 'e2e-operator');
  await go(page, 'Batches', vp);
  await page.getByRole('button', { name: new RegExp(number) }).click();
  const step = page.getByRole('form', { name: 'Current step' });
  await expect(step.getByText(/Dispense 10 kg of RM-E2E/)).toBeVisible();
  await step.getByLabel('Lot number *').fill('E2E-LOT-OLD');
  await step.getByLabel('Weight (kg) *').fill('10.02');
  await step.getByLabel('Your password (signature) *').fill(PW);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(step.getByRole('alert')).toHaveText('Lot E2E-LOT-OLD expired on 2020-01-31: it cannot be used.');
  await step.getByLabel('Lot number *').fill('E2E-LOT-OK');
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(page.getByRole('list', { name: 'Steps' }).getByText(/✓ 10.02 kg/)).toBeVisible();
  await page.close();

  const sp = await page.context().browser()!.newPage({ viewport: page.viewportSize()! });
  await signIn(sp, 'e2e-supervisor');
  await go(sp, 'Batches', vp);
  await sp.getByRole('button', { name: new RegExp(number) }).click();
  const rec = sp.getByRole('form', { name: 'Reconciliation' });
  await rec.getByLabel(/Output quantity/).fill('9.9');
  await rec.getByLabel('Your password (signature)').fill(PW);
  await rec.getByRole('button', { name: 'Sign the reconciliation' }).click();
  await expect(sp.getByText('Reconciled: yield 99%.')).toBeVisible();
  await sp.getByRole('form', { name: 'Close the batch' }).getByLabel('Your password (signature)').fill(PW);
  await sp.getByRole('button', { name: 'Close the batch' }).click();
  await expect(sp.getByText(/· completed ·/)).toBeVisible();
  await sp.close();
});
