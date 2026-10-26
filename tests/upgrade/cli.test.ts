/**
 * The migration command line (src/server/boot/migrate-cli.ts), as developers, CI and IT run it.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { baselineFingerprint, loadMigrations } from '../../src/server/migrate';
import { ROOT, loadV010, runTs, scratchDb, tempDir } from './helpers';

const cli = (s: { env: Record<string, string> }, ...args: string[]) => runTs('src/server/boot/migrate-cli.ts', args, s.env);

describe('migrate-cli', () => {
  it('status says what is pending (exit 3) and, after migrate, that nothing is (exit 0)', async () => {
    const s = await scratchDb('cli');
    const before = cli(s, 'status');
    expect(before.status).toBe(3);
    expect(JSON.parse(before.stdout)).toMatchObject({ state: 'empty' });
    expect(JSON.parse(before.stdout).pending.slice(0, 2)).toEqual(['0000_baseline', '0001_timestamptz']);

    const migrated = cli(s, 'migrate');
    expect(migrated.status, migrated.stderr).toBe(0);
    const after = cli(s, 'status');
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ state: 'journaled', pending: [] });
  });

  it('structure prints the fingerprint a v0.1.0 installation must have (the one in the header of 0000)', async () => {
    const s = await scratchDb('cli-structure');
    await loadV010(s, { data: false });
    const out = cli(s, 'structure');
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).fingerprint).toBe(baselineFingerprint(loadMigrations(path.join(ROOT, 'drizzle'))[0]));
  });

  it('refuses a v0.1.0 database without a backup passphrase with a readable message and exit code 1', async () => {
    const s = await scratchDb('cli-nobackup');
    await loadV010(s);
    const out = runTs('src/server/boot/migrate-cli.ts', ['migrate'], { ...s.env, MIGRATION_BACKUP_PASSPHRASE: '', BACKUP_PASSPHRASE: '' });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/^BACKUP_REQUIRED: .*MIGRATION_BACKUP_PASSPHRASE/m);
  });

  it('draft prints nothing to do on a migrated database, and the SQL for a difference', async () => {
    const s = await scratchDb('cli-draft');
    expect(cli(s, 'migrate').status).toBe(0);
    expect(cli(s, 'draft').stdout).toMatch(/no difference/);
    await s.pool.query('ALTER TABLE reagents ADD COLUMN drift_probe text');
    expect(cli(s, 'draft').stdout).toContain('ALTER TABLE "reagents" DROP COLUMN "drift_probe";');
  });

  it('export-schema writes the newest schema, or the schema of an older version', () => {
    const dir = tempDir('bplims-export');
    const file = path.join(dir, 'schema.sql');
    const s = { env: {} };
    expect(cli(s, 'export-schema', file).status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain('===== 0003_indexes');
    expect(cli(s, 'export-schema', file, '0000_baseline').status).toBe(0);
    const old = fs.readFileSync(file, 'utf8');
    expect(old).toContain('===== 0000_baseline');
    expect(old).not.toContain('===== 0001_timestamptz');
  });
});
