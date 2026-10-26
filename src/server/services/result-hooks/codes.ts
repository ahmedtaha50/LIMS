// The coded reasons of a result version (roadmap M20, r2-raw-data). Pure constants: imported by the server, the request schema and
// the sample screen, so this file imports nothing but other constants. drizzle/0120_raw_data.sql checks the same list.
import { OOS_RESULT_CHANGE_CODES } from '../../../lib/constants/results';

/**
 * The reasons a person gives for correcting a result that already has a value (`reasonCode` on PUT /samples/:id/results/:resultId).
 * The free-text reason is still required beside the code. A value that is OOS is replaced only with one of the OOS codes
 * (OOS_RESULT_CHANGE_CODES, under its open investigation); REINTEGRATION is never accepted for an OOS value.
 * A REINTEGRATION (the chromatogram re-processed) needs a QA signature (REINTEGRATION_APPROVAL) before the sample can be approved.
 */
export const RESULT_CHANGE_CODES = [...OOS_RESULT_CHANGE_CODES, 'REINTEGRATION'] as const;
export type ResultChangeCode = (typeof RESULT_CHANGE_CODES)[number];

/** Codes the server writes itself: the first value of a result, and the value a result held when versions were introduced (0120). */
export const SERVER_VERSION_CODES = ['INITIAL_ENTRY', 'MIGRATED'] as const;
export type VersionCode = ResultChangeCode | (typeof SERVER_VERSION_CODES)[number];
export const VERSION_CODES: readonly VersionCode[] = [...SERVER_VERSION_CODES, ...RESULT_CHANGE_CODES];

export const REINTEGRATION: ResultChangeCode = 'REINTEGRATION';

export const VERSION_CODE_LABELS: Record<VersionCode, string> = {
  INITIAL_ENTRY: 'First entry',
  MIGRATED: 'Value at upgrade (history starts here)',
  TRANSCRIPTION_ERROR: 'Transcription error',
  CALCULATION_ERROR: 'Calculation error',
  INSTRUMENT_MALFUNCTION: 'Instrument malfunction',
  SAMPLE_PREPARATION_ERROR: 'Sample preparation error',
  METHOD_DEVIATION: 'Method deviation',
  REINTEGRATION: 'Reintegration',
};

export const isResultChangeCode = (v: unknown): v is ResultChangeCode => (RESULT_CHANGE_CODES as readonly unknown[]).includes(v);
export const isOosChangeCode = (v: unknown): boolean => (OOS_RESULT_CHANGE_CODES as readonly unknown[]).includes(v);
