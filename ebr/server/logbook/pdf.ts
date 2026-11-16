/**
 * The PDF of logbook exports and certified copies. Since R4 it is written by server/pdf/writer.ts (embedded Unicode font,
 * Arabic shaping, bidirectional order): the R3 writer printed '?' for every character outside ASCII (E22).
 */
export { renderPdf as textPdf } from '../pdf/writer.js';
