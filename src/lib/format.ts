// Locale-safe formatting of GxP values (roadmap M38, r3-i18n). Owned by r3-i18n. Imports nothing from the screens.
//
// WHY. toLocaleString / toLocaleDateString / toLocaleTimeString print what the operating system's regional settings say: on an Arabic
// Windows PC a timestamp came out with Arabic-Indic digits and a non-Gregorian calendar, which Helvetica in jsPDF cannot draw and
// which a reviewer on another PC reads differently. 04/05/2026 is 4 May in one country and 5 April in another. So nothing here asks
// the system for a locale:
//
//   * the calendar is always Gregorian and the month is always written as a Latin abbreviation ("13 Oct 2026, 12:12:00 GMT+3"),
//     the same text in the English and the Arabic interface, so a date cannot be read two ways;
//   * the time zone offset is always shown (local time zone by default, or UTC / an IANA zone when asked);
//   * digits are Latin and the decimal separator is a point, unless the user chose Arabic-Indic digits for DISPLAY (setDisplayDigits).
//     That choice changes what the screen shows and nothing else: the exportXxx functions, CSV, PDF and everything stored never use it;
//   * a number the user TYPES is never parsed with parseFloat or the locale: parseResultInput accepts a decimal point or Arabic-Indic
//     digits with the Arabic decimal separator and REFUSES a comma (1,5 is 1.5 in one country and 1500 in another). The server
//     validates the same text again (src/lib/numeric.ts parseDecimal) and is the authority.
import { normalizeDigits, parseDecimal } from './numeric';

export type DigitStyle = 'latin' | 'arabic-indic';

let displayDigits: DigitStyle = 'latin';
/** Display only. Set by the language layer from the user's preference; export functions ignore it. */
export function setDisplayDigits(style: DigitStyle): void { displayDigits = style === 'arabic-indic' ? 'arabic-indic' : 'latin'; }
export const getDisplayDigits = (): DigitStyle => displayDigits;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** 0-9 to Arabic-Indic digits and the point to the Arabic decimal separator. Letters (month names, GMT) are left alone. DISPLAY ONLY. */
export function toArabicIndic(text: string): string {
  return text.replace(/\d/g, d => ARABIC_INDIC[Number(d)]).replace(/(?<=[٠-٩])\.(?=[٠-٩])/g, '٫').replace(/(?<=[٠-٩]),(?=[٠-٩])/g, '٬');
}
/** Arabic-Indic and Extended Arabic-Indic digits and the Arabic decimal separator back to 0-9 and '.'. */
export const toLatinDigits = (text: string): string => normalizeDigits(text);

/** What the screen shows: the digits in the user's chosen style. */
const shown = (text: string, style: DigitStyle = displayDigits): string => (style === 'arabic-indic' ? toArabicIndic(text) : text);

