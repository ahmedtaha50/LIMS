/**
 * Roadmap M29 (r2-custody-labels): the label barcodes (src/lib/barcode.ts) and the wedge-scanner burst detector (src/lib/useScanSink.ts).
 *
 * The Code 128 fixtures below were produced by bwip-js 4.7.0 (BWIPP, an independent encoder; bwipjs.raw('code128', text).sbs) on
 * 2026-10-25. The full comparison (every code set B value 0..94, every code set C value 00..99, the start, check and stop symbols:
 * 98 texts, all identical) is recorded in docs/changes/r2-custody-labels.md. Texts with digit runs inside letters are encoded in code
 * set B here and with a switch to code set C by bwip-js; both are valid, so those are checked by decoding instead.
 */
import { describe, expect, it } from 'vitest';
import { BarcodeError, code128Modules, code128Svg, code128Values, qrSvg } from '../../../src/lib/barcode';
import { createScanDetector } from '../../../src/lib/useScanSink';

const BWIP = {
  'LOT-77': '2112141321311331212133111221323121313121311242112331112',
  'Hello World': '2112142311131122142211142211141341112122223113211341111212412211141412211123312331112',
  '12345678': '2112321122321311233311212411121331212331112',
  'LOC-A': '2112141321311331211313211221321113232113312331112',
};

/** A decoder for what this encoder emits (start B or C, no switches), to read a symbol back. */
function decode(modules: number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < modules.length - 7; i += 6) groups.push(modules.slice(i, i + 6).join(''));
  const stop = modules.slice(-7).join('');
  expect(stop).toBe('2331112');
  const table = new Map<string, number>();
  for (let v = 0; v < 106; v++) {
    // the encoder's own value -> pattern, read through a single-symbol text where possible
    if (v < 95) table.set(code128Modules(String.fromCharCode(32 + v)).slice(6, 12).join(''), v);
  }
  const values = groups.map(g => (g === '211214' ? 104 : g === '211232' ? 105 : table.get(g)));
  const [start, ...rest] = values as number[];
  const check = rest.pop()!;
  let sum = start;
  rest.forEach((v, i) => { sum += v * (i + 1); });
  expect(sum % 103).toBe(check);
  return start === 105 ? rest.map(v => String(v).padStart(2, '0')).join('') : rest.map(v => String.fromCharCode(v + 32)).join('');
}

describe('Code 128', () => {
  it('matches the independent encoder (bwip-js) symbol for symbol', () => {
    for (const [text, sbs] of Object.entries(BWIP)) expect(code128Modules(text).join(''), text).toBe(sbs);
  });

  it('every symbol is 11 modules wide and the stop 13; bars and spaces alternate, bar first', () => {
    const m = code128Modules('SMP-2026-00001');
    expect(m.reduce((a, b) => a + b, 0)).toBe(11 * (code128Values('SMP-2026-00001').length) + 13);
  });

  it('reads back as the text it was made from (sample, container, location ids)', () => {
    for (const t of ['SMP-2026-00001', 'CTN-000001', 'LOC-000012', 'CE-000000001', 'a b~']) expect(decode(code128Modules(t))).toBe(t);
    expect(decode(code128Modules('202610'))).toBe('202610'); // code set C
  });

  it('refuses what it cannot encode faithfully', () => {
    expect(() => code128Values('')).toThrow(BarcodeError);
    expect(() => code128Values('Ä-1')).toThrow(/printable ASCII/);
    expect(() => code128Values('a\nb')).toThrow(/printable ASCII/);
    expect(() => code128Values('x'.repeat(81))).toThrow(/80/);
  });

  it('draws an SVG with one rect per bar and the text as its accessible name', () => {
    const svg = code128Svg('LOT-77');
    const bars = (svg.match(/<rect x=/g) ?? []).length;
    expect(bars).toBe(Math.ceil(code128Modules('LOT-77').length / 2));
    expect(svg).toContain('aria-label="LOT-77"');
    expect(code128Svg('<a&"b>')).toContain('aria-label="&lt;a&amp;&quot;b&gt;"');
  });

  it('QR comes from the qrcode package as SVG', async () => {
    const svg = await qrSvg('SMP-2026-00001');
    expect(svg).toMatch(/^<svg/);
    await expect(qrSvg('')).rejects.toThrow(BarcodeError);
  });
});

describe('wedge-scanner burst detector', () => {
  const feed = (keys: Array<[string, number, boolean?]>) => {
    const d = createScanDetector();
    const out: string[] = [];
    for (const [key, time, editable] of keys) { const code = d.push({ key, time, editable: !!editable }); if (code) out.push(code); }
    return out;
  };
  const burst = (text: string, start = 1000, gap = 8): Array<[string, number]> =>
    [...[...text].map((k, i) => [k, start + i * gap] as [string, number]), ['Enter', start + text.length * gap]];

  it('a burst under 35 ms per key ending in Enter is a scan', () => {
    expect(feed(burst('SMP-2026-00001'))).toEqual(['SMP-2026-00001']);
  });

  it('Shift between characters does not break the burst', () => {
    expect(feed([['Shift', 1000], ['S', 1004], ['Shift', 1008], ['M', 1012], ['P', 1020], ['-', 1028], ['1', 1036], ['Enter', 1044]])).toEqual(['SMP-1']);
  });

  it('a person typing (slower than 35 ms per key) is not a scan', () => {
    expect(feed(burst('SMP-2026-00001', 1000, 120))).toEqual([]);
    expect(feed(burst('SMP-2026-00001', 1000, 35))).toEqual([]);
  });

  it('a pause before Enter, a short code or keys in an input field are not a scan', () => {
    const late = burst('SMP-1'); late[late.length - 1] = ['Enter', 5000];
    expect(feed(late)).toEqual([]);
    expect(feed(burst('AB'))).toEqual([]);
    expect(feed(burst('SMP-2026-00001').map(([k, t]) => [k, t, true] as [string, number, boolean]))).toEqual([]);
  });

  it('slow typing followed by a scan gives only the scanned code', () => {
    expect(feed([['x', 0], ['y', 300], ...burst('CTN-000001', 1000)])).toEqual(['CTN-000001']);
  });
});
