import { z } from 'zod';
import { RESULT_CHANGE_CODES } from '../../server/services/result-hooks/codes';

/**
 * PUT /samples/:id/results/:resultId. The evaluation (is_oos), the person and the time are the server's.
 * `reasonCode` is required to correct a result that has a value (roadmap M20: the coded reason of the new result version); replacing
 * a result that is OOS also needs `oosId`, the open investigation of that result, and one of the OOS codes.
 */
export const resultUpdateSchema = z.object({
  value: z.string('Result value is required').trim().min(1, 'Result value is required').max(100, 'Result value is too long (at most 100 characters).'),
  instrumentId: z.string().max(100).optional(),
  attachmentName: z.string().max(255).optional(),
  attachmentData: z.string().optional(),
  reason: z.string().trim().min(5, 'A clear reason is required for auditing (ALCOA+)').max(1000),
  expectedVersion: z.number().int().positive('Record version mismatch. Refresh required.'),
  oosId: z.string().min(1).max(100).optional(),
  reasonCode: z.enum(RESULT_CHANGE_CODES, { error: `reasonCode must be one of ${RESULT_CHANGE_CODES.join(', ')}.` }).optional(),
  // The reagent lots and prepared solutions the value was measured with (r2-reagents, roadmap M30).
  lotIds: z.array(z.string().min(1).max(100), 'lotIds must be a list of reagent lot or prepared solution ids.').max(20, 'At most 20 lots per result.').optional(),
}).strict();
