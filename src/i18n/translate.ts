// The translation function, with no state and no DOM, so it can be tested on its own. src/i18n/index.ts binds it to the user's language.
//
// Catalogues: src/i18n/en.json (the source of truth; English is also the fallback) and src/i18n/ar.json. A key is a dotted name; a message
// may contain {name} placeholders, which must be the same set in every language (tests/unit/i18n/catalogue.test.ts). There are no plural
// forms on purpose: a message that needs "1 sample / 2 samples" is written so that the count stands alone ("Samples: {n}"), because the
// Arabic plural rules (six forms) are not something to get half right in a regulated screen.
import ar from './ar.json';
import en from './en.json';
import type { Lang } from './languages';

export type Catalogue = Record<string, string>;
export const CATALOGUES: Record<Lang, Catalogue> = { en, ar };
export type MessageKey = keyof typeof en;
export type Params = Record<string, string | number>;

/**
 * The Arabic catalogue is a DRAFT: machine-assisted wording that no QA reviewer and no linguist has approved. Regulated wording (signature
 * meanings, audit field names, status names, report titles) is NOT translated at all; those stay in canonical English until QA approves a
 * translation. The language switch says so on screen.
 */
export const CATALOGUE_STATUS: Record<Lang, 'source' | 'draft'> = { en: 'source', ar: 'draft' };

const PLACEHOLDER = /\{(\w+)\}/g;
export const placeholdersOf = (message: string): string[] => Array.from(new Set(Array.from(message.matchAll(PLACEHOLDER), m => m[1]))).sort();

/** A message in a language; the English text when the key is missing there; the key itself (visible, never blank) when it is missing everywhere. */
export function translate(lang: Lang, key: string, params?: Params): string {
  const message = CATALOGUES[lang][key] ?? CATALOGUES.en[key] ?? key;
  return params ? message.replace(PLACEHOLDER, (whole, name: string) => (name in params ? String(params[name]) : whole)) : message;
}
