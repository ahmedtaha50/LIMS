/**
 * Roadmap M38 (r3-i18n): the message catalogues. English is the source; Arabic is a DRAFT that QA and a linguist must still approve.
 * These tests keep the two files in step (same keys, same placeholders) and keep the code honest about which keys it uses.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import ar from '../../../src/i18n/ar.json';
import en from '../../../src/i18n/en.json';
import { CATALOGUE_STATUS, placeholdersOf, translate } from '../../../src/i18n/translate';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const enKeys = Object.keys(en).sort();
const arKeys = Object.keys(ar).sort();

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'fonts' || e.name === 'server' ? [] : sourceFiles(p)) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const SRC = ['src/components', 'src/App.tsx', 'src/i18n', 'src/lib/format.ts'].flatMap(p => (fs.statSync(path.join(ROOT, p)).isDirectory() ? sourceFiles(path.join(ROOT, p)) : [path.join(ROOT, p)]));

describe('the catalogues', () => {
  it('have the same keys in English and Arabic: none missing, none extra', () => {
    expect(arKeys.filter(k => !(k in en))).toEqual([]);
    expect(enKeys.filter(k => !(k in ar))).toEqual([]);
    expect(arKeys).toEqual(enKeys);
  });

  it('have no empty message and no message that is only whitespace', () => {
    for (const [lang, c] of Object.entries({ en, ar })) {
      for (const [k, v] of Object.entries(c)) expect(typeof v === 'string' && v.trim().length > 0, `${lang}:${k}`).toBe(true);
    }
  });

  it('use the same {placeholders} in both languages (a lost one would print a hole in a regulated sentence)', () => {
    const bad = enKeys.filter(k => placeholdersOf(en[k as keyof typeof en]).join() !== placeholdersOf(ar[k as keyof typeof ar]).join());
    expect(bad).toEqual([]);
  });

  it('write real Arabic: every Arabic message has an Arabic letter, except brand, unit and code strings that are the same in both', () => {
    const SAME = new Set(['grid.export.excel', 'lang.digits.latin', 'lang.digits.arabicIndic']);
    const noArabic = arKeys.filter(k => !/[؀-ۿ]/.test(ar[k as keyof typeof ar]) && !SAME.has(k));
    expect(noArabic).toEqual([]);
  });

  it('a placeholder name is a plain word, never translated', () => {
    for (const k of arKeys) {
      const names = Array.from(ar[k as keyof typeof ar].matchAll(/\{([^}]*)\}/g), m => m[1]);
      for (const n of names) expect(n, k).toMatch(/^\w+$/);
    }
  });

  it('are marked as a draft: Arabic is not approved wording', () => {
    expect(CATALOGUE_STATUS).toEqual({ en: 'source', ar: 'draft' });
  });

  it('do not translate regulated wording: signature meanings, record states and audit field names are not catalogue keys', () => {
    const regulated = /\b(COA_AUTHORISATION|COA_VOID|SPECIFICATION_APPROVAL|Quarantine|Released|Rejected|Approved|Obsolete)\b/;
    const hits = enKeys.filter(k => regulated.test(k));
    expect(hits).toEqual([]);
  });
});

describe('every key the code asks for exists', () => {
  // Keys the code asks for: t('k'), t(cond ? 'a' : 'b'), localizedError(err, 'k'). "Mentioned": any string literal that is a catalogue key.
  const asked = new Set<string>();
  const mentioned = new Set<string>();
  for (const f of SRC) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) asked.add(m[1]);
    for (const m of text.matchAll(/\bt\([^()']*\?\s*'([a-zA-Z0-9_.]+)'\s*:\s*'([a-zA-Z0-9_.]+)'/g)) { asked.add(m[1]); asked.add(m[2]); }
    for (const m of text.matchAll(/localizedError\([^)]*?,\s*'([a-zA-Z0-9_.]+)'\)/g)) asked.add(m[1]);
    for (const m of text.matchAll(/'([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'/g)) if (m[1] in en) mentioned.add(m[1]);
  }
  const used = new Set([...asked, ...mentioned]);

  it('t(key) and the MessageKey literals in the screens are all in the catalogue', () => {
    const missing = [...asked].filter(k => !(k in en));
    expect(missing).toEqual([]);
    expect(asked.size).toBeGreaterThan(150);
  });

  it('no catalogue key is dead (computed keys: nav.item.*, nav.section.*, error.<code> are listed by prefix)', () => {
    const computed = /^(nav\.item\.|nav\.section\.|error\.[A-Z_]+$)/;
    const dead = enKeys.filter(k => !used.has(k) && !computed.test(k));
    expect(dead).toEqual([]);
  });
});

describe('translate()', () => {
  it('fills placeholders, leaves an unknown placeholder visible, and does not evaluate anything', () => {
    expect(translate('en', 'samples.bulkDone', { count: 12 })).toBe('Successfully imported 12 samples');
    expect(translate('ar', 'samples.bulkDone', { count: 12 })).toBe('تم استيراد 12 عينة بنجاح');
    expect(translate('en', 'samples.bulkDone')).toBe('Successfully imported {count} samples');
    expect(translate('en', 'samples.bulkDone', { count: '${process.env.JWT_SECRET}' })).toBe('Successfully imported ${process.env.JWT_SECRET} samples');
    expect(translate('en', 'app.noPage', { view: '$&' })).toBe('There is no page at this address ($&).');
  });

  it('falls back to English for a key Arabic lacks, and to the key itself (never blank) when nobody has it', () => {
    expect(translate('ar', 'no.such.key')).toBe('no.such.key');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('a data value containing a placeholder is not expanded a second time', () => {
    expect(translate('en', 'grid.loadFailed', { noun: '{failure}', failure: 'x' })).toBe('Could not load {failure}: x');
  });
});
