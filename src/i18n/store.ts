// The language and digit style in force, remembered in this browser (localStorage) and applied to the document (lang, dir, data-digits).
// The server copy (GET/PUT /me/preferences, src/i18n/preferences.ts) is the one that survives a restart of the desktop build, whose port
// and therefore origin change at every launch; this local copy makes the sign-in screen and the first paint right.
// Every storage access is guarded: a private window or blocked site data simply starts in English.
import { setDisplayDigits } from '../lib/format';
import { DEFAULT_DIGITS, DEFAULT_LANG, dirOf, isDigitMode, isLang, type DigitMode, type Lang } from './languages';

const LANG_KEY = 'lims.lang';
const DIGITS_KEY = 'lims.digits';

export interface I18nState { lang: Lang; digits: DigitMode; dir: 'ltr' | 'rtl' }

function read(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* not remembered here; the server copy and the current page still work */ }
}

const storedLang = read(LANG_KEY);
const storedDigits = read(DIGITS_KEY);
let state: I18nState = {
  lang: isLang(storedLang) ? storedLang : DEFAULT_LANG,
  digits: isDigitMode(storedDigits) ? storedDigits : DEFAULT_DIGITS,
  dir: 'ltr',
};
state.dir = dirOf(state.lang);
const listeners = new Set<() => void>();

/** The document follows the state: screen readers pick the voice from lang, the browser mirrors the layout from dir. */
export function applyToDocument(s: I18nState = state): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = s.lang;
  root.dir = s.dir;
  root.dataset.digits = s.digits;
}
setDisplayDigits(state.digits);
applyToDocument();

export const getI18n = (): I18nState => state;
export const subscribeI18n = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Changes the language and/or digit style on this computer. Nothing stored in the database, signed or exported depends on them. */
export function setI18n(next: Partial<Pick<I18nState, 'lang' | 'digits'>>): void {
  const lang = next.lang ?? state.lang;
  const digits = next.digits ?? state.digits;
  if (lang === state.lang && digits === state.digits) return;
  state = { lang, digits, dir: dirOf(lang) };
  write(LANG_KEY, lang);
  write(DIGITS_KEY, digits);
  setDisplayDigits(digits);
  applyToDocument();
  listeners.forEach(fn => fn());
}
