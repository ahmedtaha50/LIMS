import { z } from 'zod';
import { RESULT_CHANGE_CODES } from '../../server/services/result-hooks/codes';

/** The most rows one save may carry. A sample's results are its specification's parameters: far fewer in practice. */
export const RESULTS_BATCH_MAX = 200;

/**
 * One row of PUT /samples/:id/results-batch (roadmap M19). The evaluation (is_oos), the person and the time are the server's, as for
 * PUT /samples/:id/results/:resultId. `reason` is the row's own reason: required (5 characters or more) when the result already has a
 * value, optional for a first entry. `reasonCode` and `oosId` follow saveResult's rules for a correction and an OOS replacement.
 */
export const resultsBatchItemSchema = z.object({
  resultId: z.string('resultId is required.').min(1, 'resultId is required.').max(100),
  value: z.string('Result value is required').trim().min(1, 'Result value is required').max(100, 'Result value is too long (at most 100 characters).'),
  expectedVersion: z.number('expectedVersion must be a number').int().positive('Record version mismatch. Refresh required.'),
  instrumentId: z.string().min(1).max(100).optional(),
  reason: z.string().trim().min(5, 'A clear reason is required for auditing (ALCOA+)').max(1000).optional(),
  oosId: z.string().min(1).max(100).optional(),
  reasonCode: z.enum(RESULT_CHANGE_CODES, { error: `reasonCode must be one of ${RESULT_CHANGE_CODES.join(', ')}.` }).optional(),
  // The reagent lots and prepared solutions the value was measured with (r2-reagents, roadmap M30).
  lotIds: z.array(z.string().min(1).max(100), 'lotIds must be a list of reagent lot or prepared solution ids.').max(20, 'At most 20 lots per result.').optional(),
}).strict();

export type ResultsBatchItem = z.infer<typeof resultsBatchItemSchema>;

/** PUT /samples/:id/results-batch: every changed row of one sample, saved all or nothing. A row appears once. */
export const resultsBatchSchema = z.object({
  items: z.array(resultsBatchItemSchema, 'items must be a list of rows.')
    .min(1, 'Nothing to save: items is empty.')
    .max(RESULTS_BATCH_MAX, `At most ${RESULTS_BATCH_MAX} rows per save.`)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, i) => {
        if (seen.has(item.resultId)) ctx.addIssue({ code: 'custom', path: [i, 'resultId'], message: `Result ${item.resultId} appears more than once in one save.` });
        seen.add(item.resultId);
      });
    }),
}).strict();
