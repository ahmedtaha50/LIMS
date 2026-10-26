// Generic CSV: one measured value per row. The mapping names the columns (or a fixed parameter / unit), so any delimited export works
// once QA has approved how its columns are read.
import { z } from 'zod';
import { delimiterSchema, mapName, nameMapSchema, numberText, rawOf, readTable, requireColumn, columnIndex } from './csv';
import { ParseError, type Parser, type ParsedRow } from './types';

const name = z.string().trim().min(1).max(200);

export const genericCsvMapping = z.object({
  delimiter: delimiterSchema,
  sampleColumn: name.optional(),
  parameterColumn: name.optional(),
  fixedParameter: name.optional(),
  valueColumn: name,
  unitColumn: name.optional(),
  fixedUnit: z.string().trim().min(1).max(40).optional(),
  decimalComma: z.boolean().default(false),
  parameterMap: nameMapSchema.optional(),
}).strict().refine(m => Boolean(m.parameterColumn) !== Boolean(m.fixedParameter), {
  message: 'give exactly one of parameterColumn (the column that names the parameter) and fixedParameter (one parameter for every row).',
  path: ['parameterColumn'],
});
export type GenericCsvMapping = z.infer<typeof genericCsvMapping>;

export const genericCsv: Parser<GenericCsvMapping> = {
  id: 'generic-csv',
  label: 'Generic CSV (one value per row)',
  mapping: genericCsvMapping,
  parse(text, m) {
    const { header, rows } = readTable(text, m.delimiter);
    const value = requireColumn(header, [m.valueColumn], 'the value');
    const sample = m.sampleColumn ? requireColumn(header, [m.sampleColumn], 'the sample') : -1;
    const param = m.parameterColumn ? requireColumn(header, [m.parameterColumn], 'the parameter') : -1;
    const unit = m.unitColumn ? requireColumn(header, [m.unitColumn], 'the unit') : -1;
    return rows.map((r): ParsedRow => {
      const parameter = mapName(m.parameterMap, m.fixedParameter ?? r.cells[param].trim());
      if (!parameter) throw new ParseError('the parameter cell is empty.', r.line);
      const ref = sample >= 0 ? r.cells[sample].trim() : '';
      return {
        line: r.line, sampleRef: ref || null, parameter,
        value: numberText(r.cells[value], r.line, `the value of ${parameter}`, m.decimalComma),
        unit: (unit >= 0 ? r.cells[unit].trim() : m.fixedUnit ?? '') || null, raw: rawOf(header, r.cells),
      };
    });
  },
};
export { columnIndex };
