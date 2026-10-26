// Internationalisation (roadmap M38, r3-i18n): English and Arabic, dependency-free.
//
//   import { t, useLang } from '../i18n';
//   function Screen() { useLang(); return <h1>{t('samples.title')}</h1>; }   // useLang re-renders the screen when the language changes
//
// What the language changes: the words on the screen, the writing direction and the digits shown. What it never changes: any stored
// value, the audit trail (canonical English), signature meanings, CSV and PDF exports, or the timestamp format (src/lib/format.ts).
import { useSyncExternalStore } from 'react';
import { getI18n, setI18n, subscribeI18n, type I18nState } from './store';
import { CATALOGUE_STATUS, translate, type MessageKey, type Params } from './translate';

export type { MessageKey, Params } from './translate';
export { CATALOGUE_STATUS } from './translate';
export { DIGIT_MODES, LANGUAGES, dirOf, type DigitMode, type Lang } from './languages';
export { getI18n, setI18n } from './store';

/** The message in the language in force. Missing in Arabic: the English text; missing everywhere: the key. */
export function t(key: MessageKey, params?: Params): string {
  return translate(getI18n().lang, key, params);
}

/** Subscribes the component to the language: it renders again when the user switches. */
export function useLang(): I18nState {
  return useSyncExternalStore(subscribeI18n, getI18n, getI18n);
}

export const isDraftLanguage = (lang: I18nState['lang']): boolean => CATALOGUE_STATUS[lang] === 'draft';

/**
 * The text for a failed call. The server's messages are English (they are also what the audit trail and the logs hold); for the common
 * codes the screen shows the catalogue's wording and keeps the request id so support can find the server's own text.
 */
export function localizedError(err: unknown, fallback: MessageKey): string {
  // English is the language of the server's own messages: shown exactly as sent, so nothing a user reads or quotes changes.
  if (getI18n().lang === 'en') return err instanceof Error && err.message ? err.message : t(fallback);
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  const status = (err as { status?: unknown })?.status;
  const requestId = (err as { requestId?: unknown })?.requestId;
  const byCode = code ? (`error.${code}` as MessageKey) : null;
  const known = byCode && translate(getI18n().lang, byCode) !== byCode;
  if (known) {
    const base = t(byCode!);
    return typeof requestId === 'string' ? `${base} (${t('error.requestId', { id: requestId })})` : base;
  }
  if (typeof status === 'number' && err instanceof Error && err.message) return err.message; // an unlisted server answer: its own words
  return t(fallback);
}
