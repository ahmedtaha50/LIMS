// pH meter export: one measurement per row with the sample name, the pH and usually the temperature (kept in `raw`).
import { z } from 'zod';
import { delimiterSchema, numberText, rawOf, readTable, requireColumn } from './csv';
import { ParseError, type Parser } from './types';

const name = z.string().trim().min(1).max(200);

export const phCsvMapping = z.object({
  delimiter: delimiterSchema,
  sampleColumn: name.optional(),
  phColumn: name.optional(),
  parameter: name.default('pH'),
  decimalComma: z.boolean().default(false),
}).strict();
export type PhCsvMapping = z.infer<typeof phCsvMapping>;

const SAMPLE_NAMES = ['Sample ID', 'SampleID', 'Sample', 'Sample Name', 'ID'];
const PH_NAMES = ['pH', 'pH value', 'pH-Value'];

export const phCsv: Parser<PhCsvMapping> = {
  id: 'ph-csv',
  label: 'pH meter CSV',
  mapping: phCsvMapping,
  parse(text, m) {
    const { header, rows } = readTable(text, m.delimiter);
    const sample = requireColumn(header, m.sampleColumn ? [m.sampleColumn] : SAMPLE_NAMES, 'the sample');
    const ph = requireColumn(header, m.phColumn ? [m.phColumn] : PH_NAMES, 'the pH');
    return rows.map(r => {
      const value = numberText(r.cells[ph], r.line, 'the pH', m.decimalComma);
      const n = Number(value);
      if (n < 0 || n > 14) throw new ParseError(`pH ${value} is outside 0 to 14.`, r.line);
      const ref = r.cells[sample].trim();
      return { line: r.line, sampleRef: ref || null, parameter: m.parameter, value, unit: null, raw: rawOf(header, r.cells) };
    });
  },
};
