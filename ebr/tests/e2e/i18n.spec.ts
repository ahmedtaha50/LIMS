import { expect, type Page, test } from '@playwright/test';
import { PW, totpNow } from './support/api.js';

// E26: every screen in Arabic, right to left, at tablet and desktop size; the choice is kept with the account.
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')]
  .filter(e => (e as HTMLElement).offsetParent !== null)
  .map(e => ({ what: e.outerHTML.slice(0, 80), r: e.getBoundingClientRect() }))
  .filter(x => x.r.width < 44 || x.r.height < 44).map(x => `${x.what} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`));
/** Phrases of the interface that must not be left on an Arabic screen. Data (recipe and product names, codes, units)
 *  may be Latin, so only phrases that are the interface's own are looked for. */
const ENGLISH = /(Loading…|Sign out|New batch|New entry|New logbook type|New master batch record|Version \d|Your password|Sign and save|Start a new version|Make effective|No batch yet|No logbook yet|Batches to review|Each change needs|Test the connection|Default value|Receive a lot|New material|calibration due|open exception)/;
/** Signs in from the (English) sign-in page; the account's own language comes after. */
async function signInAny(page: Page, user: string) {
  await page.goto('/');
  await page.getByLabel(/User name|اسم المستخدم/).fill(user);
  await page.getByLabel(/^(Password|كلمة المرور)$/).fill(PW);
  await page.getByLabel(/Authenticator code|رمز تطبيق المصادقة/).fill(totpNow());
  await page.getByRole('button', { name: /^(Sign in|تسجيل الدخول)$/ }).click();
  await expect(page.getByRole('button', { name: /^(Sign out|تسجيل الخروج)$/ })).toBeVisible();
}
const toArabic = async (page: Page) => { if (await page.getByRole('button', { name: 'العربية' }).isVisible()) await page.getByRole('button', { name: 'العربية' }).click(); await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); };
const nav = (page: Page, project: string) => project === 'tablet' ? page.getByRole('navigation', { name: 'القائمة الرئيسية (أسفل الشاشة)' }) : page.getByRole('navigation', { name: 'القائمة الرئيسية', exact: true });
const SCREENS = ['الرئيسية', 'التشغيلات', 'السجلات', 'أنواع السجلات', 'الوصفات (MBR)', 'المواد', 'المراجعة والإفراج', 'الإعدادات'];

test('E26#1 E26#3: a user switches to Arabic; every screen is right to left, fits, keeps 44 px targets and shows no English', async ({ page }, info) => {
  const user = `e2e-ar-${info.project.name}`;
  await signInAny(page, user);
  await toArabic(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('button', { name: 'تسجيل الخروج' })).toBeVisible();
  for (const name of SCREENS) {
    await nav(page, info.project.name).getByRole('button', { name, exact: true }).click();
    await expect(page.getByText('جارٍ التحميل…')).toHaveCount(0);
    expect(await noHorizontalScroll(page), name).toBe(true);
    expect(await smallTargets(page), name).toEqual([]);
    const text = await page.locator('main').innerText();
    expect(text.match(ENGLISH)?.[0] ?? null, `${name}: ${text.slice(0, 200)}`).toBeNull();
    expect(text, name).toMatch(/[؀-ۿ]/);
  }
  // the header and the side or bottom menu are mirrored: the brand is at the right edge in Arabic
  const brand = await page.getByText('بي فارما EBR', { exact: true }).boundingBox();
  expect(brand!.x + brand!.width).toBeGreaterThan((page.viewportSize()!.width) * 0.6);
});

test('E26#1: the language is kept with the account: after a reload, and after signing in again from an English page', async ({ page }, info) => {
  const user = `e2e-ar-${info.project.name}`;
  await signInAny(page, user);
  await toArabic(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'تسجيل الخروج' })).toBeVisible();
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.goto('/');                                          // a new page: the browser asks for English
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('User name').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByLabel('Authenticator code').fill(totpNow());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'تسجيل الخروج' })).toBeVisible();      // the account's language
  await page.getByRole('button', { name: 'English' }).click();                          // back to English for the next runs
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});
