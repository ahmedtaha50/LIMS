import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';

/**
 * The PDF writer of logbook exports and batch certified copies (E22). Every character of the record is printed: the text
 * is set in an embedded Unicode font (DejaVu Sans: Latin, accented Latin, Arabic), Arabic letters are joined by the font's
 * shaping, and each line is put in the order the Unicode bidirectional algorithm gives (Arabic right to left, numbers and
 * Latin left to right inside it).
 *
 * Each line also carries its stored text (ActualText): what a reader copies and searches is the record, character for
 * character, whatever the reading order of that reader. Lines that are plain ASCII carry it as a literal string, so the text
 * of English records stays searchable in the file itself (uncompressed content).
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const bidi = bidiFactory();

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const SIZE = 9, LEADING = 12;

/** A literal PDF string for ASCII text, a UTF-16BE hex string for anything else. */
export function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, m => '\\' + m)})`;
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return `<FEFF${b.toString('hex').toUpperCase()}>`;
}

/** The runs of one line in visual order: each run has one direction; `show` is what is handed to the font. */
export function visualRuns(line: string): { rtl: boolean; runs: { text: string; level: number; show: string }[] } {
  if (!line) return { rtl: false, runs: [] };
  const { levels, paragraphs } = bidi.getEmbeddingLevels(line);
  const rtl = ((paragraphs[0]?.level ?? 0) % 2) === 1;
  const runs: { text: string; level: number }[] = [];
  let start = 0;
  for (let i = 1; i <= line.length; i++) if (i === line.length || levels[i] !== levels[start]) { runs.push({ text: line.slice(start, i), level: levels[start]! }); start = i; }
  // rule L2: from the highest level down to the lowest odd level, reverse every sequence of runs at that level or higher
  const all = runs.map(r => r.level), odd = all.filter(l => l % 2 === 1);
  let order = runs;
  if (odd.length) for (let lv = Math.max(...all); lv >= Math.min(...odd); lv--) {
    const out: typeof runs = [];
    for (let i = 0; i < order.length;) {
      if (order[i]!.level < lv) { out.push(order[i++]!); continue; }
      let j = i;
      while (j < order.length && order[j]!.level >= lv) j++;
      out.push(...order.slice(i, j).reverse());
      i = j;
    }
    order = out;
  }
  return { rtl, runs: order.map(r => ({ ...r, show: r.level % 2 === 1 ? mirror([...r.text].reverse().join('')) : r.text })) };
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const mirror = (s: string) => s.replace(/[()[\]{}<>«»]/g, c => MIRROR[c]!);   // rule L4: brackets in a right-to-left run face the other way

/**
 * The strings to hand to the font for one visual run, left to right. The font lays a string out right to left (reversing it)
 * when its FIRST character is of the Arabic script, and left to right otherwise; it joins Arabic letters in the order given.
 * So the visual text is cut into pieces that are all Arabic script or all not, and an Arabic piece is handed over reversed:
 * that is its logical order (its letters join correctly) and the font's own reversal puts it back in visual order.
 * Found by looking at the first render: a run starting with a space was not reversed, Arabic-Indic digits were.
 */
export function fontPieces(show: string): string[] {
  const out: string[] = [];
  for (const m of show.matchAll(/(\p{Script=Arabic}[\p{Script=Arabic}\p{M}]*)|([^\p{Script=Arabic}]+)/gu)) out.push(m[1] ? [...m[1]].reverse().join('') : m[2]!);
  return out;
}

/** Splits a logical line into lines that fit the width, at spaces where possible (before reordering, as the algorithm says). */
function wrap(doc: PDFKit.PDFDocument, line: string, width: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest && doc.widthOfString(rest) > width) {
    let cut = rest.length;
    while (cut > 1 && doc.widthOfString(rest.slice(0, cut)) > width) cut--;
    const space = rest.lastIndexOf(' ', cut);
    if (space > cut / 3) cut = space;
    out.push(rest.slice(0, cut).trimEnd());
    rest = '    ' + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/**
 * Renders a titled document of text lines. `sha256` is the hash of the title and the lines (the export hash printed on
 * each page, which the system can recompute from the same data).
 */
export async function renderPdf(title: string, lines: string[]): Promise<{ pdf: Buffer; sha256: string }> {
  const sha256 = createHash('sha256').update(title + '\n' + lines.join('\n')).digest('hex');
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, compress: false, pdfVersion: '1.4', autoFirstPage: false, info: { Title: title, Producer: 'B-Pharma EBR', Creator: 'B-Pharma EBR' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => { doc.on('end', () => resolve()); doc.on('error', reject); });
  doc.registerFont('text', FONT);
  doc.font('text').fontSize(SIZE);

  const width = PAGE.width - 2 * PAGE.margin;
  const all = lines.flatMap(l => wrap(doc, l, width));
  const perPage = Math.floor((PAGE.height - 2 * PAGE.margin) / LEADING) - 3;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  for (let n = 0; n < pages; n++) {
    doc.addPage({ size: 'A4', margin: PAGE.margin });
    const head = [title, `Page ${n + 1} of ${pages} - export ${sha256.slice(0, 16)}`, ''];
    let y = PAGE.margin;
    for (const line of [...head, ...all.slice(n * perPage, (n + 1) * perPage)]) {
      const { rtl, runs } = visualRuns(line);
      const pieces = runs.flatMap(r => fontPieces(r.show));
      const total = pieces.reduce((w, s) => w + doc.widthOfString(s), 0);
      let x = rtl ? PAGE.width - PAGE.margin - total : PAGE.margin;
      doc.addContent(`/Span << /ActualText ${pdfTextString(line)} >> BDC`);
      for (const s of pieces) { doc.text(s, x, y, { lineBreak: false }); x += doc.widthOfString(s); }
      doc.addContent('EMC');
      y += LEADING;
    }
  }
  doc.end();
  await done;
  return { pdf: Buffer.concat(chunks), sha256 };
}
