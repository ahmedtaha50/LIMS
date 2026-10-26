/**
 * Roadmap M38 (r3-i18n): right-to-left, checked in the source. The shell is mirrored by dir="rtl" on <html> (src/i18n/store.ts), which
 * only works when the layout is written with logical utilities (ms-, pe-, text-start, border-s, start-3 ...) and not with physical ones
 * (ml-, pr-, text-left, border-l, left-3 ...). A physical utility is a place where Arabic shows the English layout.
 *
 * Files owned by other tracks are left out (Trending, ControlChart, CommandPalette, PeriodicReviews, DirectorySettings): their owners
 * convert them; the list below is the same as the track's ownsFiles exclusions.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OTHER_TRACKS = new Set(['Trending.tsx', 'ControlChart.tsx', 'CommandPalette.tsx', 'PeriodicReviews.tsx', 'DirectorySettings.tsx']);
const files = fs.readdirSync(path.join(ROOT, 'src/components')).filter(f => f.endsWith('.tsx') && !OTHER_TRACKS.has(f)).map(f => `src/components/${f}`).concat(['src/App.tsx', 'src/i18n/LanguageSwitch.tsx']);
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A utility token, with its variants (lg:, hover:, !) and the negative sign, bounded by quote, space, backtick or colon.
const PHYSICAL = /(?<![\w-])(?:[\w[\]=&>*.()-]+:)*!?-?(?:(?:ml|mr|pl|pr)-[\w[\]./%]+|(?:left|right)-[\d[\]/\w.-]+|text-(?:left|right)|float-(?:left|right)|border-(?:l|r)(?:-[\w[\]]+)?|rounded-(?:l|r|tl|tr|bl|br)(?:-[\w[\]]+)?|translate-x-[\w[\]./%]+)(?![\w-])/g;
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no physical direction in the layout of the screens', () => {
  it.each(files)('%s uses logical utilities only', f => {
    const hits = Array.from(code(read(f)).matchAll(PHYSICAL), m => m[0]);
    expect(hits).toEqual([]);
  });

  it('the matcher can fail: it finds the physical forms it is meant to catch', () => {
    const sample = 'className="ml-2 pr-3 -mr-1 text-left left-3 lg:pl-6 border-l-4 rounded-r-lg hover:text-right"';
    expect(Array.from(sample.matchAll(PHYSICAL), m => m[0])).toEqual(['ml-2', 'pr-3', '-mr-1', 'text-left', 'left-3', 'lg:pl-6', 'border-l-4', 'rounded-r-lg', 'hover:text-right']);
    const logical = 'className="ms-2 pe-3 text-start start-3 border-s-4 rounded-e-lg rtl:-scale-x-100"';
    expect(Array.from(logical.matchAll(PHYSICAL), m => m[0])).toEqual([]);
  });
});

describe('the document follows the language', () => {
  it('the store sets lang, dir and the digit style on <html>', () => {
    const text = read('src/i18n/store.ts');
    expect(text).toMatch(/root\.lang = /);
    expect(text).toMatch(/root\.dir = /);
    expect(text).toMatch(/dataset\.digits/);
  });

  it('Arabic letters are never spaced out (letter-spacing breaks the joining) and the Arabic font is bundled, not fetched', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/:lang\(ar\) \*\s*\{\s*letter-spacing: 0 !important/);
    expect(css).toMatch(/@import "\.\/i18n\/fonts\/noto-sans-arabic\.css"/);
    expect(css).toMatch(/--font-sans:[^;]*"Noto Sans Arabic"/);
    const fontCss = read('src/i18n/fonts/noto-sans-arabic.css');
    expect(fontCss).not.toMatch(/https?:/);
    for (const url of fontCss.matchAll(/url\(\.\/([\w.-]+)\)/g)) expect(fs.existsSync(path.join(ROOT, 'src/i18n/fonts', url[1])), url[1]).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'src/i18n/fonts/OFL-Noto-Sans-Arabic.txt'))).toBe(true);
  });

  it('identifiers are isolated from Arabic text: the samples list isolates ids (cell direction) and batches (<bdi dir="ltr">)', () => {
    expect(read('src/components/Samples.tsx')).toMatch(/key: 'id'[^\n]*\[direction:ltr\] \[unicode-bidi:isolate\]/);
    expect(read('src/components/Samples.tsx')).toMatch(/<bdi dir="ltr">\{r\.batch\}<\/bdi>/);
  });

  it('charts stay left-to-right', () => {
    expect(read('src/components/Dashboard.tsx').match(/h-\d+ w-full" dir="ltr"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('no locale-dependent formatting is left in the screens', () => {
  const OWNED = fs.readdirSync(path.join(ROOT, 'src/components')).filter(f => f.endsWith('.tsx') && !OTHER_TRACKS.has(f)).map(f => `src/components/${f}`);
  it.each(OWNED)('%s has no toLocale* call (the operating system decides digits, calendar and order)', f => {
    expect(code(read(f))).not.toMatch(/\.toLocale(?:Date|Time)?String\(/);
  });

  it('src/lib/format.ts is the one place that asks for a locale, and it fixes it', () => {
    const text = code(read('src/lib/format.ts'));
    expect(text).not.toMatch(/toLocale/);
    expect(text).toMatch(/'en-US'/);
    expect(text).toMatch(/numberingSystem: 'latn'/);
    expect(text).toMatch(/calendar: 'gregory'/);
  });
});
