// The OOS investigation vocabulary (roadmap M10). Owned by r1-results-oos. Shared by the server and the screens.
//
//   status    Open while the investigation runs, Closed once QA has signed the closure. v0.1.0 wrote 'Approved' for a closed
//             investigation; those rows are not rewritten and read as Closed. Any other word an old database holds (the demo seed's
//             'Phase II QA Review') is NOT terminal: it blocks approval and release until the investigation is closed.
//   phase     where an open investigation stands: Phase I (laboratory investigation), Phase II (full-scale investigation),
//             Pending QA (the investigation is complete and waits for QA's closure). Moves forward only.
//   decision  the outcome QA signs on closure.

export const OOS_STATUS = { OPEN: 'Open', CLOSED: 'Closed' } as const;
/** The word v0.1.0 wrote for a closed investigation. */
export const LEGACY_CLOSED_STATUS = 'Approved';
export const OOS_TERMINAL_STATUSES: readonly string[] = [OOS_STATUS.CLOSED, LEGACY_CLOSED_STATUS];

export const OOS_PHASES = ['Phase I', 'Phase II', 'Pending QA'] as const;
export type OosPhase = (typeof OOS_PHASES)[number];
export const OOS_INITIAL_PHASE: OosPhase = 'Phase I';
/** Legal phase moves. A move back (QA sending an investigation back to Phase II) is not provided: it is a decision for QA. */
export const OOS_PHASE_TRANSITIONS: Readonly<Record<OosPhase, readonly OosPhase[]>> = {
  'Phase I': ['Phase II', 'Pending QA'],
  'Phase II': ['Pending QA'],
  'Pending QA': [],
};

export const OOS_DECISIONS = ['Confirmed OOS', 'Invalidated'] as const;
export type OosDecision = (typeof OOS_DECISIONS)[number];

/** Closed (or v0.1.0's Approved): the investigation is final. */
export const isTerminalOosStatus = (status: string | null | undefined): boolean => !!status && OOS_TERMINAL_STATUSES.includes(status);

/** What a screen shows as the investigation's stage: Closed when final, otherwise its phase (or the stored status of an old row). */
export function oosStage(o: { status: string; phase?: string | null }): string {
  if (isTerminalOosStatus(o.status)) return OOS_STATUS.CLOSED;
  return o.phase ?? o.status;
}
