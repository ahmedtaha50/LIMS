/**
 * The outputs of a worklist (roadmap M33): the run sequence as CSV (an instrument or a spreadsheet reads it) and the bench sheet (PDF,
 * made by the job worklist.bench_sheet, ./benchSheet.ts). The CSV is built here from the same read as the screen; each export is
 * audited, because a copy of a record leaves the system (21 CFR 11.10(b)).
 */
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';
import { withTransaction } from '../core/tx';
import { getWorklist, type Actor } from './service';

/** A cell that a spreadsheet would read as a formula is prefixed with an apostrophe (CSV injection); quotes, commas and line breaks are quoted. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const RUN_SEQUENCE_COLUMNS = ['Sequence', 'Worklist', 'Method', 'Instrument', 'PlannedDate', 'Kind', 'Label', 'SampleId', 'Material', 'Batch', 'Parameter', 'Analyst'] as const;

type Detail = Awaited<ReturnType<typeof getWorklist>>;

/** One row per Active item in run order (1, 2, 3 ...; removed items are not in the run). CRLF line ends, UTF-8. */
export function runSequenceCsv(w: Detail): string {
  const lines: string[] = [RUN_SEQUENCE_COLUMNS.join(',')];
  const active = w.items.filter((i: any) => i.status === 'Active');
  active.forEach((i: any, n: number) => {
    lines.push([
      n + 1, w.id, w.methodCode, w.instrument ? `${w.instrument.id} ${w.instrument.name}` : '', w.plannedDate, i.kind,
      i.kind === 'Sample' ? '' : i.label, i.sampleId, i.material, i.batch, i.parameter, i.assigneeName,
    ].map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

export async function exportRunSequence(db: Db, actor: Actor, id: string) {
  const w = await getWorklist(db, id);
  const csv = runSequenceCsv(w);
  const rows = w.items.filter((i: any) => i.status === 'Active').length;
  await withTransaction(db, tx => writeAudit(tx, actor.id, 'Export', 'Worklist', id, 'run-sequence', '', `${rows} row(s), status ${w.status}`, 'Run sequence exported as CSV'));
  return { fileName: `${w.id}-run-sequence.csv`, csv };
}
