// Numbers as a person types them into a GxP record (roadmap M10). Owned by r1-results-oos. Shared by the server and the screens,
// so it imports nothing.
//
// A result is kept and compared as a DECIMAL STRING, never as a binary float: 0.005 stored in a `real` column reads back as
// 0.004999999888, and parseFloat('1,234.5') is 1. The rules:
//
//   parseDecimal(s)        accepts [+|-]digits[.digits] after trimming; Arabic-Indic (U+0660-0669) and Extended Arabic-Indic
//                          (U+06F0-06F9) digits are read as the digits they are, U+066B (Arabic decimal separator) as '.'.
//                          Refused: thousands separators (',', U+066C, spaces inside), exponents, '.5', '5.', anything else.
//   compareDecimal(a, b)   -1, 0, 1 by value ('0.005' equals '0.0050')
//   roundHalfUp(v, d)      USP General Notices 7.20: round to d places on the one digit after the last place (5 and above round
//                          away from zero); the result is written with exactly d places.

export type ParsedDecimal = { ok: true; value: string } | { ok: false; error: string };

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Arabic-Indic digits and the Arabic decimal separator to ASCII; trims the ends. */
export function normalizeDigits(input: string): string {
  return input.trim().replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.');
}

export function parseDecimal(input: unknown): ParsedDecimal {
  if (typeof input !== 'string') return { ok: false, error: 'The value must be text.' };
  const s = normalizeDigits(input);
  const m = DECIMAL.exec(s);
  if (!m) {
    if (/[,٬]/.test(s) || /\d\s+\d/.test(s)) return { ok: false, error: `"${input.trim()}" is not a number: write it without thousands separators (for example 1234.5).` };
    return { ok: false, error: `"${input.trim()}" is not a number (write digits with an optional sign and decimal point, for example 98.5).` };
  }
  return { ok: true, value: `${m[1] === '-' ? '-' : ''}${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}` };
}

/** Sign, integer digits and fraction digits of a value that parseDecimal accepted (or a limit written as a JS number). */
function parts(v: string): { neg: boolean; int: string; frac: string } {
  const m = DECIMAL.exec(v);
  if (!m) throw new Error(`Not a decimal: ${v}`);
  return { neg: m[1] === '-', int: m[2], frac: m[3] ?? '' };
}

function scaled(v: string, places: number): bigint {
  const p = parts(v);
  const n = BigInt(p.int + p.frac.padEnd(places, '0'));
  return p.neg ? -n : n;
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const places = Math.max(parts(a).frac.length, parts(b).frac.length);
  const x = scaled(a, places);
  const y = scaled(b, places);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function roundHalfUp(v: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`Decimals must be a whole number >= 0, got ${decimals}`);
  const p = parts(v);
  const frac = p.frac.padEnd(decimals + 1, '0');
  let n = BigInt(p.int + frac.slice(0, decimals));
  if (Number(frac[decimals]) >= 5) n += 1n;
  const digits = n.toString().padStart(decimals + 1, '0');
  const int = digits.slice(0, digits.length - decimals);
  const out = decimals > 0 ? `${int}.${digits.slice(-decimals)}` : int;
  return p.neg && n !== 0n ? `-${out}` : out;
}

/** A limit held as a JS number (JSON), written as text: to its declared decimals when there are some, else as JS writes it. */
export function limitText(n: number | null | undefined, decimals: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 20) return n.toFixed(decimals);
  const s = String(n);
  return DECIMAL.test(s) ? s : n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}
