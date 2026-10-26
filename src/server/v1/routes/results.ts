// /api/v1: result entry in bulk (roadmap M22). Every item goes through saveResult, the one way a result is written
// (src/server/services/saveResult.ts): the sample is locked and must be in Testing, the version must match, the value is evaluated against
// the limit registered with the sample, the result guards run (instrument Active and within calibration, method, calculated inputs,
// system suitability), the result is audited, and an OOS value opens its investigation. All items run in ONE transaction: the first
// refused item rolls back the whole call and the problem names it.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { results } from '../../../db/schema';
import { AppError } from '../../http/errors';
import { saveResult } from '../../services/saveResult';
import { withIdempotency } from '../idempotency';
import { ProblemError } from '../problem';
import { defineRoute } from '../registry';
import { MAX_V1_BATCH } from './samples';

const id = (label: string) => z.string(`${label} is required.`).min(1, `${label} is required.`).max(64);

export const resultItemSchema = z.object({
  sampleId: id('sampleId'),
  resultId: id('resultId'),
  value: z.string('value must be a string (send the number as text, as the instrument reported it: "98.10").').trim().min(1, 'value is required.').max(100),
  expectedVersion: z.number().int().min(1).meta({ description: 'The result version read from GET /samples/{sampleId}' }),
  instrumentId: id('instrumentId').optional().meta({ description: 'The instrument the value was measured on; defaults to the instrument the client is bound to' }),
  reason: z.string().trim().min(1).max(500).optional().meta({ description: 'Recorded in the audit entry, followed by the client name and the Idempotency-Key' }),
}).strict();

export const resultsBatchSchema = z.object({
  items: z.array(resultItemSchema).min(1, 'items must hold at least one result.').max(MAX_V1_BATCH, `At most ${MAX_V1_BATCH} results in one call.`)
    .superRefine((items, ctx) => {
      const seen = new Map<string, number>();
      items.forEach((item, i) => {
        const first = seen.get(item.resultId);
        if (first !== undefined) ctx.addIssue({ code: 'custom', path: [i, 'resultId'], message: `result ${item.resultId} is already item ${first}; a result is entered once per call.` });
        else seen.set(item.resultId, i);
      });
    }),
}).strict();

const savedDto = z.object({
  sampleId: z.string(),
  resultId: z.string(),
  value: z.string(),
  isOos: z.boolean(),
  version: z.number().int(),
  oosInvestigationId: z.string().nullable().meta({ description: 'The investigation an OOS value opened (or the open one it belongs to)' }),
}).strict();

defineRoute({
  method: 'POST', path: '/results:batch', operationId: 'enterResults', scope: 'results:write', idempotent: true,
  summary: 'Enter up to 500 result values in one call, all or nothing',
  description: 'The same rules as entry at the bench apply to every item. A result that already has a value is not changed by a machine ' +
    '(409 RESULT_ALREADY_ENTERED): a correction is made by a person, with a reason. If any item is refused, nothing is written and the ' +
    'problem names the item (`errors[].index`). One audit entry per result, attributed to the client\'s service account.',
  body: resultsBatchSchema,
  responses: { 200: { description: 'The saved results, in the order of the items', schema: z.object({ count: z.number().int(), results: z.array(savedDto) }).strict() } },
  errors: [400, 404, 409, 422, 423],
  async handler({ db, io, client, user, body, idempotencyKey }) {
    const { items } = body as z.infer<typeof resultsBatchSchema>;
    return withIdempotency(db, { clientId: client.id, key: idempotencyKey, operation: 'enterResults', body }, async (tx, afterCommit) => {
      const saved: Array<z.infer<typeof savedDto>> = [];
      for (const [index, item] of items.entries()) {
        try {
          if (client.instrumentId && item.instrumentId && item.instrumentId !== client.instrumentId) {
            throw new AppError(400, 'BAD_REQUEST', `This client is bound to instrument ${client.instrumentId}; item names ${item.instrumentId}.`);
          }
          const [current] = await tx.select({ value: results.value, sampleId: results.sampleId }).from(results).where(eq(results.id, item.resultId)).limit(1);
          if (current && current.sampleId === item.sampleId && current.value !== null) {
            throw new AppError(409, 'RESULT_ALREADY_ENTERED', `Result ${item.resultId} already has a value (${current.value}). A correction is made by a person, with a reason.`);
          }
          const row = await saveResult({
            tx, afterCommit, io, user: { id: user.id, role: user.role }, sampleId: item.sampleId, resultId: item.resultId,
            input: {
              value: item.value, expectedVersion: item.expectedVersion, instrumentId: item.instrumentId ?? client.instrumentId ?? undefined,
              reason: `${item.reason ?? 'Instrument data capture'} (API client "${client.name}", results:batch, Idempotency-Key ${idempotencyKey})`,
            },
          });
          saved.push({ sampleId: item.sampleId, resultId: row.id, value: row.value ?? '', isOos: row.isOos, version: row.version, oosInvestigationId: row.oosInvestigationId });
        } catch (err) {
          if (!(err instanceof AppError) || err.status >= 500) throw err;
          throw new ProblemError(err.status, err.code, `Item ${index} was refused, so nothing was written: ${err.message}`,
            [{ index, pointer: `/items/${index}`, code: err.code, detail: err.message }]);
        }
      }
      return { status: 200, body: { count: saved.length, results: saved } };
    });
  },
});
