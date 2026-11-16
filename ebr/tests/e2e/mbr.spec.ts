import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PW = 'e2e password long enough';
async function signIn(page: Page, username: string, code?: string) {
  await page.goto('/');
  await page.getByLabel('User name').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  if (code) await page.getByLabel('Authenticator code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Signed in as')).toBeVisible();
}
async function go(page: Page, title: string, project: string) {
  const nav = project === 'tablet' ? page.getByRole('navigation', { name: 'Main (bottom)' }) : page.getByRole('navigation', { name: 'Main', exact: true });
  await nav.getByRole('button', { name: title, exact: true }).click();
}
function totpNow() {
  const key = Buffer.from('12345678901234567890'), msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1]! & 15;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}

// E08#3: the designer works at both viewports; E08#2 and E09#1 through the interface
test('a supervisor designs a recipe, the server refuses a bad formula, QA approves and makes it effective', async ({ page, browser }, info) => {
  const code = `PCM-${info.project.name}`;
  await signIn(page, 'e2e-supervisor');
  await go(page, 'Recipes (MBR)', info.project.name);
  await page.getByRole('button', { name: 'New master batch record' }).click();
  await page.getByLabel('Recipe code *').fill(code);
  await page.getByLabel('Product *').fill(`Paracetamol 500 mg (${info.project.name})`);
  await page.getByLabel('Phase name').fill('Granulation');
  const addStep = async (type: string) => { await page.getByLabel('Step type').selectOption({ label: type }); await page.getByRole('button', { name: 'Add step' }).click(); };
  await addStep('Recorded value');
  await page.locator('#s-0-0').getByLabel('Step name').fill('Water added');
  await page.locator('#s-0-0').getByLabel('Unit').fill('L');
  await page.locator('#s-0-0').getByLabel('Lower limit').fill('10');
  await page.locator('#s-0-0').getByLabel('Upper limit').fill('14');
  await addStep('Calculation');
  await page.locator('#s-0-1').getByLabel('Step name').fill('Water per kg');
  await page.locator('#s-0-1').getByLabel('Formula (for example water / 60)').fill('water_volume / 60');
  await page.getByRole('button', { name: 'Create as draft' }).click();
  await expect(page.getByRole('alert')).toContainText('uses water_volume, which is not a data or calculation step before this one');
  await page.locator('#s-0-1').getByLabel('Formula (for example water / 60)').fill('water_added / 60');
  await page.getByRole('button', { name: 'Create as draft' }).click();
  const card = page.getByRole('region', { name: `${code} · Paracetamol 500 mg (${info.project.name})` });
  await expect(card.getByText(/Version 1 · draft/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await card.getByLabel('Your password (signature)').fill(PW);
  await card.getByRole('button', { name: 'Sign as author and send to QA' }).click();
  await expect(card.getByText(/Version 1 · in review/)).toBeVisible();

  const qa = await browser.newPage({ viewport: page.viewportSize()! });
  await signIn(qa, 'e2e-qa', totpNow());
  await go(qa, 'Recipes (MBR)', info.project.name);
  const qaCard = qa.getByRole('region', { name: `${code} · Paracetamol 500 mg (${info.project.name})` });
  await qaCard.getByRole('form', { name: 'Approve (QA) version 1' }).getByLabel('Your password (signature)').fill(PW);
  await qaCard.getByRole('button', { name: 'Approve (QA)' }).click();
  await expect(qaCard.getByText(/Version 1 · approved/)).toBeVisible();
  await qaCard.getByLabel('Your password (signature)').fill(PW);
  await qaCard.getByRole('button', { name: 'Make effective' }).click();
  await expect(qaCard.getByText(/Version 1 · effective · by e2e-supervisor · approved by e2e-qa/)).toBeVisible();
  await qa.close();
});
