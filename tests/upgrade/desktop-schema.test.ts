/**
 * desktop/schema.sql is the current schema as one script, for restoring a backup into an empty database. It is generated from
 * drizzle/*.sql (npx tsx src/server/boot/migrate-cli.ts export-schema); this test fails when a migration was added without regenerating it,
 * and proves the script builds exactly the structure the migrations build.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSchemaSql } from '../../src/server/boot/schemaSql';
import { fingerprint, readStructure } from '../../src/server/boot/structure';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { ROOT, scratchDb } from './helpers';

describe('desktop/schema.sql', () => {
  it('ships drizzle/ in the installer: the installed server and installer load their migrations from the application folder', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.build.files).toContain('drizzle/**');
  });

  it('is up to date with drizzle/*.sql', () => {
    const generated = buildSchemaSql(loadMigrations(path.join(ROOT, 'drizzle')));
    expect(fs.readFileSync(path.join(ROOT, 'desktop', 'schema.sql'), 'utf8').replace(/\r\n/g, '\n'),
      'run: npx tsx src/server/boot/migrate-cli.ts export-schema').toBe(generated);
  });

  it('builds the same structure as the migrations, plus the journal table, and no rows', async () => {
    const fromFile = await scratchDb('schema-file');
    await fromFile.pool.query(fs.readFileSync(path.join(ROOT, 'desktop', 'schema.sql'), 'utf8'));
    const fromMigrations = await scratchDb('schema-migr');
    await migrate(fromMigrations.pool, { dir: path.join(ROOT, 'drizzle') });

    const a = await readStructure(fromFile.pool);
    expect(fingerprint(a)).toBe(fingerprint(await readStructure(fromMigrations.pool)));
    expect(Object.keys(a)).toContain('counters');
    expect((await fromFile.pool.query('select count(*)::int as n from schema_migrations')).rows[0].n).toBe(0);
    expect((await fromFile.pool.query('select count(*)::int as n from audit_trail')).rows[0].n).toBe(0);
  });

  it('can be built for an older version (a restore of an old backup needs the structure of its time)', async () => {
    const files = loadMigrations(path.join(ROOT, 'drizzle'));
    const old = await scratchDb('schema-old');
    await old.pool.query(buildSchemaSql(files, '0000_baseline'));
    const naive = await old.pool.query(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone'`);
    expect(naive.rows[0].n).toBe(15);
  });
});
