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
/** RFC 6238 code of the seeded QA secret (base32 GEZDGNBV... = "1234567890" x 2). */
function totpNow() {
  const key = Buffer.from('12345678901234567890'), msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1]! & 15;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}

test('an operator writes a signed cleaning entry and the status follows (E06#2, E07#1)', async ({ page }, info) => {
  await signIn(page, 'e2e-operator');
  await go(page, 'Logbooks', info.project.name);
  await page.getByRole('button', { name: new RegExp(`MIX-E2E-${info.project.name}`) }).click();
  await expect(page.getByText('Dirty').first()).toBeVisible();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Kind of entry').selectOption({ label: 'Cleaning' });
  await page.getByLabel('Cleaning type *').selectOption('major');
  await page.getByLabel('Cleaning agent and lot').fill('Detergent D lot 22');
  await page.getByLabel('Your password (signature) *').fill('not my password');
  await page.getByRole('button', { name: 'Sign and save' }).click();
  await expect(page.getByRole('alert')).toContainText('The password is not correct. Nothing was signed.');
  await page.getByLabel('Your password (signature) *').fill(PW);
  await page.getByRole('button', { name: 'Sign and save' }).click();
  await expect(page.getByRole('list', { name: 'Entries' }).getByText('Cleaning')).toBeVisible();
  await expect(page.getByText('Clean', { exact: true })).toBeVisible();
  await expect(page.getByText(/E2E Operator · performed/)).toBeVisible();
});

test('a value outside its limits needs a comment and is shown as outside limits (E21#4)', async ({ page }, info) => {
  await signIn(page, 'e2e-operator');
  await go(page, 'Logbooks', info.project.name);
  await page.getByRole('button', { name: new RegExp(`RM-E2E-${info.project.name}`) }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Kind of entry').selectOption({ label: 'Temperature and humidity' });
  await page.getByLabel('Temperature (°C) *').fill('27.5');
  await page.getByLabel('Relative humidity (%) *').fill('45');
  await page.getByLabel('Your password (signature) *').fill(PW);
  await page.getByRole('button', { name: 'Sign and save' }).click();
  await expect(page.getByRole('alert')).toContainText('a comment is required');
  await page.getByLabel('Comment').fill('air handling unit stopped, engineering called');
  await page.getByRole('button', { name: 'Sign and save' }).click();
  await expect(page.getByText(/Outside limits: Temperature 27.5 °C is outside 15 to 25 °C/)).toBeVisible();
});

test('a supervisor creates a new logbook type and QA approves it, without any code (E21#1, E21#2)', async ({ page, browser }, info) => {
  const code = `balance-${info.project.name}`;
  await signIn(page, 'e2e-supervisor');
  await go(page, 'Logbook types', info.project.name);
  await page.getByRole('button', { name: 'New logbook type' }).click();
  await page.getByLabel('Code *').fill(code);
  await page.getByLabel('Name *').fill(`Balance daily check ${info.project.name}`);
  await page.getByLabel('Name of the entry kind').fill('Daily check');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Field label').fill('Reading of 100 g weight');
  await page.getByLabel('Type', { exact: true }).selectOption('number');
  await page.getByLabel('Unit').fill('g');
  await page.getByLabel('Lower limit').fill('99.98');
  await page.getByLabel('Upper limit').fill('100.02');
  await page.getByRole('button', { name: 'Create as draft' }).click();
  const card = page.getByRole('region', { name: `Balance daily check ${info.project.name}` });
  await expect(card.getByText(/Version 1 · draft/)).toBeVisible();
  await card.getByLabel('Your password (signature)').fill(PW);
  await card.getByRole('button', { name: 'Sign as author and send to QA' }).click();
  await expect(card.getByText(/Version 1 · in review/)).toBeVisible();

  const qa = await browser.newPage({ viewport: page.viewportSize()! });
  await signIn(qa, 'e2e-qa', totpNow());
  await go(qa, 'Logbook types', info.project.name);
  const qaCard = qa.getByRole('region', { name: `Balance daily check ${info.project.name}` });
  await qaCard.getByRole('form', { name: 'Approve (QA) version 1' }).getByLabel('Your password (signature)').fill(PW);
  await qaCard.getByRole('button', { name: 'Approve (QA)' }).click();
  await expect(qaCard.getByText(/Version 1 · effective · by e2e-supervisor · approved by e2e-qa/)).toBeVisible();
  await qa.close();
});

test('the logbook screens fit the screen and keep 44 px targets', async ({ page }, info) => {
  await signIn(page, 'e2e-operator');
  await go(page, 'Logbooks', info.project.name);
  await page.getByRole('button', { name: new RegExp(`MIX-E2E-${info.project.name}`) }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const small = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input:not([type=radio]):not([type=checkbox]), select')]
    .filter(e => (e as HTMLElement).offsetParent !== null).map(e => e.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).length);
  expect(small).toBe(0);
});
