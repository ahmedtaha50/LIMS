/**
 * The camera scanner (roadmap M29): the fallback when there is no wedge scanner (src/lib/useScanSink.ts). The decoded text goes to
 * onScan, which resolves it like a wedge scan (GET /resolve), so a camera scan opens the record wherever it is.
 *
 * The camera is released when the dialog closes or after a scan: the cleanup belongs to the effect (an earlier version returned it
 * from inside the timer callback, where React never called it, so the camera stayed on).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Html5QrcodeScanner } from 'html5-qrcode';
import { XCircle } from 'lucide-react';

export function BarcodeScanner({ onScan, onClose }: { onScan: (text: string) => void, onClose: () => void }) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let scanner: Html5QrcodeScanner | null = null;
    let done = false;
    const release = () => {
      const s = scanner;
      scanner = null;
      if (s) s.clear().catch(() => { /* already stopped: nothing to release */ });
    };
    // Html5QrcodeScanner looks the element up by id, so it starts once React has put the element into the page.
    // The decoder (about 370 KB) is fetched here, on first use, not with the Samples page (r3-search-perf, M43).
    const timer = setTimeout(() => {
      import('html5-qrcode').then(({ Html5QrcodeScanner }) => {
        if (cancelled) return;
        scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: { width: 250, height: 250 } }, false);
        scanner.render(
          (decodedText) => {
            if (done) return;
            done = true;
            release();
            onScanRef.current(decodedText.trim());
          },
          () => { /* no code in this frame yet: the scanner keeps looking */ },
        );
      }, () => { if (!cancelled) setLoadError('The scanner could not be loaded. Check the connection, close this dialog and try again, or type the code.'); });
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); release(); };
  }, []);

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="barcode-scanner-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <h3 id="barcode-scanner-title" className="text-lg font-bold text-slate-800">Scan Barcode / QR</h3>
          <button type="button" onClick={onClose} aria-label="Close the scanner" className="text-slate-400 hover:text-slate-600">
            <XCircle className="w-6 h-6" />
          </button>
        </div>
        <div className="p-6 flex flex-col items-center justify-center">
          <div id="reader" className="w-full"></div>
          {loadError && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{loadError}</p>}
          <p className="mt-4 text-sm text-slate-500 text-center">
            Position the barcode or QR code (a sample, container, location, instrument or reagent lot) within the frame.
          </p>
        </div>
      </div>
    </div>
  );
}
