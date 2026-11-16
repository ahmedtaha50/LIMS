import { HttpError } from '../../core/errors.js';
import type { BatchHook, StepHandler } from '../../batch/steps.js';
import { assertReady, inUseBy, lockFor, writeUse } from '../../interlock/index.js';

/**
 * The equipment step (E13). The operator names (or scans) the equipment or room; the step is refused unless its logbook
 * status is clean and its calibration is current; once signed, the logbook gets a "start of use" entry with the batch.
 */
export const handlers: StepHandler[] = [{
  type: 'equipment',
  record: async (input, def, ctx) => {
    if (def.type !== 'equipment') throw new Error('wrong handler');
    const keys = Object.keys(input);
    if (keys.some(k => k !== 'objectCode')) throw new HttpError(400, 'unexpected_input', 'Only "objectCode" is accepted.');
    const code = typeof input.objectCode === 'string' && input.objectCode.trim() ? input.objectCode.trim() : def.objectCode;
    if (!code) throw new HttpError(400, 'object_required', `${def.label}: scan or type the code of the ${def.objectKind}.`);
    if (def.objectCode && code.toLowerCase() !== def.objectCode.toLowerCase()) throw new HttpError(409, 'wrong_equipment', `${def.label}: the recipe requires ${def.objectCode}, not ${code}.`);
    const lb = await lockFor(ctx.c, def.objectKind, code);
    await assertReady(ctx.pool, lb);
    return {
      value: { objectKind: def.objectKind, objectCode: lb.object_code, name: lb.name },
      exceptions: [],
      effects: async (signatureId, signedAt) => {
        await writeUse(ctx.c, lb, 'use_start', { product: ctx.batch.productName, batch: ctx.batch.batchNumber }, ctx.actor, signatureId, signedAt, `automatic: batch ${ctx.batch.batchNumber}, step "${def.label}"`);
      },
    };
  },
}];

/** E13#2, E13#3: closing the batch writes "end of use" in every logbook it used, which makes the equipment dirty. */
export const onBatchComplete: BatchHook = async ({ c, actor, batch, signatureId, signedAt }) => {
  for (const lb of await inUseBy(c, batch.batchNumber)) {
    await writeUse(c, lb, 'use_end', { batch: batch.batchNumber }, actor, signatureId, signedAt, `automatic: batch ${batch.batchNumber} closed`);
  }
};
