/**
 * Barcodes for labels (roadmap M29): Code 128 (ISO/IEC 15417) drawn here, and QR through the `qrcode` package the application
 * already ships. Both are returned as SVG text, so a label prints sharply at any size and needs no canvas.
 *
 * Code 128 uses code set B for printable ASCII (32-126) and code set C for an all-digit text of even length (two digits per symbol).
 * Every symbol is 11 modules (the stop 13); the check symbol is the weighted sum modulo 103. The width table and the encoder are tested
 * against an independent encoder (tests/unit/custody/barcode.test.ts records how). A character outside printable ASCII is refused:
 * a label must never encode something other than what it shows.
 */
import QRCode from 'qrcode';

/** Bar and space widths of the symbols 0..106, bar first (106 is the stop). */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
] as const;

const START_B = 104;
const START_C = 105;
const STOP = 106;

export class BarcodeError extends Error {}

/** The symbol values of `text`: start, data, check (the stop is added by code128Modules). */
export function code128Values(text: string): number[] {
  if (!text) throw new BarcodeError('A barcode needs a text.');
  if (text.length > 80) throw new BarcodeError('A Code 128 label text is at most 80 characters.');
  let values: number[];
  if (/^\d+$/.test(text) && text.length % 2 === 0) {
    values = [START_C];
    for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)));
  } else {
    values = [START_B];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch.length !== 1 || code < 32 || code > 126) throw new BarcodeError(`"${ch}" cannot be encoded in a Code 128 label (printable ASCII only).`);
      values.push(code - 32);
    }
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  return values;
}

/** Module widths, bar first, alternating bar and space, through the stop. */
export function code128Modules(text: string): number[] {
  return [...code128Values(text), STOP].flatMap(v => [...PATTERNS[v]].map(Number));
}

export interface SvgOptions {
  /** Width of the narrowest bar in SVG user units (default 1). */
  module?: number;
  /** Bar height in user units (default 40). */
  height?: number;
  /** Quiet zone each side, in modules (default 10, the minimum of the standard). */
  quiet?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A Code 128 symbol as SVG text. `aria-label` carries the encoded text. */
export function code128Svg(text: string, o: SvgOptions = {}): string {
  const m = o.module ?? 1;
  const h = o.height ?? 40;
  const quiet = o.quiet ?? 10;
  const widths = code128Modules(text);
  let x = quiet;
  const bars: string[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(`<rect x="${x * m}" y="0" width="${w * m}" height="${h}"/>`);
    x += w;
  });
  const total = (x + quiet) * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(text)}"><rect width="${total}" height="${h}" fill="#fff"/><g fill="#000">${bars.join('')}</g></svg>`;
}

/** A QR symbol (error correction M, quiet zone 2) as SVG text. */
export async function qrSvg(text: string): Promise<string> {
  if (!text) throw new BarcodeError('A QR code needs a text.');
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

export type Symbology = 'code128' | 'qr';

/** The symbol for a label, as SVG text. */
export const barcodeSvg = (symbology: Symbology, text: string): Promise<string> =>
  symbology === 'qr' ? qrSvg(text) : Promise.resolve(code128Svg(text));