export type DateInput = Date | string | number | null | undefined;
export interface FormatOptions {
  /** 'local' (default): the PC's time zone; 'UTC'; or an IANA name such as 'Asia/Riyadh'. */
  timeZone?: string;
  /** Overrides the user's display setting for this call (tests, previews). */
  digits?: DigitStyle;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');
const NONE = '-';

/** "GMT+3", "GMT-5", "GMT+5:30", "GMT" for an offset in minutes east of UTC. */
export function offsetLabel(minutesEast: number): string {
  if (minutesEast === 0) return 'GMT';
  const sign = minutesEast > 0 ? '+' : '-';
  const abs = Math.abs(minutesEast);
  const h = Math.floor(abs / 60), m = abs % 60;
  return `GMT${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; offset: string }

function partsOf(date: Date, timeZone: string | undefined): Parts {
  if (!timeZone || timeZone === 'local') {
    return { y: date.getFullYear(), mo: date.getMonth(), d: date.getDate(), h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(), offset: offsetLabel(-date.getTimezoneOffset()) };
  }
  if (timeZone === 'UTC') {
    return { y: date.getUTCFullYear(), mo: date.getUTCMonth(), d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds(), offset: 'UTC' };
  }
  // A named zone: locale and numbering system are fixed, so the OS setting cannot change a digit.
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'shortOffset',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), offset: p.timeZoneName === 'GMT' ? 'GMT' : p.timeZoneName };
}

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "13 Oct 2026". A bare 'YYYY-MM-DD' (a date without a time: expiry, due date) is written as it is, never shifted by a time zone. */
export function formatDate(v: DateInput, o: FormatOptions = {}): string {
  if (typeof v === 'string') {
    const m = DATE_ONLY.exec(v.trim());
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return shown(`${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`, o.digits);
  }
  const d = toDate(v);
  if (!d) return v === null || v === undefined || v === '' ? NONE : String(v);
  const p = partsOf(d, o.timeZone);
  return shown(`${p.d} ${MONTHS[p.mo]} ${p.y}`, o.digits);
}

/** "13 Oct 2026, 12:12:00 GMT+3": the same in English and Arabic, with the zone. */
export function formatDateTime(v: DateInput, o: FormatOptions = {}): string {
  const d = toDate(v);
  if (!d) return v === null || v === undefined || v === '' ? NONE : String(v);
  const p = partsOf(d, o.timeZone);
  return shown(`${p.d} ${MONTHS[p.mo]} ${p.y}, ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} ${p.offset}`, o.digits);
}

/** For a printout or a file a person reads (PDF header, CSV cell): the same text as formatDateTime but always with Latin digits. */
export const printDateTime = (v: DateInput, o: Omit<FormatOptions, 'digits'> = {}): string => formatDateTime(v, { ...o, digits: 'latin' });
export const printDate = (v: DateInput, o: Omit<FormatOptions, 'digits'> = {}): string => formatDate(v, { ...o, digits: 'latin' });

/** "12:12:00 GMT+3". */
export function formatTime(v: DateInput, o: FormatOptions = {}): string {
  const d = toDate(v);
  if (!d) return v === null || v === undefined || v === '' ? NONE : String(v);
  const p = partsOf(d, o.timeZone);
  return shown(`${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} ${p.offset}`, o.digits);
}

/** For CSV, PDF, file names and anything stored or signed: ISO 8601 in UTC, Latin digits, whatever the user's settings. */
export function exportTimestamp(v: DateInput): string {
  const d = toDate(v);
  return d ? d.toISOString() : '';
}

/**
 * A number for the screen. A decimal STRING (how results are kept) is not converted through a float: its digits are shown as stored.
 * Latin digits, a point, no thousands grouping (a grouping comma next to a result is how 1,5 gets misread) unless `group` is set.
 */
export function formatNumber(v: number | string | null | undefined, o: { decimals?: number; group?: boolean; digits?: DigitStyle } = {}): string {
  if (v === null || v === undefined || v === '') return NONE;
  let text: string;
  if (typeof v === 'string') {
    const parsed = parseDecimal(v);
    if (parsed.ok === false) return v; // '<0.05', 'Conforms': text a result may legitimately hold is shown as it is
    text = parsed.value;
  } else {
    if (!Number.isFinite(v)) return String(v);
    text = o.decimals !== undefined ? v.toFixed(o.decimals) : String(v);
    if (/e/i.test(text)) text = v.toFixed(o.decimals ?? 20).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (o.group) {
    const m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
    if (m) text = `${m[1]}${m[2].replace(/\B(?=(\d{3})+$)/g, ',')}${m[3] ?? ''}`;
  }
  return shown(text, o.digits);
}

/** For CSV / PDF / stored text: the value with Latin digits and a point, whatever the display setting. Not a number: returned unchanged. */
export function exportNumber(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const parsed = parseDecimal(v);
  return parsed.ok === true ? parsed.value : v;
}

export type ResultInput =
  | { ok: true; value: string; normalized: boolean; note?: string }
  | { ok: false; code: 'EMPTY' | 'DECIMAL_COMMA' | 'GROUPING' | 'NOT_A_NUMBER'; message: string };

/**
 * Checks a number a person typed into a result field, BEFORE it is sent. Rules (the server applies the same ones and decides):
 *   "1.5"        accepted
 *   "١٫٥"        accepted as 1.5 (Arabic-Indic digits with the Arabic decimal separator); `normalized` tells the screen to show "read as 1.5"
 *   "1,5" "1،5"  REFUSED (DECIMAL_COMMA): it is 1.5 in some countries and 1500 in others, so nothing guesses; write 1.5
 *   "1,234.5"    REFUSED (GROUPING)
 *   "1e3", ".5", "5.", "abc"  REFUSED
 * Never parseFloat, never the locale.
 */
export function parseResultInput(text: string): ResultInput {
  const raw = (text ?? '').trim();
  if (!raw) return { ok: false, code: 'EMPTY', message: 'Enter a value.' };
  const latin = normalizeDigits(raw);
  if (/^[+-]?\d+[,،]\d+$/.test(latin)) {
    return { ok: false, code: 'DECIMAL_COMMA', message: `"${raw}" has a comma: write the decimal point as "." (for example ${latin.replace(/[,،]/, '.')}). A comma could be read as a decimal separator or as thousands.` };
  }
  const parsed = parseDecimal(raw);
  if (parsed.ok === false) {
    return { ok: false, code: /[,٬،]/.test(raw) || /\d\s+\d/.test(raw) ? 'GROUPING' : 'NOT_A_NUMBER', message: parsed.error };
  }
  const normalized = parsed.value !== raw;
  return { ok: true, value: parsed.value, normalized, ...(normalized ? { note: `Read as ${parsed.value}.` } : {}) };
}
