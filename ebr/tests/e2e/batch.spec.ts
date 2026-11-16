import { expect, test, type Page } from '@playwright/test';

const PW = 'e2e password long enough';
async function signIn(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('User name').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Signed in as')).toBeVisible();
}
const go = async (page: Page, title: string, project: string) =>
  (project === 'tablet' ? page.getByRole('navigation', { name: 'Main (bottom)' }) : page.getByRole('navigation', { name: 'Main', exact: true })).getByRole('button', { name: title, exact: true }).click();

test('a batch runs on the shop floor: steps in order, a second person verifies, a calculated value comes from the server (E10, E11)', async ({ page, browser }, info) => {
  const vp = info.project.name, number = `B-E2E-${vp}`;
  await signIn(page, 'e2e-supervisor');
  await go(page, 'Batches', vp);
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Effective recipe *').selectOption({ label: `E2E-PCM-${vp} · Paracetamol E2E ${vp} (version 1)` });
  await page.getByLabel('Batch number *').fill(number);
  await page.getByRole('button', { name: 'Create batch' }).click();
  await expect(page.getByRole('heading', { name: `${number} · Paracetamol E2E ${vp}` })).toBeVisible();

  const op = await browser.newPage({ viewport: page.viewportSize()! });
  await signIn(op, 'e2e-operator');
  await go(op, 'Batches', vp);
  await op.getByRole('button', { name: new RegExp(number) }).click();
  const step = op.getByRole('form', { name: 'Current step' });
  await expect(step.getByRole('heading', { name: 'Line clearance' })).toBeVisible();
  await step.getByLabel('Your password (signature) *').fill(PW);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(op.getByText(/Waiting: step 1 \(Line clearance\) waits for its verification by a second person/)).toBeVisible();
  // the operator who performed it cannot verify it
  await op.getByRole('form', { name: 'Verify step 1' }).getByLabel('Your password (signature)').fill(PW);
  await op.getByRole('button', { name: 'Verify step 1' }).click();
  await expect(op.getByRole('alert')).toContainText('The verifier must be a different person');

  const op2 = await browser.newPage({ viewport: page.viewportSize()! });
  await signIn(op2, 'e2e-operator2');
  await go(op2, 'Batches', vp);
  await op2.getByRole('button', { name: new RegExp(number) }).click();
  await op2.getByRole('form', { name: 'Verify step 1' }).getByLabel('Your password (signature)').fill(PW);
  await op2.getByRole('button', { name: 'Verify step 1' }).click();
  await expect(op2.getByText(/verified by E2E Operator Two/)).toBeVisible();

  await op.reload(); await go(op, 'Batches', vp); await op.getByRole('button', { name: new RegExp(number) }).click();
  await step.getByLabel('Value (L) *').fill('15.5');
  await step.getByLabel('Your password (signature) *').fill(PW);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(step.getByRole('alert')).toContainText('Water added: 15.5 L is outside 10 to 14 L. A comment is required.');
  await step.getByLabel('Comment').fill('cylinder misread, supervisor informed');
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(op.getByText('Exception: Water added: 15.5 L is outside 10 to 14 L (open)')).toBeVisible();
  await expect(step.getByText(/The server calculates/)).toBeVisible();
  await step.getByLabel('Comment').fill('follows from the water quantity');
  await step.getByLabel('Your password (signature) *').fill(PW);
  await step.getByRole('button', { name: 'Sign step' }).click();
  await expect(op.getByRole('list', { name: 'Steps' }).getByText(/✓ 0.258 L\/kg/)).toBeVisible();
  expect(await op.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await op.close(); await op2.close();
});
