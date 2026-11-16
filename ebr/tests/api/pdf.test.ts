import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textPdf } from '../../server/logbook/pdf.js';
import { visualRuns } from '../../server/pdf/writer.js';
import { verifyCopy } from '../../server/review/service.js';
import { migrate } from '../../server/migrate/runner.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

// E22: the R3 writer printed '?' for every character outside ASCII, so an Arabic comment or an accented name was lost in a
// certified copy. These lines are what a plant writes: an Arabic cleaning comment, an English one with accents, and a mixed
// line with a code, a number and a closing parenthesis.
const ARABIC = 'تم التنظيف بالكحول ٧٠٪ لمدة 12 دقيقة';
const LATIN = 'Cleaned with ethanol 70% by José Müller, café área';
const MIXED = 'Mixer M-01: تم التنظيف قبل الدفعة B-2026-14 (OK)';
const LINES = [ARABIC, LATIN, MIXED];

/** The ActualText of every marked line of a PDF, decoded (literal ASCII strings and UTF-16BE hex strings). */
function carriedLines(pdf: Buffer): string[] {
  const src = pdf.toString('latin1'), out: string[] = [];
  for (const m of src.matchAll(/\/ActualText (?:<FEFF([0-9A-F]*)>|\(((?:\\.|[^\\)])*)\))/g)) {
    if (m[1] !== undefined) { const b = Buffer.from(m[1], 'hex'); b.swap16(); out.push(b.toString('utf16le')); }
    else out.push(m[2]!.replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** The characters of the glyphs drawn in each marked line, in drawing order (left to right), through the font's ToUnicode map. */
function drawnLines(pdf: Buffer): string[] {
  const src = pdf.toString('latin1');
  const map = new Map<number, string>();
  for (const m of src.matchAll(/<([0-9a-f]{4})> <([0-9a-f]{4})> \[([^\]]*)\]/gi)) {
    const first = parseInt(m[1]!, 16), values = [...m[3]!.matchAll(/<([0-9a-f]+)>/gi)].map(v => Buffer.from(v[1]!, 'hex').swap16().toString('utf16le'));
    values.forEach((v, i) => map.set(first + i, v));
  }
  const out: string[] = [];
  for (const span of src.matchAll(/\/ActualText [^\n]*BDC([\s\S]*?)EMC/g)) {
    let s = '';
    for (const tj of span[1]!.matchAll(/\[([^\]]*)\] TJ/g)) for (const h of tj[1]!.matchAll(/<([0-9a-f]+)>/gi)) for (let i = 0; i < h[1]!.length; i += 4) s += map.get(parseInt(h[1]!.slice(i, i + 4), 16)) ?? '�';
    out.push(s);
  }
  return out;
}

/** What an independent reader (pdf.js, the engine of the Firefox viewer) extracts from every page. */
async function readerText(pdf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), standardFontDataUrl: require.resolve('pdfjs-dist/package.json').replace('package.json', 'standard_fonts/'), verbosity: 0 }).promise;
  let text = '';
  for (let n = 1; n <= doc.numPages; n++) text += (await (await doc.getPage(n)).getTextContent()).items.map(i => ('str' in i ? i.str : '')).join(' ') + '\n';
  return text;
}
const count = (s: string) => { const m = new Map<string, number>(); for (const ch of s.replace(/[\s‎‏‪-‮⁦-⁩]/g, '')) m.set(ch, (m.get(ch) ?? 0) + 1); return m; };

