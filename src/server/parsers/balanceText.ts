// Balance print-out (RS-232 / USB "print" text). Two layouts are read:
//   labelled   "Sample ID: SMP-2026-00001" on a line of its own, then "Net: 12.3456 g" (or "N", "Weight", "W")
//   bare       "N      12.3456 g", "+   12.3456 g" or "12.3456 g S", one reading per line, no sample id
// A reading belongs to the Sample ID line just above it. Gross and tare readings are ignored (the net value is the result); every
// other line (date, balance model, signature lines) is ignored. A file with no reading is an error, not an empty import.
import { z } from 'zod';
import { mapName, nameMapSchema } from './csv';
import { ParseError, type Parser, type ParsedRow } from './types';

export const balanceTextMapping = z.object({
  parameter: z.string().trim().min(1).max(200).default('Weight'),
  parameterMap: nameMapSchema.optional(),
}).strict();
export type BalanceTextMapping = z.infer<typeof balanceTextMapping>;

const SAMPLE_LINE = /^\s*(?:sample\s*(?:id|no\.?|name)?|id)\s*[:=]\s*(.+?)\s*$/i;
const READING = /^\s*(?:([A-Za-z]+)\s*[:=]?\s*)?([+-]?)\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(µg|ug|mg|kg|g)\b/i;
const IGNORED_LABELS = new Set(['gross', 'g', 'tare', 't']);
const NET_LABELS = new Set(['net', 'n', 'weight', 'w', 'wt']);

export const balanceText: Parser<BalanceTextMapping> = {
  id: 'balance-text',
  label: 'Balance print-out (text)',
  mapping: balanceTextMapping,
  parse(text, m) {
    const rows: ParsedRow[] = [];
    let sampleRef: string | null = null;
    text.replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((content, idx) => {
      const line = idx + 1;
      const s = SAMPLE_LINE.exec(content);
      if (s) { sampleRef = s[1]; return; }
      const r = READING.exec(content);
      if (!r) return;
      const label = r[1]?.toLowerCase();
      if (label && IGNORED_LABELS.has(label)) return;
      if (label && !NET_LABELS.has(label)) return;
      const digits = r[3].replace(',', '.');
      rows.push({
        line, sampleRef, parameter: mapName(m.parameterMap, m.parameter), value: (r[2] === '-' ? '-' : '') + (digits.startsWith('.') ? `0${digits}` : digits),
        unit: r[4].toLowerCase() === 'ug' ? 'µg' : r[4].toLowerCase(), raw: { text: content.trim() },
      });
      sampleRef = null;
    });
    if (rows.length === 0) throw new ParseError('no weight reading found (expected lines such as "N 12.3456 g" or "Net: 12.3456 g").');
    return rows;
  },
};
