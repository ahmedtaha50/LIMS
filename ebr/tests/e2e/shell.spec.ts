import { expect, test, type Page } from '@playwright/test';

const ME = { userId: 'u1', username: 'operator1', displayName: 'Operator One', permissions: ['session'] };
/** Layout tests stand in for the sign-in API (r1-identity builds it); the offline test uses the real server. */
async function signedIn(page: Page) {
  await page.route('**/api/auth/me', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
  await page.goto('/');
  await expect(page.getByLabel('Signed in as')).toHaveText('Operator One');
}
async function signedOut(page: Page) {
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"unauthenticated","message":"Sign in first."}' }));
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')]
  .filter(e => (e as HTMLElement).offsetParent !== null)
  .map(e => ({ what: e.outerHTML.slice(0, 80), r: e.getBoundingClientRect() }))
  .filter(x => x.r.width < 44 || x.r.height < 44).map(x => `${x.what} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`));

test('E05#1: sign-in fits the screen without horizontal scroll', async ({ page }) => {
  await signedOut(page);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('E05#1: the signed-in shell and its navigation fit the screen', async ({ page }, info) => {
  await signedIn(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  const nav = info.project.name === 'tablet' ? page.getByRole('navigation', { name: 'Main (bottom)' }) : page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Today' })).toBeVisible();
});

test('E05#2: every control is at least 44 x 44 px and reachable by keyboard', async ({ page }) => {
  await signedOut(page);
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('User name')).toBeFocused();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  await page.unroute('**/api/auth/me');
  await signedIn(page);
  expect(await smallTargets(page)).toEqual([]);
});

test('E05#3: installable (manifest), but with the network off a sign-in fails visibly and nothing is stored on the device', async ({ page, context }) => {
  await signedOut(page);
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).display).toBe('standalone');
  await context.setOffline(true);
  await page.getByLabel('User name').fill('operator1');
  await page.getByLabel('Password').fill('a password of twelve');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Nothing was saved');
  const stored = await page.evaluate(async () => ({
    local: localStorage.length, session: sessionStorage.length,
    idb: (await indexedDB.databases()).length,
    apiCached: (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).filter(r => new URL(r.url).pathname.startsWith('/api/')).length))).reduce((a, b) => a + b, 0),
  }));
  expect(stored).toEqual({ local: 0, session: 0, idb: 0, apiCached: 0 });
  await context.setOffline(false);
});

test('the server answers the page for any client route and never caches it', async ({ page }) => {
  const r = await page.request.get('/logbooks/some-deep-link');
  expect(r.status()).toBe(200);
  expect(r.headers()['cache-control']).toBe('no-cache');
  expect(await r.text()).toContain('<div id="root">');
  const api = await page.request.get('/api/health');
  expect(api.headers()['cache-control']).toBe('no-store');
});
