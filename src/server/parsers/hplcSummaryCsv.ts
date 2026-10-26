// HPLC / CDS summary export: one row per sample and component (peak), with an amount or an area. Only this summary enters the LIMS;
// the chromatograms and the integration stay in the chromatography data system, which remains the record of the raw data.
import { z } from 'zod';
import { delimiterSchema, mapName, nameMapSchema, numberText, rawOf, readTable, requireColumn } from './csv';
import { ParseError, type Parser } from './types';

const name = z.string().trim().min(1).max(200);

export const hplcSummaryMapping = z.object({
  delimiter: delimiterSchema,
  sampleColumn: name.optional(),
  componentColumn: name.optional(),
  valueColumn: name.optional(),
  unitColumn: name.optional(),
  fixedUnit: z.string().trim().min(1).max(40).optional(),
  decimalComma: z.boolean().default(false),
  parameterMap: nameMapSchema.optional(),
}).strict();
export type HplcSummaryMapping = z.infer<typeof hplcSummaryMapping>;

const SAMPLE_NAMES = ['Sample Name', 'Sample ID', 'SampleName', 'Sample'];
const COMPONENT_NAMES = ['Component', 'Component Name', 'Peak Name', 'Name', 'Analyte'];
const VALUE_NAMES = ['Amount', 'Calculated Amount', 'Concentration', 'Area'];

export const hplcSummaryCsv: Parser<HplcSummaryMapping> = {
  id: 'hplc-summary-csv',
  label: 'HPLC summary CSV (amount or area per component)',
  mapping: hplcSummaryMapping,
  parse(text, m) {
    const { header, rows } = readTable(text, m.delimiter);
    const sample = requireColumn(header, m.sampleColumn ? [m.sampleColumn] : SAMPLE_NAMES, 'the sample');
    const component = requireColumn(header, m.componentColumn ? [m.componentColumn] : COMPONENT_NAMES, 'the component');
    const value = requireColumn(header, m.valueColumn ? [m.valueColumn] : VALUE_NAMES, 'the amount or area');
    const unit = m.unitColumn ? requireColumn(header, [m.unitColumn], 'the unit') : -1;
    return rows.map(r => {
      const comp = r.cells[component].trim();
      if (!comp) throw new ParseError('the component name is empty.', r.line);
      const parameter = mapName(m.parameterMap, comp);
      const ref = r.cells[sample].trim();
      return {
        line: r.line, sampleRef: ref || null, parameter, value: numberText(r.cells[value], r.line, `the value of ${comp}`, m.decimalComma),
        unit: (unit >= 0 ? r.cells[unit].trim() : m.fixedUnit ?? '') || null, raw: rawOf(header, r.cells),
      };
    });
  },
};
