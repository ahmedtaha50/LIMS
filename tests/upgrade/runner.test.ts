/**
 * The migration runner against a real PostgreSQL: journal and checksums, the refusals (edited migration, newer database,
 * out-of-order file, unknown legacy structure, no backup), atomicity, and serialisation of concurrent starters.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/server/backup';
import { fingerprint, readStructure } from '../../src/server/boot/structure';
import { MigrationError, baselineFingerprint, loadMigrations, migrate, verifySchema, type BackupFn } from '../../src/server/migrate';
import { ROOT, loadV010, scratchDb, tableExists, tempDir } from './helpers';

const REAL_DIR = path.join(ROOT, 'drizzle');
const okBackup: BackupFn = async () => ({ file: '/tmp/stub.bak', sha256: 'a'.repeat(64), verified: true });

/** A private copy of drizzle/ that a test may edit. */
function copyMigrations(only?: (name: string) => boolean): string {
  const dir = tempDir('bplims-migrations');
  for (const name of fs.readdirSync(REAL_DIR).filter(n => n.endsWith('.sql'))) {
    if (!only || only(name)) fs.copyFileSync(path.join(REAL_DIR, name), path.join(dir, name));
  }
  return dir;
}

const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof MigrationError) return e.code; throw e; }
  return 'NO_ERROR';
};
const journal = async (s: Awaited<ReturnType<typeof scratchDb>>) =>
  (await s.pool.query('select id, sha256 from schema_migrations order by id')).rows as Array<{ id: string; sha256: string }>;
const auditActions = async (s: Awaited<ReturnType<typeof scratchDb>>) =>
  (await s.pool.query('select sequence, action, user_id from audit_trail order by sequence')).rows;

describe('the real migrations folder', () => {
  it('is a gapless-enough, uniquely numbered, checksummed sequence starting at the v0.1.0 baseline', () => {
    const files = loadMigrations(REAL_DIR);
    expect(files.map(f => f.id).slice(0, 4)).toEqual(['0000_baseline', '0001_timestamptz', '0002_counters', '0003_indexes']);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(REAL_DIR, `${f.id}.sql`), 'utf8').replace(/\r\n/g, '\n');
      expect(f.sha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    }
  });
});

describe('the baseline', () => {
  it('0000 builds exactly the structure its header claims, and so does the v0.1.0 installer schema (what a legacy install is compared with)', async () => {
    const files = loadMigrations(REAL_DIR);
    const claimed = baselineFingerprint(files[0]);
    expect(claimed).toMatch(/^[0-9a-f]{64}$/);

    const built = await scratchDb('baseline');
    await migrate(built.pool, { dir: REAL_DIR, upTo: '0000_baseline' });
    expect(fingerprint(await readStructure(built.pool))).toBe(claimed);

    const installer = await scratchDb('baseline-v010');
    await loadV010(installer, { data: false });
    expect(fingerprint(await readStructure(installer.pool))).toBe(claimed);
  });
});

describe('a fresh database', () => {
  it('is installed in one run: journal rows with the files\' checksums, one SCHEMA_MIGRATED entry, no backup needed', async () => {
    const s = await scratchDb('fresh');
    const files = loadMigrations(REAL_DIR);
    const report = await migrate(s.pool, { dir: REAL_DIR });

    expect(report).toMatchObject({ status: 'migrated', fresh: true, adoptedBaseline: false, backup: null, schemaVersion: files.at(-1)!.id });
    expect(report.applied).toEqual(files.map(f => f.id));
    expect(await journal(s)).toEqual(files.map(f => ({ id: f.id, sha256: f.sha256 })));

    const audit = await auditActions(s);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('SCHEMA_MIGRATED');
    expect(audit[0].user_id).toMatch(/^migration:.+/);
    const rows = (await s.pool.query('select * from audit_trail')).rows;
    expect(verifyAuditChain(rows)).toEqual({ isValid: true, compromisedSequence: null });
    const detail = JSON.parse((await s.pool.query('select new_value from audit_trail')).rows[0].new_value);
    expect(detail.applied.map((a: any) => a.id)).toEqual(files.map(f => f.id));
    expect(detail.applied[0].sha256).toBe(files[0].sha256);
  });

  it('is a no-op the second time: nothing applied, no second audit entry', async () => {
    const s = await scratchDb('rerun');
    await migrate(s.pool, { dir: REAL_DIR });
    const again = await migrate(s.pool, { dir: REAL_DIR });
    expect(again).toMatchObject({ status: 'up-to-date', applied: [], backup: null, auditSequence: null });
    expect(await auditActions(s)).toHaveLength(1);
    await expect(verifySchema(s.pool, { dir: REAL_DIR })).resolves.toBeTruthy();
  });

  it('serialises concurrent starters: both succeed, exactly one applies, one audit entry', async () => {
    const s = await scratchDb('race');
    const results = await Promise.all([migrate(s.pool, { dir: REAL_DIR }), migrate(s.pool, { dir: REAL_DIR }), migrate(s.pool, { dir: REAL_DIR })]);
    expect(results.map(r => r.status).sort()).toEqual(['migrated', 'up-to-date', 'up-to-date']);
    expect(await auditActions(s)).toHaveLength(1);
  });
});

