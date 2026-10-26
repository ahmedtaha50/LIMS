/**
 * Transactional primitives against a real PostgreSQL: version-checked update, row lock, after-commit hooks, sequences.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb, type TestDb } from '../../helpers/testDb';

let tdb: TestDb;
let m: {
  tx: typeof import('../../../src/server/core/tx');
  errors: typeof import('../../../src/server/http/errors');
  db: typeof import('../../../src/db/index')['db'];
  schema: typeof import('../../../src/db/schema');
};

beforeAll(async () => {
  tdb = await useTestDb(); // before any product import: src/db/index reads SQL_DB_NAME once
  m = {
    tx: await import('../../../src/server/core/tx'),
    errors: await import('../../../src/server/http/errors'),
    db: (await import('../../../src/db/index')).db,
    schema: await import('../../../src/db/schema'),
  };
  // Table the sequence primitive relies on; r1-migrations ships it in the real schema.
  await tdb.pool.query('CREATE TABLE IF NOT EXISTS counters (key text PRIMARY KEY, value bigint NOT NULL)');
});

let n = 0;
const newStudy = async () => {
  const id = `STB-TX-${process.pid}-${++n}`;
  await tdb.pool.query(
    `INSERT INTO stability_studies (id, product, batch, condition, pull_points, start_date, status, version)
     VALUES ($1, 'P', 'B', 'C', '[1]', '2026-01-01', 'Ongoing', 1)`, [id]);
  return id;
};

describe('updateVersioned', () => {
  it('updates, bumps the version by one, and returns the new row', async () => {
    const id = await newStudy();
    const row = await m.tx.updateVersioned(m.db, m.schema.stabilityStudies, id, 1, { condition: '30C/65RH' });
    expect(row).toMatchObject({ id, condition: '30C/65RH', version: 2 });
  });

  it('throws ConflictError (409) when the expected version is stale, and writes nothing', async () => {
    const id = await newStudy();
    await m.tx.updateVersioned(m.db, m.schema.stabilityStudies, id, 1, { condition: 'first' });
    await expect(m.tx.updateVersioned(m.db, m.schema.stabilityStudies, id, 1, { condition: 'second' }))
      .rejects.toSatisfy((e: any) => e instanceof m.errors.ConflictError && e.status === 409);
    const { rows } = await tdb.pool.query('SELECT condition, version FROM stability_studies WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ condition: 'first', version: 2 });
  });

  it('throws NotFoundError (404) for a missing row', async () => {
    await expect(m.tx.updateVersioned(m.db, m.schema.stabilityStudies, 'STB-NOPE', 1, { condition: 'x' }))
      .rejects.toBeInstanceOf(m.errors.NotFoundError);
  });

  it('refuses to be handed id or version in the SET list (the counter is managed here)', async () => {
    const id = await newStudy();
    await expect(m.tx.updateVersioned(m.db, m.schema.stabilityStudies, id, 1, { version: 9 } as any)).rejects.toThrow(/version/);
    await expect(m.tx.updateVersioned(m.db, m.schema.stabilityStudies, id, 1, { id: 'other' } as any)).rejects.toThrow(/id/);
  });

  it('is safe under contention: of N writers with the same expected version exactly one wins', async () => {
    const id = await newStudy();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      m.db.transaction(tx => m.tx.updateVersioned(tx, m.schema.stabilityStudies, id, 1, { condition: `writer-${i}` }))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').every((r: any) => r.reason instanceof m.errors.ConflictError)).toBe(true);
    const { rows } = await tdb.pool.query('SELECT version FROM stability_studies WHERE id = $1', [id]);
    expect(rows[0].version).toBe(2);
  });

  it('takes part in the surrounding transaction: a rollback undoes it', async () => {
    const id = await newStudy();
    await expect(m.db.transaction(async tx => {
      await m.tx.updateVersioned(tx, m.schema.stabilityStudies, id, 1, { condition: 'rolled back' });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    const { rows } = await tdb.pool.query('SELECT condition, version FROM stability_studies WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ condition: 'C', version: 1 });
  });
});

describe('lockRow', () => {
  it('returns the row and holds the lock until the transaction ends', async () => {
    const id = await newStudy();
    let releaseA!: () => void;
    const holdA = new Promise<void>(r => { releaseA = r; });
    const order: string[] = [];

    const a = m.db.transaction(async tx => {
      const row = await m.tx.lockRow(tx, m.schema.stabilityStudies, id);
      expect(row.id).toBe(id);
      order.push('A locked');
      await holdA;
      order.push('A done');
    });
    await vi.waitFor(() => expect(order).toContain('A locked'));
    const b = m.db.transaction(async tx => {
      await m.tx.lockRow(tx, m.schema.stabilityStudies, id);
      order.push('B locked');
    });
    await new Promise(r => setTimeout(r, 150));
    expect(order).toEqual(['A locked']); // B is still waiting for the row
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['A locked', 'A done', 'B locked']);
  });

  it('throws NotFoundError for a missing row', async () => {
    await expect(m.db.transaction(tx => m.tx.lockRow(tx, m.schema.stabilityStudies, 'STB-NOPE'))).rejects.toBeInstanceOf(m.errors.NotFoundError);
  });
});

describe('withTransaction / afterCommit / emit', () => {
  it('runs afterCommit hooks once, only after the commit', async () => {
    const id = await newStudy();
    const seen: Array<string | undefined> = [];
    const result = await m.tx.withTransaction(m.db, async (tx, afterCommit) => {
      await m.tx.updateVersioned(tx, m.schema.stabilityStudies, id, 1, { condition: 'committed' });
      afterCommit(async () => {
        // visible to a different connection only if the commit already happened
        seen.push((await tdb.pool.query('SELECT condition FROM stability_studies WHERE id = $1', [id])).rows[0].condition);
      });
      expect(seen).toEqual([]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual(['committed']);
  });

  it('never runs the hooks when the transaction rolls back', async () => {
    const hook = vi.fn();
    await expect(m.tx.withTransaction(m.db, async (_tx, afterCommit) => {
      afterCommit(hook);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(hook).not.toHaveBeenCalled();
  });

  it('a failing hook does not fail the already committed operation', async () => {
    const id = await newStudy();
    const out = await m.tx.withTransaction(m.db, async (tx, afterCommit) => {
      await m.tx.updateVersioned(tx, m.schema.stabilityStudies, id, 1, { condition: 'kept' });
      afterCommit(() => { throw new Error('socket exploded'); });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect((await tdb.pool.query('SELECT condition FROM stability_studies WHERE id = $1', [id])).rows[0].condition).toBe('kept');
  });

  it('emit tolerates a missing or throwing socket server', () => {
    expect(() => m.tx.emit(undefined, 'x', {})).not.toThrow();
    expect(() => m.tx.emit({ emit() { throw new Error('boom'); } }, 'x', {})).not.toThrow();
    const io = { emit: vi.fn() };
    m.tx.emit(io, 'notification', { a: 1 });
    expect(io.emit).toHaveBeenCalledWith('notification', { a: 1 });
  });
});

describe('nextSequence', () => {
  it('counts 1, 2, 3 per key, independently', async () => {
    const key = `seq-a-${process.pid}`;
    const other = `seq-b-${process.pid}`;
    const got = [];
    for (let i = 0; i < 3; i++) got.push(await m.db.transaction(tx => m.tx.nextSequence(tx, key)));
    expect(got).toEqual([1, 2, 3]);
    expect(await m.db.transaction(tx => m.tx.nextSequence(tx, other))).toBe(1);
  });

  it('hands 20 concurrent transactions 20 distinct consecutive numbers', async () => {
    const key = `seq-c-${process.pid}`;
    const got = await Promise.all(Array.from({ length: 20 }, () => m.db.transaction(tx => m.tx.nextSequence(tx, key))));
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('does not burn a number when the transaction rolls back (no gaps)', async () => {
    const key = `seq-d-${process.pid}`;
    expect(await m.db.transaction(tx => m.tx.nextSequence(tx, key))).toBe(1);
    await expect(m.db.transaction(async tx => { await m.tx.nextSequence(tx, key); throw new Error('abort'); })).rejects.toThrow('abort');
    expect(await m.db.transaction(tx => m.tx.nextSequence(tx, key))).toBe(2);
  });
});
