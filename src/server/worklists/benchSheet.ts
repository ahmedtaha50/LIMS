/**
 * The bench sheet (roadmap M33): the printable run of a worklist, made by the job worklist.bench_sheet so the HTTP request does not wait
 * for the PDF. The sheet lists the run in sequence with empty boxes for the result and the analyst's initials; values are entered in the
 * LIMS, never copied from paper into it without the audit trail, so the sheet says so. The file is stored like every job artifact
 * (src/server/jobs/artifacts.ts, 30 days, checksum on the job) and only the person who asked for it can read it.
 */
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { writeAudit } from '../../db/utils';
import { storeArtifact } from '../jobs/artifacts';
import { JobOutcome, PermanentJobError, type Handler } from '../jobs/types';
import { getWorklist } from './service';

export const BENCH_SHEET_JOB = 'worklist.bench_sheet';

type Detail = Awaited<ReturnType<typeof getWorklist>>;
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));

export function renderBenchSheet(w: Detail, generatedBy: string, at: Date): Buffer {
  const doc = new jsPDF({ orientation: 'landscape' });
  const width = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`Bench sheet ${w.id}`, 14, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const head = [
    ['Title', w.title], ['Method', w.methodCode], ['Instrument', w.instrument ? `${w.instrument.id} ${w.instrument.name} (${w.instrument.type})` : '-'],
    ['Planned', w.plannedDate], ['Status', w.status],
  ];
  autoTable(doc, { startY: 20, body: head, theme: 'plain', styles: { fontSize: 9, cellPadding: 0.8 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 28 } } });
  const body = w.items.filter((i: any) => i.status === 'Active').map((i: any, n: number) => [
    n + 1, i.kind, i.kind === 'Sample' ? `${i.sampleId}\n${dash(i.material)} / ${dash(i.batch)}` : dash(i.label), dash(i.parameter), dash(i.assigneeName), '', '',
  ]);
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 4,
    head: [['#', 'Kind', 'Sample / label', 'Parameter', 'Analyst', 'Result', 'Initials / date']],
    body, theme: 'grid', styles: { fontSize: 8, cellPadding: 2, minCellHeight: 10 }, headStyles: { fillColor: [44, 62, 80] },
    columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 22 }, 5: { cellWidth: 45 }, 6: { cellWidth: 40 } },
  });
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.text(`${w.id} | printed ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC by ${generatedBy} | Enter every value in the LIMS: a value written only on this sheet is not a record. | Page ${p} of ${pages}`,
      width / 2, doc.internal.pageSize.getHeight() - 7, { align: 'center' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

/** job worklist.bench_sheet {worklistId}: renders the sheet and audits it in the transaction that completes the job. */
export const benchSheetHandler: Handler = async (payload, ctx) => {
  const worklistId = typeof payload?.worklistId === 'string' ? payload.worklistId : '';
  if (!worklistId) throw new PermanentJobError('The job has no worklistId.');
  const owner = ctx.job.createdBy;
  if (!owner) throw new PermanentJobError('The job has no owner.');
  const w = await getWorklist(ctx.db, worklistId).catch(() => null);
  if (!w) throw new PermanentJobError(`Worklist ${worklistId} was not found.`);
  const bytes = renderBenchSheet(w, owner, new Date());
  const artifact = storeArtifact(bytes, 'pdf', 'application/pdf', { name: ctx.job.id.replace(/^job-/, '') });
  return new JobOutcome({
    result: { worklistId, bytes: artifact.bytes },
    artifact,
    after: async (tx) => {
      await writeAudit(tx, owner, 'Create', 'WorklistBenchSheet', worklistId, 'document', '', `sha256=${artifact.sha256}; job=${ctx.job.id}; bytes=${artifact.bytes}`, `Bench sheet of ${worklistId} (status ${w.status})`);
    },
  });
};

export const WORKLIST_HANDLERS: Record<string, Handler> = { [BENCH_SHEET_JOB]: benchSheetHandler };
