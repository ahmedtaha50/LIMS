/**
 * bootDatabase: the one start-up call for installer and server.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { protectionStatements } from '../../src/db/protections';
import { bootDatabase } from '../../src/server/boot';
import { MigrationError } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb } from './helpers';

const dir = path.join(ROOT, 'drizzle');
const trigger = `select count(*)::int as n from pg_trigger where tgname like 'gxp\\_%'`;
/** The append-only triggers the registry declares (a new append-only table adds two). */
const declared = (protectionStatements.join(' ').match(/CREATE TRIGGER gxp_/g) ?? []).length;

describe('bootDatabase', () => {
  it('migrate:true installs a new database including the triggers, in one call', async () => {
    const s = await scratchDb('boot-new');
    const { report } = await bootDatabase({ migrate: true, pool: s.pool, dir, backup: null });
    expect(report?.status).toBe('migrated');
    expect((await s.pool.query(trigger)).rows[0].n).toBe(declared);
  });

  it('migrate:false checks only: it accepts a current database and re-installs a missing trigger, but never migrates', async () => {
    const s = await scratchDb('boot-check');
    await bootDatabase({ migrate: true, pool: s.pool, dir, backup: null });
    await s.pool.query('DROP TRIGGER gxp_signatures_truncate_guard ON signatures');
    const { report } = await bootDatabase({ migrate: false, pool: s.pool, dir });
    expect(report).toBeNull();
    expect((await s.pool.query(trigger)).rows[0].n).toBe(declared);

    const behind = await scratchDb('boot-behind');
    await loadV010(behind);
    const err = await bootDatabase({ migrate: false, pool: behind.pool, dir }).catch(e => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.code).toBe('SCHEMA_BEHIND');
    expect((await behind.pool.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t).toBeNull();
  });
});
