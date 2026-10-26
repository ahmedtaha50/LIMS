/**
 * Idempotency keys for the writes of /api/v1 (roadmap M22).
 *
 * An instrument that loses the answer to a write cannot know whether the write happened, so it repeats it. With the same
 * Idempotency-Key the repeat gets the stored answer of the first call (header Idempotent-Replayed: true) and writes nothing; the same
 * key with a different body is a 422. Keys are per client.
 *
 * In ONE transaction: a transaction-scoped advisory lock on (client, key) serialises two calls with the same key (the second waits for
 * the first to commit, then sees its row and replays it); the stored row is checked; the write runs; its answer is stored. A call that
 * fails rolls back with everything else, so the key of a refused call is not spent and the corrected call can reuse it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { apiIdempotencyKeys } from '../../db/schema/api-clients';
import type { Db } from '../core/context';
import { withTransaction, type AfterCommit, type Tx } from '../core/tx';
import { canonicalJson } from '../esign/hash';
import { createHash, randomBytes } from 'crypto';
import { ProblemError } from './problem';
import type { V1Answer } from './registry';

/** Second key space of pg_advisory_xact_lock(int, int): 7001-7003 are single-key locks of the audit, migration and security chains. */
const IDEMPOTENCY_LOCK_SPACE = 7140;
export const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

export function readIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === '') {
    throw new ProblemError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This write needs an Idempotency-Key header (1 to 255 visible ASCII characters), unique per logical request.');
  }
  if (!IDEMPOTENCY_KEY.test(header)) throw new ProblemError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header must be 1 to 255 visible ASCII characters.');
  return header;
}

export async function withIdempotency(
  db: Db,
  input: { clientId: string; key: string; operation: string; body: unknown },
  work: (tx: Tx, afterCommit: AfterCommit) => Promise<{ status: number; body: unknown }>,
): Promise<V1Answer> {
  const requestHash = createHash('sha256').update(canonicalJson({ operation: input.operation, body: input.body })).digest('hex');
  return withTransaction(db, async (tx, afterCommit) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${IDEMPOTENCY_LOCK_SPACE}::int, hashtext(${`${input.clientId} ${input.key}`}::text))`);
    const [prior] = await tx.select().from(apiIdempotencyKeys)
      .where(and(eq(apiIdempotencyKeys.clientId, input.clientId), eq(apiIdempotencyKeys.key, input.key))).limit(1);
    if (prior) {
      if (prior.operation !== input.operation || prior.requestHash !== requestHash) {
        throw new ProblemError(422, 'IDEMPOTENCY_KEY_REUSED',
          `The Idempotency-Key "${input.key}" was already used on ${prior.createdAt.toISOString()} for a different request. Use a new key for a new request.`);
      }
      return { status: prior.statusCode, text: prior.responseBody, headers: { 'Idempotent-Replayed': 'true' } };
    }
    const done = await work(tx, afterCommit);
    const text = JSON.stringify(done.body);
    await tx.insert(apiIdempotencyKeys).values({
      id: `idem-${randomBytes(8).toString('hex')}`, clientId: input.clientId, key: input.key, operation: input.operation, requestHash, statusCode: done.status, responseBody: text,
    });
    return { status: done.status, text };
  });
}
