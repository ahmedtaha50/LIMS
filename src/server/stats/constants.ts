// The vocabulary and the conservative defaults of trending (roadmap M39, r3-spc). Imports nothing. Every number here is a default QA
// confirms (docs/changes/r3-spc.md, decisionsForUser); none is a regulatory requirement.

/** The meaning of the approval of a control-limit baseline (signature_meanings, migration 0320). */
export const SPC_BASELINE_APPROVAL = 'SPC_BASELINE_APPROVAL';

/** Fewest approved results a baseline may be computed from. */
export const MIN_BASELINE_POINTS = 20;

/** Most points one series request returns (the most recent are kept) and the default. */
export const SERIES_LIMIT_DEFAULT = 1000;
export const SERIES_LIMIT_MAX = 5000;

/** Sample states shown when a viewer opts in to unapproved data (never used for limits, rules, capability or alerts). Rejected is never shown. */
export const UNAPPROVED_STATES = ['Testing', 'Pending Review'] as const;
