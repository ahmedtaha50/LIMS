// /api/v1: samples (roadmap M22). Registration goes through insertSamples, the write the session API uses (src/server/routes/samples.ts):
// the per-year counter, the specification revision in force, one result per parameter with its limit, one audit entry per sample.
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { results, samples } from '../../../db/schema';
import { SAMPLE_STATES, sampleRegistrationSchema } from '../../../lib/validations/samples';
import { resolveActiveSpec, type ResolvedSpec } from '../../lib/specs';
import { insertSamples } from '../../routes/samples';
import { resultDto, sampleDto, toResult, toSample } from '../dto';
import { withIdempotency } from '../idempotency';
import { ProblemError } from '../problem';
import { defineRoute } from '../registry';

export const MAX_V1_BATCH = 500;

// ---- GET /samples: newest first, keyset cursor -----------------------------------------------------------------------------------

/** The cursor carries created_at at microsecond precision (as text): rows registered in one transaction share created_at to the microsecond. */
const cursorTs = sql<string>`to_char(${samples.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(cursor: string): { ts: string; id: string } {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(ts) && typeof id === 'string' && id) return { ts, id };
  } catch { /* fall through */ }
  throw new ProblemError(400, 'VALIDATION_FAILED', 'cursor is not valid: send the nextCursor of the previous page unchanged.', [{ pointer: '/cursor', detail: 'not a cursor of this API' }]);
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100).meta({ description: 'Page size, 1 to 500' }),
  cursor: z.string().max(300).optional().meta({ description: 'nextCursor of the previous page' }),
  state: z.enum(SAMPLE_STATES).optional(),
  batch: z.string().min(1).max(100).optional(),
}).strict();

defineRoute({
  method: 'GET', path: '/samples', operationId: 'listSamples', scope: 'samples:read',
  summary: 'List samples, newest first, one page at a time',
  description: 'Keyset paging: pass `nextCursor` back as `cursor` until it is null. Filters: `state`, `batch`.',
  query: listQuery,
  responses: { 200: { description: 'One page of samples', schema: z.object({ data: z.array(sampleDto), nextCursor: z.string().nullable() }).strict() } },
  errors: [400],
  async handler({ db, query }) {
    const { limit, cursor, state, batch } = query as z.infer<typeof listQuery>;
    const where: SQL[] = [];
    if (state) where.push(eq(samples.state, state));
    if (batch) where.push(eq(samples.batch, batch));
    if (cursor) {
      const c = decodeCursor(cursor);
      where.push(sql`(${samples.createdAt} < ${c.ts}::timestamptz OR (${samples.createdAt} = ${c.ts}::timestamptz AND ${samples.id} < ${c.id}))`);
    }
    const rows = await db.select({ s: samples, ts: cursorTs }).from(samples).where(where.length ? and(...where) : undefined)
      .orderBy(desc(samples.createdAt), desc(samples.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { status: 200, body: { data: page.map(r => toSample(r.s)), nextCursor: rows.length > limit && last ? encodeCursor(last.ts, last.s.id) : null } };
  },
});

// ---- GET /samples/{sampleId} ------------------------------------------------------------------------------------------------------

const sampleParams = z.object({ sampleId: z.string().min(1).max(64) }).strict();

defineRoute({
  method: 'GET', path: '/samples/{sampleId}', operationId: 'getSample', scope: 'samples:read',
  summary: 'Read a sample with its results',
  description: 'Each result carries its id, its limit as registered and its record `version`, which a results:batch item sends back as `expectedVersion`.',
  params: sampleParams,
  responses: { 200: { description: 'The sample and its results', schema: z.object({ sample: sampleDto, results: z.array(resultDto) }).strict() } },
  errors: [404],
  async handler({ db, params }) {
    const { sampleId } = params as z.infer<typeof sampleParams>;
    const [sample] = await db.select().from(samples).where(eq(samples.id, sampleId)).limit(1);
    if (!sample) throw new ProblemError(404, 'NOT_FOUND', `Sample ${sampleId} does not exist.`);
    const rows = await db.select().from(results).where(eq(results.sampleId, sampleId)).orderBy(asc(results.parameter), asc(results.id));
    return { status: 200, body: { sample: toSample(sample), results: rows.map(toResult) } };
  },
});

// ---- POST /samples:batch ----------------------------------------------------------------------------------------------------------

export const samplesBatchSchema = z.object({
  items: z.array(sampleRegistrationSchema).min(1, 'items must hold at least one sample.').max(MAX_V1_BATCH, `At most ${MAX_V1_BATCH} samples in one call.`),
}).strict();

defineRoute({
  method: 'POST', path: '/samples:batch', operationId: 'registerSamples', scope: 'samples:write', idempotent: true,
  summary: 'Register up to 500 samples in one call, all or nothing',
  description: 'Each sample is bound to the specification revision in force for its material and gets one result per parameter. ' +
    'If any item cannot be registered, nothing is and the problem names the item (`errors[].index`).',
  body: samplesBatchSchema,
  responses: { 201: { description: 'The registered samples, in the order of the items', schema: z.object({ count: z.number().int(), samples: z.array(sampleDto) }).strict() } },
  errors: [400, 409, 422],
  async handler({ db, client, user, body, idempotencyKey }) {
    const { items } = body as z.infer<typeof samplesBatchSchema>;
    return withIdempotency(db, { clientId: client.id, key: idempotencyKey, operation: 'registerSamples', body }, async (tx) => {
      const specs = new Map<string, ResolvedSpec | null>();
      const rows: Array<{ material: string; batch: string; spec: ResolvedSpec }> = [];
      const errors: Array<{ index: number; pointer: string; detail: string }> = [];
      for (const [index, item] of items.entries()) {
        if (!specs.has(item.material)) specs.set(item.material, await resolveActiveSpec(tx, item.material));
        const spec = specs.get(item.material);
        if (!spec) errors.push({ index, pointer: `/items/${index}`, detail: `No Active specification is in force for material '${item.material}'.` });
        else if (spec.parameters.length === 0) errors.push({ index, pointer: `/items/${index}`, detail: `The specification ${spec.id} of '${item.material}' has no parameters.` });
        else rows.push({ ...item, spec });
      }
      if (errors.length) {
        throw new ProblemError(400, 'ITEM_REFUSED', `${errors.length} of ${items.length} item(s) cannot be registered; nothing was registered.`, errors);
      }
      const created = await insertSamples(tx, user, rows, `Registered by API client "${client.name}" (samples:batch, Idempotency-Key ${idempotencyKey})`);
      const stored = await tx.select().from(samples).where(inArray(samples.id, created.map(c => c.id)));
      const byId = new Map(stored.map(s => [s.id, s]));
      return { status: 201, body: { count: created.length, samples: created.map(c => toSample(byId.get(c.id)!)) } };
    });
  },
});
