/**
 * Transactional primitives. They are what AGENTS.md section 2 asks for, so a feature gets them by calling a function
 * instead of remembering to write the SQL:
 *   updateVersioned  UPDATE ... WHERE id = $1 AND version = $2, version + 1, 409 when no row matched
 *   lockRow          SELECT ... FOR UPDATE for read-validate-write flows that span several rows
 *   withTransaction  db.transaction plus afterCommit hooks (socket emits, queue publishes) that never fire on rollback
 *   nextSequence     gap-free per-key counter (needs the `counters` table)
 */
import { and, eq, getTableName, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgDatabase, PgTable } from 'drizzle-orm/pg-core';
import { ConflictError, NotFoundError } from '../http/errors';
import type { Db, IoLike } from './context';
import { log, serializeError } from './logger';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A database or a transaction: both expose the same query builders. */
export type Executor = PgDatabase<any, any, any>;

type WithId = PgTable & { id: AnyPgColumn };
type Versioned = WithId & { version: AnyPgColumn };

/**
 * Optimistic-concurrency update. `set` must not contain id or version: the counter is incremented here, in SQL,
 * in the same statement that checks it, so two writers holding the same expectedVersion cannot both succeed
 * (the second one waits for the row lock, re-evaluates the predicate, and matches nothing).
 * Returns the updated row. Throws ConflictError when the version moved, NotFoundError when the row is gone.
 */
export async function updateVersioned<T extends Versioned>(
  ex: Executor,
  table: T,
  id: string,
  expectedVersion: number,
  set: Partial<Omit<T['$inferInsert'], 'id' | 'version'>>,
): Promise<T['$inferSelect']> {
  for (const forbidden of ['id', 'version']) {
    if (forbidden in set) throw new Error(`updateVersioned: "${forbidden}" must not be in the SET list`);
  }
  const t = table as unknown as Versioned; // drizzle's builder types do not accept an open generic table
  const rows = await ex
    .update(t)
    .set({ ...set, version: sql`${t.version} + 1` } as any)
    .where(and(eq(t.id, id), eq(t.version, expectedVersion)))
    .returning();
  if (rows.length === 1) return rows[0] as T['$inferSelect'];

  const exists = await ex.select({ id: t.id }).from(t).where(eq(t.id, id)).limit(1);
  if (exists.length === 0) throw new NotFoundError(`${getTableName(t)} ${id} was not found.`);
  throw new ConflictError();
}

/** SELECT ... FOR UPDATE by id. The lock lasts until the surrounding transaction ends. */
export async function lockRow<T extends WithId>(ex: Executor, table: T, id: string): Promise<T['$inferSelect']> {
  const t = table as unknown as WithId;
  const rows = await ex.select().from(t).where(eq(t.id, id)).for('update');
  if (rows.length === 0) throw new NotFoundError(`${getTableName(t)} ${id} was not found.`);
  return rows[0] as T['$inferSelect'];
}

export type AfterCommit = (hook: () => void | Promise<void>) => void;

/**
 * db.transaction that also collects afterCommit hooks. Hooks run in order after COMMIT has returned and never on rollback;
 * a failing hook is logged and does not fail the operation that already committed (nothing can be undone by then).
 * Put every side effect that must not outrun the data here: a socket emit before COMMIT can announce a record that
 * then rolls back.
 */
export async function withTransaction<T>(db: Db, work: (tx: Tx, afterCommit: AfterCommit) => Promise<T>): Promise<T> {
  const hooks: Array<() => void | Promise<void>> = [];
  const result = await db.transaction(tx => work(tx, hook => { hooks.push(hook); }));
  for (const hook of hooks) {
    try { await hook(); } catch (err) { log.error({ err: serializeError(err) }, 'afterCommit hook failed'); }
  }
  return result;
}

/** io.emit that tolerates a missing server (tests, jobs) and never throws into the caller. */
export function emit(io: IoLike | undefined, event: string, payload?: unknown): void {
  try { io?.emit(event, payload); } catch (err) { log.error({ err: serializeError(err), event }, 'socket emit failed'); }
}

/**
 * Next value of a named counter: 1, 2, 3, ... The row lock taken by the upsert is held until the surrounding
 * transaction ends, so concurrent callers queue, and a rolled-back transaction does not burn a number (no gaps, no duplicates).
 * Requires: CREATE TABLE counters (key text PRIMARY KEY, value bigint NOT NULL)   -- shipped by the r1-migrations track.
 */
export async function nextSequence(ex: Executor, key: string): Promise<number> {
  const result = await ex.execute(sql`
    INSERT INTO counters (key, value) VALUES (${key}, 1)
    ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
    RETURNING value`);
  return Number((result as any).rows[0].value);
}
