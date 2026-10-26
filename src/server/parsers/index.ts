// The parser registry (roadmap M21). A profile names a parser by id; adding an instrument format is one file and one entry here.
import { ParseError, type ParsedRow, type Parser } from './types';
import { balanceText } from './balanceText';
import { genericCsv } from './genericCsv';
import { hplcSummaryCsv } from './hplcSummaryCsv';
import { phCsv } from './phCsv';

export type { ParsedRow, Parser } from './types';
export { ParseError } from './types';

export const PARSERS: Readonly<Record<string, Parser<any>>> = {
  [genericCsv.id]: genericCsv,
  [balanceText.id]: balanceText,
  [phCsv.id]: phCsv,
  [hplcSummaryCsv.id]: hplcSummaryCsv,
};

export const parserList = () => Object.values(PARSERS).map(p => ({ id: p.id, label: p.label }));

/** The mapping with its defaults filled in, or the problems found (path and message), for a parser id. */
export function checkMapping(parserId: string, mapping: unknown): { ok: true; mapping: Record<string, unknown> } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const parser = PARSERS[parserId];
  if (!parser) return { ok: false, issues: [{ path: 'parser', message: `Unknown parser "${parserId}".` }] };
  const parsed = parser.mapping.safeParse(mapping ?? {});
  return parsed.success
    ? { ok: true, mapping: parsed.data as Record<string, unknown> }
    : { ok: false, issues: parsed.error.issues.map(i => ({ path: ['mapping', ...i.path].join('.'), message: i.message })) };
}

/**
 * Parses file text with a profile's parser and mapping (dry run: nothing is stored). Throws ParseError with a readable message.
 * Rejects an empty parameter, more rows than MAX_ROWS and a value that is not a number, whatever the parser did.
 */
export const MAX_ROWS = 5000;

export function parseInstrumentFile(parserId: string, mapping: unknown, text: string): ParsedRow[] {
  const parser = PARSERS[parserId];
  if (!parser) throw new ParseError(`unknown parser "${parserId}".`);
  const checked = checkMapping(parserId, mapping);
  if (!checked.ok) throw new ParseError(`the profile's mapping is not valid: ${checked.issues.map(i => `${i.path}: ${i.message}`).join('; ')}`);
  if (text.includes('\u0000')) throw new ParseError('the file contains binary data (NUL bytes); it is not a text export.');
  const rows = parser.parse(text, checked.mapping);
  if (rows.length === 0) throw new ParseError('the file contains no measured value.');
  if (rows.length > MAX_ROWS) throw new ParseError(`the file has ${rows.length} values; at most ${MAX_ROWS} are read from one file.`);
  return rows;
}
