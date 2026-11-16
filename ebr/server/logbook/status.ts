import type { Definition } from './definition.js';

export type DerivedStatus = { status: string; since: string | null; calibrationDue: string | null; reasons: string[] };
type E = { kind: string; values: Record<string, unknown>; recorded_at: Date | string; corrected: boolean };

/**
 * The status of an object is DERIVED from its logbook (E07#1), never typed in: the last entry that sets a status, then the
 * clock: a clean object whose clean-hold time has passed is dirty, an object past its calibration due date is out of
 * calibration (E07#2). Entries that were corrected count through their correction.
 */
export function deriveStatus(def: Definition, entries: readonly E[], settings: { cleanHoldHours?: number | undefined }, now = new Date()): DerivedStatus {
  if (!def.tracksStatus) return { status: 'not_tracked', since: null, calibrationDue: null, reasons: [] };
  let status = 'dirty', since: string | null = null, calibrationDue: string | null = null;
  const reasons: string[] = [];
  for (const e of entries) {
    if (e.corrected) continue;
    const kind = def.entryKinds.find(k => k.key === e.kind);
    if (!kind) continue;
    const at = new Date(e.recorded_at).toISOString();
    if (kind.setsStatus) { status = kind.setsStatus; since = at; }
    if (kind.setsCalibrationDue && typeof e.values[kind.setsCalibrationDue] === 'string') calibrationDue = String(e.values[kind.setsCalibrationDue]);
  }
  if (status === 'clean' && since && settings.cleanHoldHours !== undefined && now.getTime() - Date.parse(since) > settings.cleanHoldHours * 3_600_000) {
    reasons.push(`clean hold time of ${settings.cleanHoldHours} h has passed`); status = 'dirty';
  }
  if (calibrationDue && Date.parse(calibrationDue) < now.getTime()) { reasons.push(`calibration was due ${calibrationDue.slice(0, 10)}`); status = 'out_of_calibration'; }
  return { status, since, calibrationDue, reasons };
}
