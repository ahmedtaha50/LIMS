// The vocabulary of the environmental monitoring programme (roadmap M32, r2-em). Imports nothing, so the screen
// (src/components/Environmental.tsx) and the server share one list.

/** Viable methods count colonies (CFU); particle methods count total particles per m3 at one particle size. */
export const VIABLE_METHODS = ['Air', 'Settle plate', 'Contact plate', 'Glove print'] as const;
export const PARTICLE_METHODS = ['Particles 0.5 um', 'Particles 5.0 um'] as const;
export const EM_METHODS = [...VIABLE_METHODS, ...PARTICLE_METHODS] as const;
export type EmMethod = (typeof EM_METHODS)[number];

export const isViable = (method: string): boolean => (VIABLE_METHODS as readonly string[]).includes(method);

/** The unit of a count is fixed by its method (the same units as env_limits, 0070). */
export const METHOD_UNITS: Record<EmMethod, string> = {
  Air: 'CFU/m3',
  'Settle plate': 'CFU/4 hours',
  'Contact plate': 'CFU/plate',
  'Glove print': 'CFU/glove',
  'Particles 0.5 um': 'particles/m3',
  'Particles 5.0 um': 'particles/m3',
};

export const OCCUPANCY_STATES = ['In operation', 'At rest'] as const;
export type Occupancy = (typeof OCCUPANCY_STATES)[number];

export const ISO_CLASSES = ['ISO 5', 'ISO 6', 'ISO 7', 'ISO 8'] as const;

export const EM_STATUSES = ['Pass', 'Alert', 'Action'] as const;
export type EmStatus = (typeof EM_STATUSES)[number];

export const PROFILE_STATUSES = ['Draft', 'Approved', 'Retired'] as const;
export const POINT_STATUSES = ['Active', 'Retired'] as const;

/** The meaning of the approval of a limit profile (signature_meanings, migration 0250). */
export const EM_LIMIT_APPROVAL = 'EM_LIMIT_APPROVAL';

/**
 * Adverse-trend rules (src/server/em/trends.ts). Conservative defaults, listed for QA's confirmation in docs/changes/r2-em.md:
 *   CONSECUTIVE_ALERTS   3 results in a row at one point and method at Alert or above (an Action counts as above Alert);
 *   REPEATED_ACTIONS     2 action-level results at one point within 30 days;
 *   RECURRING_ORGANISM   the same organism identified twice in one room within 90 days.
 */
export const TREND_RULES = {
  CONSECUTIVE_ALERTS: { label: 'Consecutive alert-level results', run: 3 },
  REPEATED_ACTIONS: { label: 'Repeated action-level results', count: 2, days: 30 },
  RECURRING_ORGANISM: { label: 'Recurring organism', count: 2, days: 90 },
} as const;
export type TrendRule = keyof typeof TREND_RULES;

/** How far back the scheduled trend evaluation reads results. */
export const TREND_LOOKBACK_DAYS = 365;
