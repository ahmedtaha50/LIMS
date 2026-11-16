import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, MigrationChangedError, readMigrations } from '../../server/migrate/runner.js';
import { MIGRATIONS } from '../helpers/app.js';
import { freshDatabase } from '../helpers/db.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function db() { const d = await freshDatabase('mig'); cleanup.push(d.drop); return d; }
function dir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'ebr-mig-'));
  for (const [f, sql] of Object.entries(files)) writeFileSync(join(d, f), sql);
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe('migrations (E01#2)', () => {
  it('the project migrations apply on an empty database, and applying them twice changes nothing', async () => {
    const d = await db();
    const first = await migrate(d.pool, MIGRATIONS);
    expect(first.applied.length).toBe(readMigrations(MIGRATIONS).length);
    const schemaBefore = await d.pool.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2");
    const second = await migrate(d.pool, MIGRATIONS);
    expect(second.applied).toEqual([]);
    const schemaAfter = await d.pool.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2");
    expect(schemaAfter.rows).toEqual(schemaBefore.rows);
  });

  it('a migration edited after it was applied is refused at start-up', async () => {
    const d = await db(), m = dir({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    await migrate(d.pool, m);
    appendFileSync(join(m, '0000_a.sql'), '\nALTER TABLE a ADD COLUMN x int;');
    await expect(migrate(d.pool, m)).rejects.toBeInstanceOf(MigrationChangedError);
    await expect(migrate(d.pool, m)).rejects.toThrow(/was edited after it was applied/);
  });

  it('an applied migration whose file was deleted is refused', async () => {
    const d = await db(), m = dir({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    await migrate(d.pool, m);
    rmSync(join(m, '0000_a.sql'));
    await expect(migrate(d.pool, m)).rejects.toThrow(/its file is missing/);
  });

  it('a failing migration leaves nothing behind: neither its tables nor its ledger row', async () => {
    const d = await db(), m = dir({ '0000_a.sql': 'CREATE TABLE a (id int);', '0001_b.sql': 'CREATE TABLE b (id int); SELECT 1/0;' });
    await expect(migrate(d.pool, m)).rejects.toThrow(/0001_b failed/);
    const t = await d.pool.query("SELECT to_regclass('a') AS a, to_regclass('b') AS b");
    expect(t.rows[0]).toEqual({ a: 'a', b: null });
    const led = await d.pool.query('SELECT version FROM schema_migrations');
    expect(led.rows).toEqual([{ version: '0000' }]);
  });

  it('two instances starting at once apply each migration exactly once (advisory lock)', async () => {
    const d = await db(), m = dir({ '0000_a.sql': 'CREATE TABLE a (id int);', '0001_slow.sql': 'SELECT pg_sleep(0.3); CREATE TABLE b (id int);' });
    const [x, y] = await Promise.all([migrate(d.pool, m), migrate(d.pool, m)]);
    expect([...x.applied, ...y.applied].sort()).toEqual(['0000_a', '0001_slow']);
  });

  it('badly named files and duplicate numbers are refused', () => {
    expect(() => readMigrations(dir({ '0000_a.sql': '', 'add-thing.sql': '' }))).toThrow(/NNNN_lowercase_name/);
    expect(() => readMigrations(dir({ '0003_a.sql': '', '0003_b.sql': '' }))).toThrow(/two migrations have the number 0003/);
  });
});