describe('every character in exports and certified copies (E22)', () => {
  let pdf: Buffer;
  beforeAll(async () => { pdf = (await textPdf('Logbook MIX-01', LINES)).pdf; });

  it('E22#1: Arabic, accented Latin and mixed lines are printed with no character replaced or dropped', async () => {
    const text = await readerText(pdf);
    expect(text).not.toContain('?');
    expect(text).not.toContain('�');
    for (const line of LINES) {
      const have = count(text);
      for (const [ch, n] of count(line)) expect(have.get(ch) ?? 0, `${JSON.stringify(ch)} of ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(n);
    }
  });

  it('E22#1: an Arabic line reads right to left with its number left to right, a mixed line keeps the Latin part first', () => {
    const ar = visualRuns(ARABIC);
    expect(ar.rtl).toBe(true);
    // logical runs: [تم التنظيف بالكحول ](1) [٧٠](2) [٪ لمدة ](1) [12](2) [ دقيقة](1); a right-to-left line shows them reversed
    expect(ar.runs.map(r => r.text)).toEqual([' دقيقة', '12', '٪ لمدة ', '٧٠', 'تم التنظيف بالكحول ']);
    expect(ar.runs.find(r => r.text === '12')!.show).toBe('12');                                    // a number is not reversed
    const mx = visualRuns(MIXED);
    expect(mx.rtl).toBe(false);
    expect(mx.runs[0]!.text).toBe('Mixer M-01: ');
    expect(mx.runs.map(r => r.text).join('')).toHaveLength(MIXED.length);
  });

  it('E22#1: the glyphs are drawn in the order of the Unicode bidirectional algorithm (Arabic right to left, numbers left to right)', async () => {
    // The order of the drawn glyphs, read back from the PDF itself through its ToUnicode map, against the reordering of an
    // independent implementation (bidi-js getReorderedString, which also mirrors brackets).
    const bidi = (await import('bidi-js')).default();
    const drawn = drawnLines(pdf);
    for (const line of LINES) {
      const want = bidi.getReorderedString(line, bidi.getEmbeddingLevels(line));
      expect(drawn, line).toContain(want);
    }
  });

  it('E22#2: the text the PDF carries for each line equals the stored text, character for character', () => {
    const carried = carriedLines(pdf);
    for (const line of LINES) expect(carried).toContain(line);
    expect(carried[0]).toBe('Logbook MIX-01');
  });

  it('E22#2: an independent reader finds every character of each line (the reading order of Arabic is the reader\'s)', async () => {
    const text = await readerText(pdf);
    expect(text).toContain(LATIN);
    expect(text).toContain('Mixer M-01:');
    for (const word of ['التنظيف', 'بالكحول', 'دقيقة', 'الدفعة']) expect(text).toContain(word);
  });

  it('E22#2: plain English lines stay searchable in the file itself, and a long line is wrapped, not cut', async () => {
    const long = 'Comment: ' + 'the mixer was cleaned and inspected before use '.repeat(6) + 'END';
    const { pdf: p } = await textPdf('Certified copy - batch B-1', ['pH 7.4 performed by op-r', long]);
    const raw = p.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('pH 7.4 performed by op-r');
    const carried = carriedLines(p);
    expect(carried.length).toBeGreaterThan(4);                                                       // title, page line, blank, 1 + wrapped
    expect(carried.join(' ').replace(/\s+/g, ' ')).toContain(long.replace(/\s+/g, ' ').slice(-60));
  });
});

describe('certified copies made by the R3 writer (E22#3)', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => { db = await freshDatabase('pdf'); await migrate(db.pool, MIGRATIONS); });
  afterAll(async () => { await db.drop(); });

  it('E22#3: a copy written before this change still verifies against its registered hash', async () => {
    const old = readFileSync(fileURLToPath(new URL('./fixtures/certified-copy-r3-writer.pdf', import.meta.url)));
    expect(old.toString('latin1')).toContain('/BaseFont /Helvetica');                                // it is the R3 writer's file
    const m = (await db.pool.query<{ id: string }>("INSERT INTO mbr_masters (code, product_name) VALUES ('OLD-1', 'Old product') RETURNING id")).rows[0]!.id;
    const v = (await db.pool.query<{ id: string }>("INSERT INTO mbr_versions (master_id, version_no, design, author_id, author_name) VALUES ($1, 1, '{}', 'u', 'author') RETURNING id", [m])).rows[0]!.id;
    const b = (await db.pool.query<{ id: string }>("INSERT INTO batches (batch_number, mbr_master_id, mbr_version_id, product_name, batch_size, created_by) VALUES ('B-R3-OLD', $1, $2, 'Old product', '{}', 'op') RETURNING id", [m, v])).rows[0]!.id;
    const registered = (await verifyCopy(db.pool, old)).sha256;
    await db.pool.query("INSERT INTO certified_copies (batch_id, sha256, bytes, generated_by) VALUES ($1, $2, $3, 'qa-r')", [b, registered, old.length]);
    expect(await verifyCopy(db.pool, old)).toMatchObject({ genuine: true, batchNumber: 'B-R3-OLD', sha256: 'db67253f3d4e7d4f5022a1e2244c8178085318b5ec7eabf260192e261f1df8da' });
    const changed = Buffer.from(old.toString('latin1').replace('7.4', '6.4'), 'latin1');
    expect((await verifyCopy(db.pool, changed)).genuine).toBe(false);
  });
});
