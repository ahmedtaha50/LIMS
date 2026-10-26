import { printDateTime } from './format';
import { jsPDF } from 'jspdf';

/**
 * Header, watermark and footer for every page. `status` is the state of the record the document is made from: a caller that
 * does not know it gets a DRAFT watermark, never "Approved" (a document must not claim an approval nobody gave). Only a status
 * that starts with "Approved" is drawn in green; Draft, Pending, Rejected, OOS and anything else are red.
 */
export function applyGxPTheme(doc: jsPDF, title: string, status: string = 'Draft') {
  const pageCount = (doc as any).internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    
    // Header Background
    doc.setFillColor(245, 248, 250);
    doc.rect(14, 10, pageWidth - 28, 32, 'F');
    doc.setDrawColor(200, 210, 220);
    doc.setLineWidth(0.5);
    doc.rect(14, 10, pageWidth - 28, 32, 'S');
    
    // Header Titles
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(31, 41, 55);
    doc.text('CORPORATE QUALITY ASSURANCE', 20, 22);
    
    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.text(`System: Enterprise LIMS (GxP Compliant)`, 20, 29);
    doc.text(`Document: ${title}`, 20, 36);
    
    // Header Right
    doc.text(`Generated: ${printDateTime(new Date())}`, pageWidth - 20, 22, { align: 'right' });
    doc.text(`Status: ${status.toUpperCase()}`, pageWidth - 20, 29, { align: 'right' });
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 20, 36, { align: 'right' });
    
    // Watermark
    doc.saveGraphicsState();
    doc.setGState(new (doc as any).GState({opacity: 0.08}));
    doc.setFontSize(75);
    doc.setFont('helvetica', 'bold');
    if (/^approved\b/i.test(status)) {
      doc.setTextColor(22, 163, 74);
    } else {
      doc.setTextColor(220, 38, 38);
    }
    doc.text(status.toUpperCase(), pageWidth / 2, pageHeight / 2, {
      align: 'center',
      baseline: 'middle',
      angle: 45
    });
    doc.restoreGraphicsState();
    
    // Footer
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.setFont('helvetica', 'italic');
    doc.text('This document is electronically generated. The electronic signature is the legally binding equivalent of a handwritten signature.', pageWidth / 2, pageHeight - 12, { align: 'center' });
    doc.text('21 CFR Part 11 Compliant Audit Trail Enabled.', pageWidth / 2, pageHeight - 8, { align: 'center' });
  }
}
