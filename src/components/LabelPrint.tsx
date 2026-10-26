/**
 * Label printing (roadmap M29): choose Code 128 or QR and the number of copies, log the print (POST /api/custody/labels), then
 * print. The print is logged before the browser's print dialog opens, so a cancelled dialog still shows in the label log as the
 * request it was. A label printed before is a reprint: the dialog says so and asks for the reason, which the server requires
 * (400 REPRINT_REASON_REQUIRED otherwise). The labels are printed with window.print on a sheet whose @page is the label size.
 */
import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch, errorMessage } from '../lib/api';
import type { Symbology } from '../lib/barcode';
import { LABEL_SIZE_MM, SampleLabel, type LabelData } from './SampleLabel';
import { Button } from './ui/Button';
import { Field, inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

export type LabelEntityType = 'Sample' | 'Container' | 'Location';

interface PrintRow { id: string; isReprint: boolean; reason: string | null; printedAt: string; printedBy: string; copies: number; symbology: string }

const PRINT_CSS = `
@media screen { .lims-label-sheet { position: fixed; left: -10000px; top: 0; } }
@media print {
  @page { size: ${LABEL_SIZE_MM.width}mm ${LABEL_SIZE_MM.height}mm; margin: 0; }
  body * { visibility: hidden !important; }
  .lims-label-sheet, .lims-label-sheet * { visibility: visible !important; }
  .lims-label-sheet { position: absolute; left: 0; top: 0; }
  .lims-label-sheet .lims-label { border: none !important; page-break-after: always; break-after: page; }
}`;

export function LabelPrint({ entityType, entityId, open, onClose, onPrinted }: {
  entityType: LabelEntityType; entityId: string; open: boolean; onClose: () => void; onPrinted?: () => void;
}) {
  const { toast } = useToast();
  const [symbology, setSymbology] = useState<Symbology>('code128');
  const [copies, setCopies] = useState(1);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<PrintRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ label: LabelData; symbology: Symbology; copies: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null); setReason(''); setHistory(null);
    apiFetch<PrintRow[]>(`/custody/labels?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`)
      .then(setHistory)
      .catch(e => { setHistory([]); toast.error(`The label log could not be read: ${errorMessage(e)}`); });
  }, [open, entityType, entityId, toast]);

  // Print once the sheet is in the page and its symbols are drawn, then take it away again.
  useEffect(() => {
    if (!sheet) return;
    const timer = window.setTimeout(() => {
      const done = () => { setSheet(null); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
      window.setTimeout(done, 1000);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [sheet]);

  const drawError = useCallback((m: string) => toast.error(`The barcode could not be drawn: ${m}`), [toast]);
  const reprint = (history?.length ?? 0) > 0;
  const reasonMissing = reprint && reason.trim().length < 5;

  const submit = async () => {
    if (reasonMissing) { setError('This label was printed before: give the reason for the reprint (at least 5 characters).'); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiFetch<{ print: PrintRow; label: LabelData & { symbology: Symbology; copies: number } }>('/custody/labels', {
        method: 'POST', body: { entityType, entityId, symbology, copies, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      toast.success(`${res.print.isReprint ? 'Reprint' : 'Print'} of ${res.label.code} logged (${res.print.id}); the print dialog opens.`);
      setSheet({ label: res.label, symbology: res.label.symbology, copies: res.label.copies });
      onPrinted?.();
      onClose();
    } catch (e) {
      const message = errorMessage(e, 'The label print was not logged.');
      setError(message);
      toast.error(message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Modal open={open} title={`Print label: ${entityId}`} onClose={onClose} dismissible={!busy}
        description={reprint ? `Printed ${history!.length} time(s) before: this is a reprint and needs a reason.` : 'First print of this label.'}
        footer={<>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={history === null}>Log and print</Button>
        </>}>
        <div className="grid gap-3">
          <Field label="Symbology">{p => (
            <select {...p} className={inputClass} value={symbology} onChange={e => setSymbology(e.target.value as Symbology)}>
              <option value="code128">Code 128 (linear)</option>
              <option value="qr">QR code</option>
            </select>)}</Field>
          <Field label="Copies" hint="1 to 50">{p => (
            <input {...p} type="number" min={1} max={50} className={inputClass} value={copies}
              onChange={e => setCopies(Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))))} />)}</Field>
          {reprint && (
            <Field label="Reason for the reprint" required error={error && reasonMissing ? error : null} hint="For example: label smudged during thawing">{p => (
              <input {...p} className={inputClass} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />)}</Field>
          )}
          {error && !reasonMissing && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {history && history.length > 0 && (
            <div className="text-xs text-slate-600">
              <p className="font-semibold">Label log</p>
              <ul>{history.map(h => <li key={h.id}>{h.id} · {formatDateTime(h.printedAt)} · {h.isReprint ? `reprint: ${h.reason}` : 'first print'} · {h.copies}×</li>)}</ul>
            </div>
          )}
        </div>
      </Modal>
      {sheet && typeof document !== 'undefined' && createPortal(
        <div className="lims-label-sheet" aria-hidden="true">
          <style>{PRINT_CSS}</style>
          {Array.from({ length: sheet.copies }, (_, i) => (
            <React.Fragment key={i}><SampleLabel label={sheet.label} symbology={sheet.symbology} onError={drawError} /></React.Fragment>
          ))}
        </div>, document.body)}
    </>
  );
}
