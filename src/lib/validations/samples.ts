import { z } from 'zod';
import { signatureFields } from './signatures';

export const SAMPLE_STATES = ['Logged', 'Testing', 'Pending Review', 'Approved', 'Rejected'] as const;

const text = (label: string, max = 200) => z.string(`${label} is required.`).trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);

/** POST /samples. The id, state, creator, specification binding and version are the server's. */
export const sampleRegistrationSchema = z.object({
  material: text('Material name'),
  batch: text('Batch number', 100),
}).strict();

export const MAX_BULK_IMPORT = 500;

/** POST /samples/bulk-import: every row is a registration; the import is accepted or refused as a whole. */
export const bulkImportSchema = z.object({
  items: z.array(sampleRegistrationSchema, 'items must be a list of { material, batch }.')
    .min(1, 'No items provided for import.')
    .max(MAX_BULK_IMPORT, `At most ${MAX_BULK_IMPORT} samples can be imported at once.`),
}).strict();

const { meaningCode: _meaningCode, ...credentialFields } = signatureFields;

/**
 * POST /samples/:id/transition. The meaning of the signature follows from the action (the server chooses it from the catalog); the
 * client never sends one. `password` (and `totpCode` for a user with an authenticator) are required for review, approve and reject.
 */
export const transitionSchema = z.object({
  action: z.enum(['submit', 'review', 'approve', 'reject']),
  expectedVersion: z.number().int().positive('Record version mismatch. Refresh required.'),
  reason: credentialFields.reason,
  password: credentialFields.password.optional(),
  totpCode: credentialFields.totpCode,
}).strict();

/** GET /samples query: newest first, `limit` rows after `cursor` (the X-Next-Cursor header of the previous page). */
export const sampleListQuerySchema = z.object({
  limit: z.coerce.number().int('limit must be a whole number.').min(1, 'limit must be between 1 and 1000.').max(1000, 'limit must be between 1 and 1000.').default(200),
  cursor: z.string().max(200).optional(),
  state: z.enum(SAMPLE_STATES, { error: `state must be one of ${SAMPLE_STATES.join(', ')}.` }).optional(),
  batch: z.string().max(100).optional(),
}).strict();
