/**
 * One printed label (roadmap M29): the barcode (Code 128 or QR, src/lib/barcode.ts) of the record's code, the code in plain text
 * under it, and the lines the server chose (material, batch, expiry, storage). The size is the label stock's, in millimetres; the
 * print sheet (./LabelPrint.tsx) sets @page to the same size, so one label is one page.
 *
 * The symbol is shown as an image of the SVG (a data: URL), so no markup is injected into the page.
 */
import React, { useEffect, useState } from 'react';
import { barcodeSvg, type Symbology } from '../lib/barcode';

export interface LabelData { code: string; title: string; lines: string[] }

export const LABEL_SIZE_MM = { width: 50, height: 25 } as const;

export function SampleLabel({ label, symbology, onError }: { label: LabelData; symbology: Symbology; onError?: (message: string) => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    barcodeSvg(symbology, label.code)
      .then(s => { if (live) setSvg(s); })
      .catch((e: unknown) => { if (live) { setSvg(null); onError?.(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [symbology, label.code, onError]);

  const qr = symbology === 'qr';
  return (
    <div className="lims-label" style={{
      width: `${LABEL_SIZE_MM.width}mm`, height: `${LABEL_SIZE_MM.height}mm`, boxSizing: 'border-box', padding: '1.5mm',
      display: 'flex', flexDirection: qr ? 'row' : 'column', gap: '1.5mm', background: '#fff', color: '#000', overflow: 'hidden',
      fontFamily: 'Arial, Helvetica, sans-serif', border: '0.2mm solid #94a3b8',
    }}>
      <div style={qr ? { width: '21mm', height: '21mm', flex: 'none' } : { width: '100%', height: '9mm' }}>
        {svg && <img alt={`${qr ? 'QR code' : 'Code 128 barcode'} of ${label.code}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }} />}
      </div>
      <div style={{ minWidth: 0, lineHeight: 1.15 }}>
        <div style={{ fontSize: '2.8mm', fontWeight: 700, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{label.code}</div>
        {label.title !== label.code && <div style={{ fontSize: '2.4mm', fontWeight: 700 }}>{label.title}</div>}
        {label.lines.slice(0, qr ? 5 : 3).map((l, i) => (
          <div key={i} style={{ fontSize: '2.2mm', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>
        ))}
      </div>
    </div>
  );
}
