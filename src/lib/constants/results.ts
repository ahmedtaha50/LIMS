// Result entry vocabulary (roadmap M10). Owned by r1-results-oos. Shared by the server and the screens.

/**
 * Who enters results. A Reviewer or QA officer reviews them and must not author them (403). 'Instrument' is the service account of an API
 * client (r2-api-v1): it reaches only /api/v1 (POST /v1/results:batch), never the interactive API.
 */
export const RESULT_ENTRY_ROLES: readonly string[] = ['Analyst', 'Admin', 'Instrument'];

/** The only sample state in which results are entered or corrected. */
export const RESULT_ENTRY_STATE = 'Testing';

/**
 * Declared tokens for a result below what the method can report. Accepted only where the limit is an upper limit (NMT, or a RANGE
 * whose lower limit is 0 or less), because "less than" cannot show that a lower limit is met. "<x" is also accepted, with x a number.
 * ND, <LOQ and <LOD are judged within an upper limit: the method's LOQ is taken to be below the specification limit (method validation).
 */
export const CENSORED_TOKENS = ['ND', '<LOQ', '<LOD'] as const;

/** The verdicts a TEXT limit (an acceptance text) and a PRESENCE limit are recorded with; the second of each pair is OOS. */
export const TEXT_VERDICTS = { pass: 'Complies', fail: 'Does not comply' } as const;
export const PRESENCE_VERDICTS = { pass: 'Absent', fail: 'Present' } as const;

/**
 * The coded reasons for replacing a result that was OOS while its investigation is open (Phase I laboratory investigation finding).
 * The free-text reason is still required beside the code.
 */
export const OOS_RESULT_CHANGE_CODES = [
  'TRANSCRIPTION_ERROR',
  'CALCULATION_ERROR',
  'INSTRUMENT_MALFUNCTION',
  'SAMPLE_PREPARATION_ERROR',
  'METHOD_DEVIATION',
] as const;
export type OosResultChangeCode = (typeof OOS_RESULT_CHANGE_CODES)[number];
