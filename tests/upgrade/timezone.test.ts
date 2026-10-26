/**
 * Acceptance (M04): under a database session zone other than UTC (the acceptance text says PGTZ=Africa/Cairo), a timestamp
 * written by a column DEFAULT and one supplied by the application read back with identical semantics.
 *
 * Before the fix both kinds were `timestamp without time zone`: DEFAULT now() stored the session zone's wall clock, the
 * application stored UTC wall clock, and drizzle read both as UTC, so the two differed by the zone offset (3 h in Cairo in October).
 * node-postgres does not read PGTZ, so the zone is set the way libpq would: as a start-up option on the connection.
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { connectionConfig } from '../helpers/db';
import { runInitDb, scratchDb } from './helpers';

const CAIRO = '-c timezone=Africa/Cairo';

describe('timestamps under a non-UTC session zone', () => {
  it('a DB-default and an app-supplied timestamp are the same instant when read back through drizzle', async () => {
    const s = await scratchDb('tz');
    const install = runInitDb(s);
    expect(install.status, install.stderr).toBe(0);

    const cairo = new pg.Pool({ ...connectionConfig(s.name), max: 2, options: CAIRO });
    try {
      expect((await cairo.query('SHOW timezone')).rows[0].TimeZone).toBe('Africa/Cairo');
      const db = drizzle(cairo, { schema });

      const before = Date.now();
      await db.insert(schema.jobs).values({ id: 'tz-1', type: 'tz-test', status: 'queued', updatedAt: new Date() });
      const [row] = await db.select().from(schema.jobs);
      const after = Date.now();

      const slack = 30_000; // clock reads and the round trip; the zone error being tested is hours
      for (const [column, value] of [['createdAt (DEFAULT now())', row.createdAt], ['updatedAt (supplied by the app)', row.updatedAt]] as const) {
        expect(value.getTime(), column).toBeGreaterThanOrEqual(before - slack);
        expect(value.getTime(), column).toBeLessThanOrEqual(after + slack);
      }
      expect(Math.abs(row.createdAt.getTime() - row.updatedAt.getTime())).toBeLessThan(slack);
    } finally {
      await cairo.end();
    }
  });
});
