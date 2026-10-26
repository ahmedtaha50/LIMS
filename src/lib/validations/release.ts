import { z } from 'zod';
import { signatureFields } from './signatures';

/** POST /traceability/batch/:batch/release: signed by QA (meaning BATCH_RELEASE, chosen by the server). */
export const batchReleaseSchema = z.object({
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: z.string().trim().max(1000).optional(),
  dispositionRecommendation: z.string().trim().max(4000).optional(),
}).strict();
