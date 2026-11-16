import { useT } from '../../i18n/index.js';

/** Status is shown with words and an icon-like mark, never by colour alone (colour-blind operators, glare on the floor). */
const LOOK: Record<string, [string, string]> = {
  clean: ['Clean', 'bg-emerald-100 text-emerald-900 border-emerald-700'],
  dirty: ['Dirty', 'bg-amber-100 text-amber-900 border-amber-700'],
  in_use: ['In use', 'bg-sky-100 text-sky-900 border-sky-700'],
  on_hold: ['On hold', 'bg-red-100 text-red-900 border-red-700'],
  out_of_service: ['Out of service', 'bg-red-100 text-red-900 border-red-700'],
  out_of_calibration: ['Calibration expired', 'bg-red-100 text-red-900 border-red-700'],
  not_tracked: ['No status', 'bg-slate-100 text-slate-800 border-slate-500'],
};
export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const [label, look] = LOOK[status] ?? [status, 'bg-slate-100 text-slate-800 border-slate-500'];
  const ok = status === 'clean' || status === 'not_tracked';
  return <span className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-3 text-sm font-bold ${look}`}><span aria-hidden="true">{ok ? "✓" : status === "in_use" ? "●" : "!"}</span><span>{t(label)}</span></span>;
}
