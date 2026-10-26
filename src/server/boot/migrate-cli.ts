/**
 * Migration command line (developers, IT, CI). Connection from SQL_HOST, SQL_USER, SQL_PASSWORD, SQL_DB_NAME.
 *
 *   npx tsx src/server/boot/migrate-cli.ts status          journal against files; exit 0 when current, 3 when not
 *   npx tsx src/server/boot/migrate-cli.ts migrate         apply pending migrations (backup first when the database holds data)
 *   npx tsx src/server/boot/migrate-cli.ts structure       the database's structural description and fingerprint (support, baselines)
 *   npx tsx src/server/boot/migrate-cli.ts export-schema [file] [upTo]   rewrite desktop/schema.sql from drizzle/*.sql; with upTo (a migration id) the
 *                                                           schema of that older version, e.g. 0000_baseline to restore a pre-migration backup
 *   npx tsx src/server/boot/migrate-cli.ts draft           SQL that would turn the database into src/db/schema (starting point for a new migration)
 */
import fs from 'fs';
import path from 'path';
import { createPool } from '../../db/index';
import { inspectSchema, loadMigrations, MigrationError } from '../migrate';
import { bootDatabase } from './index';
import { buildSchemaSql } from './schemaSql';
import { fingerprint, readStructure } from './structure';

async function main() {
  const [cmd, arg, upTo] = process.argv.slice(2);
  const pool = createPool();
  try {
    if (cmd === 'migrate') {
      const { report } = await bootDatabase({ migrate: true, pool, log: m => console.log(m) });
      console.log(JSON.stringify(report));
    } else if (cmd === 'status') {
      const files = loadMigrations();
      const state = await inspectSchema(pool, files);
      const pending = state.kind === 'legacy' ? [state.baseline, ...state.pending] : state.pending;
      console.log(JSON.stringify({ state: state.kind, applied: state.kind === 'journaled' ? state.applied.map(a => ({ id: a.id, appliedAt: a.appliedAt, appVersion: a.appVersion })) : [], pending: pending.map(p => p.id) }, null, 2));
      if (pending.length > 0) process.exitCode = 3;
    } else if (cmd === 'structure') {
      const structure = await readStructure(pool);
      console.log(JSON.stringify({ fingerprint: fingerprint(structure), structure }, null, 2));
    } else if (cmd === 'export-schema') {
      const file = arg || path.join(process.cwd(), 'desktop', 'schema.sql');
      fs.writeFileSync(file, buildSchemaSql(loadMigrations(), upTo));
      console.log(`Wrote ${file}`);
    } else if (cmd === 'draft') {
      const { pushSchema } = await import('drizzle-kit/api');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const schema = await import('../../db/schema/index');
      const { statementsToExecute, warnings } = await pushSchema(schema as any, drizzle(pool) as any, ['public'], ['!schema_migrations']);
      for (const w of warnings) console.error(`-- warning: ${w}`);
      console.log(statementsToExecute.length ? statementsToExecute.join('\n') : '-- no difference between src/db/schema and the database');
    } else {
      console.error('Usage: migrate-cli.ts status | migrate | structure | export-schema [file] [upTo] | draft');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(e instanceof MigrationError ? `${e.code}: ${e.message}` : e);
  process.exit(1);
});
