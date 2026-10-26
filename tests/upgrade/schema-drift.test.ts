/**
 * Acceptance (M04): CI fails when src/db/schema changes without a migration.
 *
 * The database is built ONLY from drizzle/*.sql by the runner; drizzle-kit's differ (the one `drizzle-kit push` uses) then compares
 * it with the Drizzle schema. Any statement it would run is drift: a column, index, default, nullability or type that the schema
 * declares and no migration creates, or the other way round. The negative controls prove the check can fail.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgTable, bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { pushSchema } from 'drizzle-kit/api';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { migrate } from '../../src/server/migrate';
import { ROOT, scratchDb, type Scratch } from './helpers';
import path from 'path';

const drift = async (s: Scratch, declared: Record<string, unknown> = schema) =>
  (await pushSchema(declared, drizzle(s.pool) as any, ['public'], ['!schema_migrations'])).statementsToExecute;

let s: Scratch;
beforeAll(async () => {
  s = await scratchDb('drift');
  await migrate(s.pool, { dir: path.join(ROOT, 'drizzle') });
});

describe('src/db/schema against the schema the migrations build', () => {
  it('has no difference', async () => {
    expect(await drift(s)).toEqual([]);
  });

  it('detects a column that exists in the database but not in the schema', async () => {
    await s.pool.query('ALTER TABLE samples ADD COLUMN drift_probe text');
    try { expect(await drift(s)).toEqual(['ALTER TABLE "samples" DROP COLUMN "drift_probe";']); }
    finally { await s.pool.query('ALTER TABLE samples DROP COLUMN drift_probe'); }
  });

  it('detects a column added to the schema without a migration', async () => {
    const changed = { ...schema, counters: pgTable('counters', { key: text('key').primaryKey(), value: bigint('value', { mode: 'number' }).notNull(), note: text('note') }) };
    expect((await drift(s, changed)).join('\n')).toMatch(/ALTER TABLE "counters" ADD COLUMN "note" text/);
  });

  it('detects a new table in the schema without a migration', async () => {
    const changed = { ...schema, probeTable: pgTable('probe_table', { id: text('id').primaryKey() }) };
    expect((await drift(s, changed)).join('\n')).toMatch(/CREATE TABLE "probe_table"/);
  });

  it('detects a missing index', async () => {
    await s.pool.query('DROP INDEX results_sample_id_idx');
    try { expect((await drift(s)).join('\n')).toMatch(/CREATE INDEX "results_sample_id_idx" ON "results"/); }
    finally { await s.pool.query('CREATE INDEX results_sample_id_idx ON results USING btree (sample_id)'); }
  });
});

describe('timestamps', () => {
  it('every timestamp column the schema declares is timestamptz, and so is every one in the migrated database', async () => {
    const naive: string[] = [];
    for (const table of (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable))) {
      const cfg = getTableConfig(table);
      for (const c of cfg.columns) if (c.getSQLType().startsWith('timestamp') && !c.getSQLType().includes('with time zone')) naive.push(`${cfg.name}.${c.name}`);
    }
    expect(naive).toEqual([]);

    const db = await s.pool.query(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'timestamp without time zone'`);
    expect(db.rows).toEqual([]);
  });

  it('a naive timestamp added to the schema is reported as drift', async () => {
    const changed = { ...schema, jobs: pgTable('jobs', {
      id: text('id').primaryKey(), type: text('type').notNull(), status: text('status').notNull(), payload: text('payload'), result: text('result'),
      createdAt: timestamp('created_at').defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    }) };
    expect((await drift(s, changed)).join('\n')).toMatch(/ALTER COLUMN "created_at" SET DATA TYPE timestamp/);
  });
});