describe('a v0.1.0 installation (tables, data, no journal)', () => {
  it('is recognised by its structure: the journal starts at 0000 without executing it, the rest is applied after a backup', async () => {
    const s = await scratchDb('legacy');
    await loadV010(s);
    const files = loadMigrations(REAL_DIR);
    const seen: string[] = [];
    const report = await migrate(s.pool, { dir: REAL_DIR, backup: async () => { seen.push('backup before change'); return okBackup({ pool: s.pool }); } });
    expect(seen).toEqual(['backup before change']);
    expect(report).toMatchObject({ status: 'migrated', fresh: false, adoptedBaseline: true });
    expect(report.applied).toEqual(files.slice(1).map(f => f.id));
    expect((await journal(s)).map(r => r.id)).toEqual(files.map(f => f.id));
    expect(verifyAuditChain((await s.pool.query('select * from audit_trail')).rows).isValid).toBe(true);
  });
});

describe('refusals (the database is left exactly as it was)', () => {
  it('an applied migration that was edited is refused by checksum', async () => {
    const s = await scratchDb('edited');
    const dir = copyMigrations();
    await migrate(s.pool, { dir });
    const before = await journal(s);

    fs.appendFileSync(path.join(dir, '0002_counters.sql'), '\n-- harmless looking comment\n');
    expect(await codeOf(migrate(s.pool, { dir }))).toBe('CHECKSUM_MISMATCH');
    expect(await codeOf(verifySchema(s.pool, { dir }))).toBe('CHECKSUM_MISMATCH');
    expect(await journal(s)).toEqual(before);
    expect(await auditActions(s)).toHaveLength(1);
  });

  it('a Windows checkout of the same file (CRLF, BOM) is not an edit', async () => {
    const s = await scratchDb('crlf');
    const dir = copyMigrations();
    await migrate(s.pool, { dir });
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, '﻿' + fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect((await migrate(s.pool, { dir })).status).toBe('up-to-date');
  });

  it('a database migrated by a newer build is refused (downgrade guard), by migrate and by the start-up check', async () => {
    const s = await scratchDb('newer');
    await migrate(s.pool, { dir: REAL_DIR });
    const older = copyMigrations(n => !n.startsWith('0003_')); // this "build" does not know 0003
    expect(await codeOf(migrate(s.pool, { dir: older }))).toBe('SCHEMA_NEWER');
    expect(await codeOf(verifySchema(s.pool, { dir: older }))).toBe('SCHEMA_NEWER');
    expect((await journal(s)).map(r => r.id)).toContain('0003_indexes');
  });

  it('a new file numbered below an applied one is refused (forward-only)', async () => {
    const s = await scratchDb('order');
    const dir = copyMigrations(n => !n.startsWith('0002_'));
    await migrate(s.pool, { dir });
    fs.copyFileSync(path.join(REAL_DIR, '0002_counters.sql'), path.join(dir, '0002_counters.sql'));
    expect(await codeOf(migrate(s.pool, { dir }))).toBe('OUT_OF_ORDER');
    expect(await tableExists(s.pool, 'counters')).toBe(false);
  });

  it('a failing migration undoes everything of the run: no table, no journal row, no audit entry', async () => {
    const s = await scratchDb('broken');
    const dir = copyMigrations();
    await migrate(s.pool, { dir });
    const before = await journal(s);
    fs.writeFileSync(path.join(dir, '0999_broken.sql'), 'CREATE TABLE half_done (id int);\n\nINSERT INTO half_done VALUES (1);\nSELECT * FROM no_such_table;\n');

    const err: any = await migrate(s.pool, { dir, backup: okBackup }).catch(e => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.code).toBe('MIGRATION_FAILED');
    expect(err.message).toMatch(/0999_broken failed at line 4: relation "no_such_table" does not exist/);
    expect(await tableExists(s.pool, 'half_done')).toBe(false);
    expect(await journal(s)).toEqual(before);
    expect(await auditActions(s)).toHaveLength(1);
  });

  it('a database with tables but no journal is accepted only if it is exactly v0.1.0', async () => {
    const s = await scratchDb('hand-edited');
    await loadV010(s, { data: false });
    await s.pool.query('ALTER TABLE samples ADD COLUMN extra text');
    expect(await codeOf(migrate(s.pool, { dir: REAL_DIR, backup: okBackup }))).toBe('LEGACY_MISMATCH');
    expect(await tableExists(s.pool, 'schema_migrations')).toBe(false);
    expect((await s.pool.query(`select data_type from information_schema.columns where table_name = 'signatures' and column_name = 'timestamp'`)).rows[0].data_type)
      .toBe('timestamp without time zone');
  });

  it('waits for table locks only briefly: a session that still holds the tables (a running server) makes the run fail cleanly, not hang', async () => {
    const s = await scratchDb('locked');
    await loadV010(s, { data: false });
    const holder = await s.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE users IN ACCESS SHARE MODE');
      const err: any = await migrate(s.pool, { dir: REAL_DIR, backup: okBackup, tableLockTimeoutMs: 500 }).catch(e => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.code).toBe('MIGRATION_FAILED');
      expect(err.message).toMatch(/lock timeout/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await tableExists(s.pool, 'schema_migrations')).toBe(false); // nothing was journaled, nothing changed
    expect((await migrate(s.pool, { dir: REAL_DIR, backup: okBackup })).status).toBe('migrated'); // and it works once the lock is gone
  });

  it('a database that holds data is not migrated without a backup, nor with one that failed or did not verify', async () => {
    const s = await scratchDb('nobackup');
    await loadV010(s);
    expect(await codeOf(migrate(s.pool, { dir: REAL_DIR }))).toBe('BACKUP_REQUIRED');
    expect(await codeOf(migrate(s.pool, { dir: REAL_DIR, backup: async () => { throw new Error('disk full'); } }))).toBe('BACKUP_FAILED');
    expect(await codeOf(migrate(s.pool, { dir: REAL_DIR, backup: async () => ({ file: 'x', sha256: 'y', verified: false }) }))).toBe('BACKUP_FAILED');
    expect(await tableExists(s.pool, 'schema_migrations')).toBe(false);
    expect((await s.pool.query('select count(*)::int as n from audit_trail')).rows[0].n).toBe(30);
  });

  it('malformed migration folders are refused: bad file name, duplicate number, empty folder, missing folder', () => {
    const bad = tempDir('bplims-bad');
    fs.writeFileSync(path.join(bad, 'Add-Stuff.sql'), 'select 1;');
    expect(() => loadMigrations(bad)).toThrow(/must be named NNNN_/);

    const dup = tempDir('bplims-dup');
    fs.writeFileSync(path.join(dup, '0010_a.sql'), 'select 1;');
    fs.writeFileSync(path.join(dup, '0010_b.sql'), 'select 2;');
    expect(() => loadMigrations(dup)).toThrow(/share the number 0010/);

    expect(() => loadMigrations(tempDir('bplims-empty'))).toThrow(/No migrations found/);
    expect(() => loadMigrations(path.join(tempDir('bplims-none'), 'nope'))).toThrow(/folder not found/);
  });
});

