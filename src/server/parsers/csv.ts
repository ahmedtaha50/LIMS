// A small RFC 4180 reader shared by the CSV parsers: quoted cells, doubled quotes, line breaks inside quotes, a byte-order mark,
// blank lines skipped. Lines are numbered as in the source file so an error can name the line the analyst sees in a text editor.
import { z } from 'zod';
import { ParseError, type ParsedRow } from './types';

export interface CsvRecord { line: number; cells: string[] }

export function readCsv(text: string, delimiter: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let quoteLine = 1;
  let atStart = true; // nothing read yet on this record
  const endRecord = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0].trim() === '' && atStart)) records.push({ line: startLine, cells });
    cells = []; cell = ''; atStart = true;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else { if (ch === '\n') line++; cell += ch; }
      continue;
    }
    if (atStart) { startLine = line; }
    if (ch === '"' && cell === '') { inQuotes = true; quoteLine = line; atStart = false; }
    else if (ch === delimiter) { cells.push(cell); cell = ''; atStart = false; }
    else if (ch === '\r') { if (src[i + 1] === '\n') i++; line++; endRecord(); }
    else if (ch === '\n') { line++; endRecord(); }
    else { cell += ch; atStart = false; }
  }
  if (inQuotes) throw new ParseError('a quoted cell is never closed (missing ").', quoteLine);
  if (cell !== '' || cells.length) endRecord();
  return records;
}

/** A table: the first record names the columns. Every later record must have as many cells. */
export function readTable(text: string, delimiter: string): { header: string[]; rows: CsvRecord[] } {
  const records = readCsv(text, delimiter);
  if (records.length === 0) throw new ParseError('the file is empty.');
  const header = records[0].cells.map(c => c.trim());
  if (header.length < 2 && records.length > 1 && records[1].cells.length > 1) {
    throw new ParseError(`the header has one column but the data has ${records[1].cells.length}: check the delimiter in the mapping.`, records[0].line);
  }
  const rows = records.slice(1);
  for (const r of rows) {
    if (r.cells.length !== header.length) throw new ParseError(`expected ${header.length} cells (as in the header) but found ${r.cells.length}.`, r.line);
  }
  if (rows.length === 0) throw new ParseError('the file has a header but no data row.');
  return { header, rows };
}

/** The index of the column called `name` (case and surrounding spaces ignored), or -1. */
export function columnIndex(header: string[], name: string): number {
  const n = name.trim().toLowerCase();
  return header.findIndex(h => h.toLowerCase() === n);
}

/** The first of `names` that is a column of the header; a ParseError naming what was looked for when none is. */
export function requireColumn(header: string[], names: string[], what: string): number {
  for (const n of names) { const i = columnIndex(header, n); if (i >= 0) return i; }
  throw new ParseError(`no column for ${what} (looked for: ${names.join(', ')}; the header has: ${header.join(', ') || 'nothing'}).`, 1);
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** The number as text with a decimal point, or a ParseError. The digits are never changed. */
export function numberText(cell: string, line: number, what: string, decimalComma = false): string {
  const t = cell.trim();
  const v = decimalComma ? t.replace(',', '.') : t;
  if (!NUMBER.test(v)) throw new ParseError(`${what} "${t}" is not a number.`, line);
  return v.startsWith('+') ? v.slice(1) : v;
}

export const delimiterSchema = z.enum([',', ';', '\t']).default(',');
export const nameMapSchema = z.record(z.string().min(1).max(200), z.string().min(1).max(200));

export const mapName = (map: Record<string, string> | undefined, name: string) => map?.[name] ?? name;

export function rawOf(header: string[], cells: string[]): ParsedRow['raw'] {
  const raw: ParsedRow['raw'] = {};
  header.forEach((h, i) => { raw[h || `column${i + 1}`] = cells[i].trim(); });
  return raw;
}
