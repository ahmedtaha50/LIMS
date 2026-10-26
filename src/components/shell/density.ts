/**
 * Bench mode (roadmap M24): a denser-to-touch layout for tablets and gloved hands at the bench. Every control, option and list row
 * is at least 44 px high (WCAG 2.5.5 target size) and the text is larger; see src/index.css, [data-density="bench"].
 *
 * The choice is a per-computer convenience, kept in this browser's localStorage. Every access is guarded: a private window or
 * blocked site data simply starts in the normal density.
 */
import { useEffect, useState } from 'react';

export type Density = 'normal' | 'bench';
const KEY = 'lims.density';

export function readDensity(): Density {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'bench' ? 'bench' : 'normal'; } catch { return 'normal'; }
}

export function applyDensity(d: Density): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.density = d;
}

export function useDensity(): [Density, (d: Density) => void] {
  const [density, setState] = useState<Density>(() => readDensity());
  useEffect(() => { applyDensity(density); }, [density]);
  const set = (d: Density) => {
    setState(d);
    try { localStorage.setItem(KEY, d); } catch { /* not remembered; the page still switches */ }
  };
  return [density, set];
}
