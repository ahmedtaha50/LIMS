/**
 * Roadmap M38 (r3-i18n): src/lib/format.ts. Dates and numbers mean the same in every language and on every PC; a typed result is never
 * parsed by the locale; the Arabic-Indic display setting never reaches an export.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportNumber, exportTimestamp, formatDate, formatDateTime, formatNumber, formatTime, offsetLabel, parseResultInput, setDisplayDigits, toArabicIndic, toLatinDigits,
} from '../../../src/lib/format';

const T = new Date('2026-10-13T09:12:00.000Z');
afterEach(() => setDisplayDigits('latin'));

describe('timestamps', () => {
  it('print the day, the month name, the year, the time and the UTC offset: 13 Oct 2026, 12:12:00 GMT+3', () => {
    expect(formatDateTime(T, { timeZone: 'Asia/Riyadh' })).toBe('13 Oct 2026, 12:12:00 GMT+3');
    expect(formatDateTime(T, { timeZone: 'UTC' })).toBe('13 Oct 2026, 09:12:00 UTC');
    expect(formatDateTime(T, { timeZone: 'Asia/Kolkata' })).toBe('13 Oct 2026, 14:42:00 GMT+5:30');
    expect(formatDateTime(T, { timeZone: 'America/New_York' })).toBe('13 Oct 2026, 05:12:00 GMT-4');
    expect(formatTime(T, { timeZone: 'Asia/Riyadh' })).toBe('12:12:00 GMT+3');
    expect(formatDate(T, { timeZone: 'Asia/Riyadh' })).toBe('13 Oct 2026');
  });

  it('use the PC time zone for "local" and always show its offset', () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Riyadh';
      expect(formatDateTime(T)).toBe('13 Oct 2026, 12:12:00 GMT+3');
      process.env.TZ = 'Europe/London';
      expect(formatDateTime(T)).toBe('13 Oct 2026, 10:12:00 GMT+1');
      process.env.TZ = 'UTC';
      expect(formatDateTime(T)).toBe('13 Oct 2026, 09:12:00 GMT');
    } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  });

  it('are not the text the operating system would print (what toLocaleString gave on an Arabic PC)', () => {
    const system = T.toLocaleString('ar-SA-u-nu-arab', { timeZone: 'Asia/Riyadh' }); // digits named explicitly: independent of the CLDR default of the Node build
    expect(system).toMatch(/[٠-٩]/);               // Arabic-Indic digits: the old output
    expect(formatDateTime(T, { timeZone: 'Asia/Riyadh' })).not.toMatch(/[٠-٩]/);
    expect(formatDateTime(T, { timeZone: 'Asia/Riyadh' })).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2} (GMT|UTC)/);
  });

  it('cannot be read two ways: 4 May and 5 April are different words', () => {
    expect(formatDate('2026-05-04')).toBe('4 May 2026');
    expect(formatDate('2026-04-05')).toBe('5 Apr 2026');
  });

  it('a date without a time is not shifted by the time zone', () => {
    const was = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Riyadh']) { process.env.TZ = tz; expect(formatDate('2026-01-01'), tz).toBe('1 Jan 2026'); }
    } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  });

  it('a missing value is a dash, an unreadable one is shown as it is (never "Invalid Date")', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime('not a date')).toBe('not a date');
    expect(formatDate('not a date')).toBe('not a date');
  });

  it('offsetLabel', () => {
    expect([0, 180, -300, 330, -210, 765].map(offsetLabel)).toEqual(['GMT', 'GMT+3', 'GMT-5', 'GMT+5:30', 'GMT-3:30', 'GMT+12:45']);
  });
});

describe('Arabic-Indic display digits', () => {
  it('change only the digits on screen, never month names or the zone', () => {
    setDisplayDigits('arabic-indic');
    expect(formatDateTime(T, { timeZone: 'Asia/Riyadh' })).toBe('١٣ Oct ٢٠٢٦, ١٢:١٢:٠٠ GMT+٣');
    expect(formatNumber('12.50')).toBe('١٢٫٥٠');
    expect(formatNumber(1234.5, { group: true })).toBe('١٬٢٣٤٫٥');
  });

  it('never reach an export: ISO timestamp and Latin numbers stay', () => {
    setDisplayDigits('arabic-indic');
    expect(exportTimestamp(T)).toBe('2026-10-13T09:12:00.000Z');
    expect(exportNumber('12.50')).toBe('12.50');
    expect(exportNumber(3.25)).toBe('3.25');
    expect(exportNumber('<0.05')).toBe('<0.05');
    expect(exportNumber(null)).toBe('');
  });

  it('round-trip exactly', () => {
    expect(toLatinDigits(toArabicIndic('0123456789.5'))).toBe('0123456789.5');
    expect(toArabicIndic('GMT+3 v1.2')).toBe('GMT+٣ v١٫٢');
  });
});

describe('numbers', () => {
  it('a decimal string keeps every digit it was stored with (no float round trip)', () => {
    expect(formatNumber('0.005')).toBe('0.005');
    expect(formatNumber('98.50')).toBe('98.50');
    expect(formatNumber('123456789012345678.123456789')).toBe('123456789012345678.123456789');
    expect(formatNumber('<0.05')).toBe('<0.05');
    expect(formatNumber('Conforms')).toBe('Conforms');
  });

  it('use a point, Latin digits, and no grouping unless asked', () => {
    expect(formatNumber(1234.5)).toBe('1234.5');
    expect(formatNumber(1234.5, { decimals: 2 })).toBe('1234.50');
    expect(formatNumber(1234567.891, { group: true })).toBe('1,234,567.891');
    expect(formatNumber(0.0000001)).toBe('0.0000001');
    expect(formatNumber(null)).toBe('-');
    expect(formatNumber(Number.NaN)).toBe('NaN');
  });
});

describe('a number typed into a result is never guessed', () => {
  const ok = (s: string) => { const r = parseResultInput(s); expect(r.ok, s).toBe(true); return r as Extract<typeof r, { ok: true }>; };
  const no = (s: string) => { const r = parseResultInput(s); expect(r.ok, s).toBe(false); return r as Extract<typeof r, { ok: false }>; };

  it('1.5 is 1.5', () => { expect(ok('1.5')).toMatchObject({ value: '1.5', normalized: false }); expect(ok(' 98.50 ').value).toBe('98.50'); expect(ok('-0.05').value).toBe('-0.05'); });

  it('Arabic-Indic digits with the Arabic separator are read as 1.5 and the screen is told', () => {
    expect(ok('١٫٥')).toMatchObject({ value: '1.5', normalized: true, note: 'Read as 1.5.' });
    expect(ok('٩٨٫٥٠').value).toBe('98.50');
    expect(ok('۹۸.۵').value).toBe('98.5'); // Extended Arabic-Indic (Persian/Urdu)
  });

  it('1,5 is refused, not read as 1.5 and not as 15 or 1500', () => {
    for (const s of ['1,5', '1،5', '١,٥', '98,5']) {
      const r = no(s);
      expect(r.code, s).toBe('DECIMAL_COMMA');
      expect(r.message).toContain('.');
    }
  });

  it('a thousands separator, an exponent, a bare point, text and the empty string are refused', () => {
    expect(no('1,234.5').code).toBe('GROUPING');
    expect(no('1 234.5').code).toBe('GROUPING');
    expect(no('1٬234').code).toBe('GROUPING');
    for (const s of ['1e3', '.5', '5.', 'abc', '1.2.3', '--1', '0x10', '1/2', '∞']) expect(no(s).code, s).toBe('NOT_A_NUMBER');
    expect(no('').code).toBe('EMPTY');
    expect(no('   ').code).toBe('EMPTY');
  });

  it('agrees with the server rule (parseDecimal) on every sample, so the screen never accepts what the server refuses', async () => {
    const { parseDecimal } = await import('../../../src/lib/numeric');
    for (const s of ['1.5', '1,5', '١٫٥', '1,234.5', '1e3', '.5', '5.', '+7', '-7.0', '0', '00.10', '٠', '1 2', 'x', '']) {
      const mine = parseResultInput(s), server = parseDecimal(s);
      expect(mine.ok, s).toBe(server.ok);
      if (mine.ok && server.ok) expect(mine.value, s).toBe(server.value);
    }
  });
});
