/**
 * The one PDF engine of the Certificate of Analysis (roadmap M25). jsPDF on the server: offline, no browser, testable. It prints a
 * frozen snapshot (./snapshot.ts) and the signatures of the document, nothing it reads itself. The watermark comes from the state of
 * the document at the moment the copy is made (watermarkFor), never from the caller.
 */
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable'; // v5 adds no doc.autoTable() outside a browser: the function is called with the document
import type { CoaSnapshot } from './snapshot';

export interface SignatureBlock { meaning: string; signerName: string; signerRole: string; timestamp: string; reason?: string | null }

export interface CopyInfo {
  copyNo: number;
  purpose: 'Original' | 'Copy';
  /** The state of the document when this copy was made. */
  status: string;
  generatedAt: Date;
  generatedByName: string;
}

/** The mark printed across every page, from the document's state. An issued certificate carries none. */
export function watermarkFor(status: string): string | null {
  switch (status) {
    case 'Issued': return null;
    case 'Superseded': return 'SUPERSEDED';
    case 'Voided': return 'VOID';
    case 'Preview': return 'PREVIEW - NOT ISSUED';
    default: return 'NOT VALID';
  }
}

/** 2026-10-04 12:00:00 UTC */
export function utc(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '-' : v);

/**
 * Renders a certificate. `copy` null is a preview: no number, no copy, a PREVIEW mark and a statement that it is not a certificate
 * (src/server/pdfWorker.ts). Returns the PDF bytes.
 */
