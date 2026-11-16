import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ar } from '../../client/i18n/ar.js';
import { en } from '../../client/i18n/en.js';
import { translate } from '../../client/i18n/translate.js';

// (kit web-i18n of the gxp-software-factory skill; proven on the EBR project.) No text of the interface is missing in either language. The keys are read from the screens themselves, so a new
// text that is not in the Arabic dictionary fails here, and so does a visible English text that does not go through t().
const CLIENT = fileURLToPath(new URL('../../client', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !p.includes('/i18n/') ? [p] : []; });
const sources = files(CLIENT).map(f => ({ f: f.slice(CLIENT.length + 1), s: readFileSync(f, 'utf8') }));
const unq = (s: string) => s.replace(/\\'/g, "'");

const used = new Set<string>();
for (const { s } of sources) {
  for (const m of s.matchAll(/\bt\(\s*'((?:\\'|[^'])*)'/g)) used.add(unq(m[1]!));                       // t('...')
  for (const m of s.matchAll(/errorText\(\s*t\s*,\s*\w+\s*,\s*'((?:\\'|[^'])*)'/g)) used.add(unq(m[1]!));   // errorText(t, e, '...')
  // CHANGE IN A NEW PROJECT: add the other places a key is written, e.g. screen titles in a route table
}
const dynamicPrefixes = [...new Set([...sources.flatMap(({ s }) => [...s.matchAll(/\bt\(\s*`([a-zA-Z]+)\.\$\{/g)].map(m => m[1]!))])];

describe('the Arabic and English interface', () => {
  it('every text the screens use is in the Arabic dictionary', () => {
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter(k => !(k in ar))).toEqual([]);
  });

  it('every key made from a server code (meanings, statuses, setting names) is in both dictionaries', () => {
    // every prefix a screen builds a key from (t(`status.${s}`)) has its keys in en.ts
    expect(Object.keys(en).filter(k => !(k in ar))).toEqual([]);
    for (const p of dynamicPrefixes) expect(Object.keys(en).some(k => k.startsWith(`${p}.`)), p).toBe(true);
  });

  it('the Arabic dictionary holds no unused text, and every value is Arabic with the same {placeholders}', () => {
    const known = new Set([...used, ...Object.keys(en)]);
    expect(Object.keys(ar).filter(k => !known.has(k) && !k.startsWith('error.'))).toEqual([]);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    const bad = Object.entries(ar).filter(([k, v]) => !/[؀-ۿ]/.test(v) || holes(v) !== holes(en[k] ?? k)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('no visible English text in the screens bypasses the dictionary', () => {
    const leaks: string[] = [];
    for (const { f, s } of sources) {
      // JSX text: after a tag (not an arrow or a generic), letters without code characters, before the next tag
      for (const m of s.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}=;()`]*[A-Za-z.…!?:])\s*<\/?[A-Za-z]/g)) leaks.push(`${f}: ${m[1]}`);
      for (const m of s.matchAll(/\b(?:label|title|hint|aria-label|placeholder)="([A-Za-z][^"]*)"/g)) leaks.push(`${f}: ${m[1]}`);   // literal attributes
    }
    expect(leaks).toEqual([]);
  });

  it('the same key gives English or Arabic, and fills its placeholders in both', () => {
    expect(translate('en')('Version {n}', { n: 3 })).toBe('Version 3');
    expect(translate('ar')('Version {n}', { n: 3 })).toMatch(/^[^A-Za-z]*3[^A-Za-z]*$/);
    expect(translate('en')('meaning.performed')).toBe('performed');
    expect(translate('ar')('meaning.performed')).not.toBe('performed');
    expect(translate('ar')('Sign in')).not.toBe('Sign in');
  });
});