describe('start-up check without migrating (verifySchema)', () => {
  it('says "behind" for an empty database, a v0.1.0 installation and a partly migrated database', async () => {
    const empty = await scratchDb('v-empty');
    expect(await codeOf(verifySchema(empty.pool, { dir: REAL_DIR }))).toBe('SCHEMA_BEHIND');

    const legacy = await scratchDb('v-legacy');
    await loadV010(legacy, { data: false });
    expect(await codeOf(verifySchema(legacy.pool, { dir: REAL_DIR }))).toBe('SCHEMA_BEHIND');

    const partial = await scratchDb('v-partial');
    await migrate(partial.pool, { dir: REAL_DIR, upTo: '0001_timestamptz' });
    const err: any = await verifySchema(partial.pool, { dir: REAL_DIR }).catch(e => e);
    expect(err.code).toBe('SCHEMA_BEHIND');
    expect(err.message).toMatch(/0002_counters, 0003_indexes/);
  });

  it('upTo stops at the requested migration and a later run continues from there', async () => {
    const s = await scratchDb('upto');
    const first = await migrate(s.pool, { dir: REAL_DIR, upTo: '0001_timestamptz' });
    expect(first.applied).toEqual(['0000_baseline', '0001_timestamptz']);
    expect(await tableExists(s.pool, 'counters')).toBe(false);
    const second = await migrate(s.pool, { dir: REAL_DIR, backup: okBackup });
    expect(second.applied.slice(0, 2)).toEqual(['0002_counters', '0003_indexes']);
    expect(second.backup).not.toBeNull(); // the database now holds an audit trail: a backup is required
    expect(verifyAuditChain((await s.pool.query('select * from audit_trail')).rows).isValid).toBe(true);
  });
});
