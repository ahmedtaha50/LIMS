import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { Button, TextField } from '../ui/index.js';
import type { StepInput } from './types.js';

type Detector = { detect: (src: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorClass = new (o: { formats: string[] }) => Detector;

/**
 * Reads a lot label with the tablet camera where the browser offers barcode detection; typing the lot always works.
 * Nothing is decided here: the server checks the lot (material, released, not expired).
 */
function Scanner({ onRead, onClose }: { onRead: (v: string) => void; onClose: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null, timer = 0, stopped = false;
    const BD = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current || !BD) return;
        video.current.srcObject = stream; await video.current.play();
        const det = new BD({ formats: ['code_128', 'qr_code', 'data_matrix', 'ean_13', 'code_39'] });
        const tick = async () => {
          if (stopped || !video.current) return;
          const found = await det.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { onRead(found[0].rawValue.trim()); return; }
          timer = window.setTimeout(() => void tick(), 300);
        };
        void tick();
      } catch { setError(t('The camera is not available: type the lot number.')); }
    })();
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach(tr => tr.stop()); };
  }, [onRead]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-2">
      {error ? <p role="alert" className="text-base text-red-800">{error}</p> : <video ref={video} className="max-h-64 w-full rounded bg-black" muted playsInline aria-label={t('Camera for the lot label')} />}
      <Button variant="secondary" onClick={onClose}>{t('Close the camera')}</Button>
    </div>
  );
}

function Fields({ def }: { def: Record<string, unknown> }) {
  const t = useT();
  const [lot, setLot] = useState('');
  const [scanning, setScanning] = useState(false);
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base">{t('Dispense {quantity} {unit} of {material} (± {tolerance}%).', { quantity: String(def.quantity), unit: String(def.unit), material: String(def.material), tolerance: String(def.tolerancePct) })}</p>
      <TextField label={t('Lot number *')} name="lot" required value={lot} onChange={e => setLot(e.target.value)} autoCapitalize="characters" dir="ltr" />
      {canScan ? (scanning ? <Scanner onRead={v => { setLot(v); setScanning(false); }} onClose={() => setScanning(false)} /> : <div><Button variant="secondary" onClick={() => setScanning(true)}>{t('Scan the lot label')}</Button></div>) : null}
      <TextField label={t('Weight ({unit}) *', { unit: String(def.unit) })} name="weight" type="number" step="any" inputMode="decimal" required />
    </div>
  );
}

export const stepInput: StepInput = {
  type: 'material',
  Fields,
  read: (f) => ({ lot: String(f.get('lot') ?? '').trim(), ...(f.get('weight') ? { weight: Number(f.get('weight')) } : {}) }),
};
