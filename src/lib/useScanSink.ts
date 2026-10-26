/**
 * The global wedge-scanner hook (roadmap M29, UX-08). A USB or Bluetooth barcode scanner in keyboard ("wedge") mode types the code
 * very fast and ends it with Enter. A burst of printable keys, each under 35 ms after the one before, ending in Enter, is a scan;
 * a person typing is far slower and is never taken for one. Keys typed into an input, a text area, a select or an editable element
 * are left alone (that field receives the scan, as before).
 *
 *   useScanSink(onScan)    calls onScan(code) for every scan anywhere on the page
 *   useScanToOpen()        the application's handler: GET /resolve?code= and open the record's page, wherever it is, even when no
 *                          list on the screen has loaded it; an unknown code is a toast.error, blockers are shown as a warning
 *   openScannedCode(...)   the same for the camera scanner (src/components/BarcodeScanner.tsx), the fallback
 */
import { useCallback, useEffect, useRef } from 'react';
import { apiFetch, ApiError } from './api';
import { navigate } from './router';

export const SCAN_MAX_GAP_MS = 35;
export const SCAN_MIN_LENGTH = 4;

export interface ScanKey {
  key: string;
  /** Milliseconds, from the event (KeyboardEvent.timeStamp) or a clock. */
  time: number;
  /** The key went to an input, a text area, a select or an editable element. */
  editable: boolean;
  /** Ctrl, Alt or Meta held: a shortcut, not a scanner. */
  modified?: boolean;
}

/**
 * The burst detector, free of the DOM so it can be tested. `push` returns the scanned code when this key completes a scan (the caller
 * then stops the Enter from reaching the page), or null.
 */
export function createScanDetector(maxGapMs = SCAN_MAX_GAP_MS, minLength = SCAN_MIN_LENGTH) {
  let buffer = '';
  let last = -Infinity;
  return {
    push(k: ScanKey): string | null {
      if (k.editable || k.modified) { buffer = ''; last = -Infinity; return null; }
      const gap = k.time - last;
      if (k.key === 'Enter') {
        const code = buffer;
        buffer = '';
        last = -Infinity;
        return code.length >= minLength && gap < maxGapMs ? code : null;
      }
      if (k.key.length !== 1) return null; // Shift and other keys without a character: the scanner presses Shift for capitals
      buffer = gap < maxGapMs ? buffer + k.key : k.key;
      last = k.time;
      return null;
    },
    reset() { buffer = ''; last = -Infinity; },
  };
}

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
};

export function useScanSink(onScan: (code: string) => void): void {
  const handler = useRef(onScan);
  handler.current = onScan;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const detector = createScanDetector();
    const onKey = (e: KeyboardEvent) => {
      const code = detector.push({ key: e.key, time: e.timeStamp, editable: isEditable(e.target), modified: e.ctrlKey || e.altKey || e.metaKey });
      if (code) { e.preventDefault(); e.stopPropagation(); handler.current(code); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export interface Resolved { kind: string; id: string; label: string; href: string; sampleId?: string; blockers: string[] }

type Toast = { error(message: string): void; info(message: string): void; success?(message: string): void };

/** Resolves a scanned code and opens its page; every outcome is shown (no silent failure). */
export async function openScannedCode(code: string, toast: Toast): Promise<Resolved | null> {
  try {
    const found = await apiFetch<Resolved>(`/resolve?code=${encodeURIComponent(code)}`);
    navigate(found.href);
    if (found.blockers.length) toast.error(`${found.label}. ${found.blockers.join(' ')}`);
    else toast.info(`Scanned: ${found.label}`);
    return found;
  } catch (e) {
    toast.error(e instanceof ApiError && e.status === 404 ? `Unknown code "${code}": ${e.message}` : `The scanned code "${code}" could not be looked up: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Mount once in the shell: every scan anywhere opens the record it names. */
export function useScanToOpen(toast: Toast): void {
  const open = useCallback((code: string) => { void openScannedCode(code, toast); }, [toast]);
  useScanSink(open);
}
