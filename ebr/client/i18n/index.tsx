import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { ApiError } from '../api.js';
import { type Lang, type T, translate } from './translate.js';

/**
 * The interface in English and Arabic (E26). The English text is the key: t('Sign in') is "Sign in" in English and its
 * Arabic in Arabic. {name} in a text is filled from the second argument. Every key the screens use must be in the Arabic
 * dictionary (tests/unit/i18n.test.ts reads the screens and checks it). Data entered by users (recipe and logbook names,
 * values, comments) is shown as written, in whatever language it was written.
 */
export { translate };
export type { Lang, T };

const Ctx = createContext<{ lang: Lang; t: T; setLang: (l: Lang) => void }>({ lang: 'en', t: translate('en'), setLang: () => undefined });

/** Sets the language and the direction of the whole page (Arabic right to left). */
export function I18nProvider({ lang, setLang, children }: { lang: Lang; setLang: (l: Lang) => void; children: ReactNode }) {
  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }, [lang]);
  const value = useMemo(() => ({ lang, t: translate(lang), setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;

/** The language a browser asks for, before anyone has signed in. */
export const browserLang = (): Lang => (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en');

/**
 * The text of an error for the user: a known error code has its own sentence in the dictionary (key "error.<code>");
 * otherwise the server's message, which always says what happened.
 */
export function errorText(t: T, err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const key = `error.${err.code}`;
    const own = t(key);
    return own !== key ? own : err.message;
  }
  return t(fallback);
}

/** Dates and times in the user's language, from the server's UTC time. */
export const formatWhen = (lang: Lang, iso: string, style: 'short' | 'medium' = 'medium') =>
  new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : undefined, { dateStyle: style, timeStyle: 'short' });
