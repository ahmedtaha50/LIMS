// The languages and digit styles the application knows. Imported by the screens and by the server route, so it imports nothing.
export const LANGUAGES = ['en', 'ar'] as const;
export type Lang = (typeof LANGUAGES)[number];
export const DEFAULT_LANG: Lang = 'en';

export const DIGIT_MODES = ['latin', 'arabic-indic'] as const;
export type DigitMode = (typeof DIGIT_MODES)[number];
export const DEFAULT_DIGITS: DigitMode = 'latin';

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
export const isDigitMode = (v: unknown): v is DigitMode => typeof v === 'string' && (DIGIT_MODES as readonly string[]).includes(v);

/** Writing direction of a language: the page's dir attribute. */
export const dirOf = (lang: Lang): 'ltr' | 'rtl' => (lang === 'ar' ? 'rtl' : 'ltr');
