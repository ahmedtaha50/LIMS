// Strict request schemas of the certificate routes (roadmap M25). The number, version, status, snapshot, signer and meaning are the
// server's: a body that names any of them is refused (unknown key, 400). The signer is req.user; the meaning is the route's.
import { z } from 'zod';
import { signatureFields } from '../../lib/validations/signatures';

const credentials = { password: signatureFields.password, totpCode: signatureFields.totpCode };
const reason = z.string('A reason is required.').trim().min(5, 'Give the reason (at least 5 characters).').max(1000);
const expectedVersion = z.number('expectedVersion is required.').int().min(1);

/** POST /coa/:sampleId */
export const coaIssueSchema = z.object({ ...credentials, reason: z.string().trim().min(1).max(1000).optional() }).strict();
/** POST /coa/documents/:id/reissue and /void: the reason is required, and the version of the document the user saw. */
export const coaReissueSchema = z.object({ ...credentials, reason, expectedVersion }).strict();
export const coaVoidSchema = coaReissueSchema;
/** POST /coa/documents/:id/copies */
export const coaCopySchema = z.object({}).strict();
/** GET /coa/documents */
export const coaListQuerySchema = z.object({
  batch: z.string().trim().min(1).max(200).optional(),
  sampleId: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['Issued', 'Superseded', 'Voided']).optional(),
}).strict();