export function renderCoaPdf(input: { snapshot: CoaSnapshot; signatures: readonly SignatureBlock[]; copy: CopyInfo | null }): Buffer {
  const { snapshot: s, copy } = input;
  const preview = copy === null || s.certificate === null;
  const status = preview ? 'Preview' : copy!.status;
  const mark = watermarkFor(status);
  const doc = new jsPDF();
  const width = doc.internal.pageSize.getWidth();
  const left = 14;
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(preview ? 'Results preview - not a Certificate of Analysis' : 'Certificate of Analysis', left, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  y += 7;
  const head: Array<[string, string]> = preview
    ? [['Document', 'Preview generated for review. It has no number and no authorisation.'], ['Generated', utc(new Date())]]
    : [
      ['Certificate No.', s.certificate!.label],
      ['Status', status],                       // the capital mark across the page is the watermark's (watermarkFor)
      ['Issued', s.issuedAt ? utc(s.issuedAt) : '-'],
      ['Copy', `Copy ${copy!.copyNo} (${copy!.purpose === 'Original' ? 'Original' : 'Controlled copy'})`],
    ];
  if (!preview && s.supersedes) head.push(['Supersedes', `Supersedes ${s.supersedes.label}: ${s.supersedes.reason}`]);
  for (const [k, v] of head) { doc.setFont('helvetica', 'bold'); doc.text(`${k}:`, left, y); doc.setFont('helvetica', 'normal'); doc.text(v, left + 32, y); y += 5; }

  y += 2;
  const ident: string[][] = [
    ['Product / material', s.product ? `${s.product.name} (${s.product.code})` : s.sample.material],
    ['Batch', s.sample.batch],
    ['Manufactured', dash(s.batch?.manufacturedOn)],
    ['Expiry', dash(s.batch?.expiresOn)],
    ['Batch size', dash(s.batch?.batchSize)],
    ['Sample', `${s.sample.id} - Status: ${s.sample.state} - registered ${utc(s.sample.registeredAt)}`],
    ['Customer', s.customer ? `${s.customer.name} (${s.customer.code})` : '-'],
    ['Specification', s.specification ? `${s.specification.id}, Revision ${s.specification.revision}, effective ${s.specification.effectiveDate}` : 'No specification recorded'],
  ];
  autoTable(doc, { startY: y, body: ident, theme: 'plain', styles: { fontSize: 9, cellPadding: 1 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } } });
  y = (doc as any).lastAutoTable.finalY + 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Results', left, y);
  const body = s.results.map(r => [
    r.kind === 'Result' ? r.parameter : `${r.parameter} (${r.kind}${r.kind === 'Original' && r.oos ? `, ${r.oos.id}` : ''})`,
    r.method ? `${r.method.code}${r.method.revision !== null ? ` Rev ${r.method.revision}` : ''}` : '-',
    r.specText,
    `${r.value === null || r.value === '' ? 'Not entered' : `${r.value}${r.unit ? ` ${r.unit}` : ''}`}${r.amended ? ` AMENDED(${r.amended})` : ''}`,
    `${r.conclusion}${r.isOos ? ' (OOS)' : ''}${r.reported ? '' : ', not reported'}`,
  ]);
  autoTable(doc, {
    startY: y + 3,
    head: [['Test', 'Method', 'Specification', 'Result', 'Conclusion']],
    body,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [44, 62, 80] },
  });
  y = (doc as any).lastAutoTable.finalY + 5;

  const notes: string[] = [];
  for (const r of s.results) {
    for (const a of r.amendments) notes.push(`AMENDED(${r.amended}) ${r.parameter}, version ${a.version}: ${a.label} - ${a.reason} (${dash(a.previousValue)} -> ${dash(a.value)}, ${utc(a.at)})`);
    if (r.kind === 'Original' && r.oos) notes.push(`${r.parameter}: the original result ${dash(r.value)} was investigated in ${r.oos.id} (${r.oos.decision ?? r.oos.status}); the retest is reported.`);
  }
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  for (const n of notes) {
    for (const line of doc.splitTextToSize(n, width - 2 * left) as string[]) { y = room(doc, y, 5); doc.text(line, left, y); y += 4; }
  }

  y = room(doc, y + 3, 12);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Conclusion', left, y);
  y += 5;
  doc.setFontSize(10);
  if (!s.conclusion.complies) doc.setTextColor(185, 28, 28);
  for (const line of doc.splitTextToSize(s.conclusion.text, width - 2 * left) as string[]) { doc.text(line, left, y); y += 5; }
  doc.setTextColor(0, 0, 0);

  if (s.approvals.length) {
    y = room(doc, y + 3, 20);
    doc.setFontSize(11);
    doc.text('Review of results', left, y);
    autoTable(doc, {
      startY: y + 3,
      head: [['Meaning', 'Name', 'Role', 'Signed']],
      body: s.approvals.map(a => [a.meaning, a.signerName, a.signerRole, utc(a.timestamp)]),
      theme: 'grid', styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [100, 116, 139] },
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  }

  y = room(doc, y + 3, 30);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(preview ? 'Authorisation: none (preview)' : 'Authorisation (electronic signature, 21 CFR Part 11)', left, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  if (!preview && input.signatures.length === 0) { doc.text('No authorisation signature is recorded for this certificate.', left, y); y += 5; }
  for (const sig of input.signatures) {
    y = room(doc, y, 24);
    doc.text(`Name: ${sig.signerName}    Role: ${sig.signerRole}`, left, y); y += 5;
    for (const line of doc.splitTextToSize(`Meaning: ${sig.meaning}`, width - 2 * left) as string[]) { doc.text(line, left, y); y += 4.5; }
    doc.text(`Signed: ${utc(sig.timestamp)}`, left, y); y += 5;
    if (sig.reason && sig.reason.trim()) { for (const line of doc.splitTextToSize(`Reason: ${sig.reason}`, width - 2 * left) as string[]) { doc.text(line, left, y); y += 4.5; } }
    y += 2;
  }
  if (preview) {
    y = room(doc, y + 2, 10);
    doc.setFont('helvetica', 'bold');
    doc.text('This preview is not a Certificate of Analysis. An issued certificate carries a COA number and an authorisation signature.', left, y, { maxWidth: width - 2 * left });
  }

  const pages = doc.getNumberOfPages();
  const footer = preview ? 'Preview - not issued' : `${s.certificate!.label} | Copy ${copy!.copyNo} | generated ${utc(copy!.generatedAt)} for ${copy!.generatedByName}`;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    if (mark) {
      doc.saveGraphicsState();
      doc.setGState(new (doc as any).GState({ opacity: 0.12 }));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(mark.length > 12 ? 44 : 72);
      doc.setTextColor(185, 28, 28);
      doc.text(mark, width / 2, doc.internal.pageSize.getHeight() / 2, { align: 'center', baseline: 'middle', angle: 45 });
      doc.restoreGraphicsState();
      doc.setTextColor(0, 0, 0);
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(`${footer} | Page ${i} of ${pages}`, width / 2, doc.internal.pageSize.getHeight() - 8, { align: 'center' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

/** A new page when fewer than `need` mm are left above the footer. Returns the y to write at. */
function room(doc: jsPDF, y: number, need: number): number {
  if (y + need <= doc.internal.pageSize.getHeight() - 16) return y;
  doc.addPage();
  return 18;
}
