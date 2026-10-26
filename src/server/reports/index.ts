// The controlled-document engine (roadmap M25, r2-coa-reports). What other modules import (src/server/reports.ts re-exports it).
export { buildCoaSnapshot, conclusionOf, specText, type CoaAmendment, type CoaResultRow, type CoaSnapshot, type LimitForText } from './snapshot';
export { renderCoaPdf, utc, watermarkFor, type CopyInfo, type SignatureBlock } from './pdf';
export {
  COA_ENTITY, COA_RENDER_JOB, coaProblems, documentDetail, documentSignatures, issueCoa, listDocuments, presentDocument, reissueCoa, requestCopy,
  sampleCoa, sha256Hex, snapshotHash, voidCoa, type Problem,
} from './coa';
export { coaRenderHandler, downloadRun, REPORT_HANDLERS, runDetail, verifyRun } from './runs';
