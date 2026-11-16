import { HttpError } from '../../core/errors.js';
import type { StepHandler } from '../../batch/steps.js';
import { limsConfig, requestSample } from '../../lims/client.js';

/**
 * The sample step (E18#1): the in-process control sample is requested in the LIMS when the operator signs the step. The
 * reference EBR:<batch>:<phase>.<step> is the same at every attempt, so a retry after a failure never duplicates it.
 */
export const handlers: StepHandler[] = [{
  type: 'sample',
  record: async (input, def, ctx) => {
    if (def.type !== 'sample') throw new Error('wrong handler');
    if (Object.keys(input).length) throw new HttpError(400, 'unexpected_input', 'A sample step takes no value: the request goes to the LIMS.');
    const cfg = limsConfig();
    if (!cfg) throw new HttpError(409, 'lims_not_configured', 'The LIMS link is not configured (EBR_LIMS_URL): this sample step cannot be recorded.');
    const ref = `EBR:${ctx.batch.batchNumber}:${ctx.phaseKey}.${def.key}`;
    const s = await requestSample(cfg, ref, { product: ctx.batch.productName, batch: ctx.batch.batchNumber, test: def.test, quantity: def.quantity, unit: def.unit });
    return {
      value: { externalRef: ref, limsSampleId: s.id, test: def.test, quantity: def.quantity, unit: def.unit, reusedExisting: !s.created },
      exceptions: [],
      effects: async () => {
        await ctx.c.query('INSERT INTO lims_requests (external_ref, batch_id, step_key, lims_sample_id, test, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (external_ref) DO NOTHING',
          [ref, ctx.batch.id, `${ctx.phaseKey}.${def.key}`, s.id, def.test, s.status]);
      },
    };
  },
}];
