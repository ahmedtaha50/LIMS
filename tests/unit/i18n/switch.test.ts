/**
 * Roadmap M38 (r3-i18n): the language switch and the store behind it, rendered on the server with react-dom (no browser), like
 * tests/api/qms-ui.test.ts. The store reads localStorage and writes <html lang dir data-digits>, so both are given a stand-in here.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Storage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }
let storage: Storage;
let root: { lang: string; dir: string; dataset: Record<string, string> };

async function load() {
  vi.resetModules();
  const i18n = await import('../../../src/i18n');
  const { LanguageSwitch } = await import('../../../src/i18n/LanguageSwitch');
  const { ToastProvider } = await import('../../../src/components/ui/Toast');
  const format = await import('../../../src/lib/format');
  const render = (signedIn: boolean) => renderToStaticMarkup(React.createElement(ToastProvider, null, React.createElement(LanguageSwitch, { signedIn })));
  return { i18n, render, format };
}

beforeEach(() => {
  storage = new Storage();
  root = { lang: 'en', dir: 'ltr', dataset: {} };
  (globalThis as any).localStorage = storage;
  (globalThis as any).document = { documentElement: root };
});
afterEach(() => { delete (globalThis as any).localStorage; delete (globalThis as any).document; });

describe('the switch', () => {
  it('starts in English, left-to-right, Latin digits, with both languages offered in their own script', async () => {
    const { i18n, render } = await load();
    expect(i18n.getI18n()).toEqual({ lang: 'en', digits: 'latin', dir: 'ltr' });
    expect(root).toMatchObject({ lang: 'en', dir: 'ltr', dataset: { digits: 'latin' } });
    const html = render(false);
    expect(html).toContain('>English</option>');
    expect(html).toContain('العربية');
    expect(html).toMatch(/<option value="en"[^>]*selected|value="en"/);
    expect(html).not.toContain('Arabic-Indic'); // the digit control is only for Arabic
    expect(html).toContain('aria-label="Language"');
  });

  it('switching to Arabic flips the document to RTL, remembers it locally, and shows the digit control', async () => {
    const { i18n, render } = await load();
    i18n.setI18n({ lang: 'ar' });
    expect(root).toMatchObject({ lang: 'ar', dir: 'rtl' });
    expect(storage.getItem('lims.lang')).toBe('ar');
    const html = render(true);
    expect(html).toContain('aria-label="اللغة"');
    expect(html).toContain('مسودة'); // the draft mark is on the option, not hidden
    expect(html).toContain('٠-٩ (هندية عربية)');
    expect(i18n.t('layout.signOut')).toBe('تسجيل الخروج');
  });

  it('a stored choice is applied before the first paint, and a corrupt one is ignored', async () => {
    storage.setItem('lims.lang', 'ar');
    storage.setItem('lims.digits', 'arabic-indic');
    let { i18n } = await load();
    expect(i18n.getI18n()).toEqual({ lang: 'ar', digits: 'arabic-indic', dir: 'rtl' });
    expect(root.dir).toBe('rtl');
    storage.setItem('lims.lang', 'klingon');
    storage.setItem('lims.digits', '<script>');
    ({ i18n } = await load());
    expect(i18n.getI18n()).toEqual({ lang: 'en', digits: 'latin', dir: 'ltr' });
  });

  it('works when storage is blocked (private window): English, and switching still works for the page', async () => {
    (globalThis as any).localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    const { i18n } = await load();
    expect(i18n.getI18n().lang).toBe('en');
    i18n.setI18n({ lang: 'ar' });
    expect(i18n.getI18n().lang).toBe('ar');
  });

  it('the digit choice changes what the screen shows and nothing that is exported', async () => {
    const { i18n, format } = await load();
    i18n.setI18n({ lang: 'ar', digits: 'arabic-indic' });
    const when = new Date('2026-10-13T09:12:00Z');
    expect(format.formatDateTime(when, { timeZone: 'UTC' })).toBe('١٣ Oct ٢٠٢٦, ٠٩:١٢:٠٠ UTC');
    expect(format.exportTimestamp(when)).toBe('2026-10-13T09:12:00.000Z');
    expect(format.exportNumber('12.50')).toBe('12.50');
    i18n.setI18n({ digits: 'latin' });
    expect(format.formatDateTime(when, { timeZone: 'UTC' })).toBe('13 Oct 2026, 09:12:00 UTC');
  });

  it('a listener hears the change (what useLang subscribes to)', async () => {
    const { i18n } = await load();
    const { subscribeI18n } = await import('../../../src/i18n/store');
    const heard = vi.fn();
    const off = subscribeI18n(heard);
    i18n.setI18n({ lang: 'ar' });
    i18n.setI18n({ lang: 'ar' }); // no change: no event
    off();
    i18n.setI18n({ lang: 'en' });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the screens in Arabic', () => {
  it('the sign-in form is in Arabic, the e-mail and the codes stay left-to-right', async () => {
    const { i18n } = await load();
    i18n.setI18n({ lang: 'ar' });
    const { CredentialsForm, TotpChallenge } = await import('../../../src/components/Login');
    const noop = () => {};
    const form = renderToStaticMarkup(React.createElement(CredentialsForm, { busy: false, error: null, onSubmit: noop }));
    expect(form).toContain('البريد الإلكتروني');
    expect(form).toContain('تسجيل الدخول');
    expect(form).toMatch(/type="email"[^>]*dir="ltr"|dir="ltr"[^>]*type="email"/);
    const totp = renderToStaticMarkup(React.createElement(TotpChallenge, { busy: false, error: null, onSubmit: noop, onBack: noop }));
    expect(totp).toContain('رمز المصادقة');
    expect(totp).toMatch(/dir="ltr"/);
  });

  it('server messages stay in the server\'s own words in English, and use the catalogue for known codes in Arabic (with the request id)', async () => {
    const { i18n } = await load();
    const err = Object.assign(new Error('Invalid email or password.'), { status: 401, code: 'INVALID_CREDENTIALS', requestId: 'req-12345678' });
    expect(i18n.localizedError(err, 'login.failed')).toBe('Invalid email or password.');
    i18n.setI18n({ lang: 'ar' });
    expect(i18n.localizedError(err, 'login.failed')).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة. (معرّف الطلب req-12345678)');
    const unknown = Object.assign(new Error('Sample SMP-1 is not in Testing.'), { status: 409, code: 'SOMETHING_NEW' });
    expect(i18n.localizedError(unknown, 'login.failed')).toBe('Sample SMP-1 is not in Testing.'); // never replaced by a guess
    expect(i18n.localizedError('boom', 'login.failed')).toBe('فشل تسجيل الدخول.');
  });
});
