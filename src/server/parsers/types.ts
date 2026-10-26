// The shape every instrument-file parser returns (roadmap M21). A parser is pure: text and a mapping in, rows out, or a ParseError that
// says in plain words what is wrong and on which line. It never touches the database or the file system.
import type { ZodType } from 'zod';

/** One measured value found in a file. `line` is the 1-based line of the source file; `raw` keeps the cells as exported. */
export interface ParsedRow {
  line: number;
  sampleRef: string | null;
  parameter: string;
  /** The number as the instrument wrote it (never rounded or reformatted), with a decimal point. */
  value: string;
  unit: string | null;
  raw: Record<string, string>;
}

export class ParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = 'ParseError';
  }
}

export interface Parser<M = Record<string, unknown>> {
  id: string;
  label: string;
  /** The mapping this parser accepts (strict: an unknown key is an error, so a typo cannot silently change the meaning). */
  mapping: ZodType<M>;
  parse(text: string, mapping: M): ParsedRow[];
}
