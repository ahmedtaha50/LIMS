import { expect, test } from '@playwright/test';

// The real sign-in against the built server (no stand-in): r1-identity's API and r1-shell's screens together.
test('an operator signs in, sees the shell, and signs out', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('User name').fill('e2e-operator');
  await page.getByLabel('Password', { exact: true }).fill('e2e password long enough');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Signed in as')).toHaveText('E2E Operator');
  expect(await page.evaluate(() => document.cookie)).toBe('');          // the session cookie is HttpOnly: no script can read it
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password is refused with a message', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('User name').fill('e2e-operator');
  await page.getByLabel('Password', { exact: true }).fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The user name or the password is not correct.');
});

test('a first sign-in must choose a new password before anything else', async ({ page }, info) => {
  await page.goto('/');
  await page.getByLabel('User name').fill(`e2e-new-${info.project.name}`);   // one account per viewport: each changes its password once
  await page.getByLabel('Password', { exact: true }).fill('e2e password long enough');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible();
  await page.getByLabel('Current password').fill('e2e password long enough');
  await page.getByLabel('New password', { exact: true }).fill('a new password of my own');
  await page.getByLabel('New password again').fill('a new password of my own');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByLabel('Signed in as')).toHaveText(`E2E New ${info.project.name}`);
});
