/**
 * Backup v2 operations (roadmap M14): a run is recorded (append-only backup_runs), mirrored with a re-hash, pruned by the
 * 7 daily / 4 weekly / 12 monthly rule, and proven restorable by a drill into a scratch database. The status the UI shows
 * (last good backup, mirror, banner) is derived from those records. Real PostgreSQL, real files.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { tempDir } from '../upgrade/helpers';

const PASS = 'a long scheduled backup passphrase';
const sha256File = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let t: TestApp;
let db: any;
let pool: any;
let svc: typeof import('../../src/server/jobs/backupService');
let backup: typeof import('../../src/server/backup');
let principalId: string;

beforeAll(async () => {
  t = await startTestApp();
  ({ db } = await import('../../src/db/index'));
  pool = (await import('../../src/db/index')).createPool();
  svc = await import('../../src/server/jobs/backupService');
  backup = await import('../../src/server/backup');
  principalId = (await (await import('../../src/server/jobs/principal')).ensureServicePrincipal(db));
});

const settings = (over: Partial<import('../../src/server/jobs/backupService').BackupSettings> = {}) =>
  ({ ...svc.backupSettings({}), dir: tempDir('bplims-runs'), passphrase: PASS, ...over });

describe('a scheduled backup', () => {
  it('is made by the service principal with no one logged in, recorded, audited, and mirrored with a matching sha256', async () => {
    const dir = tempDir('bplims-primary'), mirror = tempDir('bplims-mirror');
    const r = await svc.runBackup({ db, pool, settings: settings({ dir, mirrorDir: mirror }), actorId: principalId, kind: 'scheduled', reason: 'Scheduled: backup.daily' });

    expect(r.verified).toBe(true);
    expect(fs.existsSync(path.join(dir, r.file))).toBe(true);
    expect(r.sha256).toBe(sha256File(path.join(dir, r.file)));
    expect(r.mirror).toMatchObject({ configured: true, ok: true, error: null });
    expect(sha256File(path.join(mirror, r.file))).toBe(r.sha256);

    const run = (await t.db.pool.query('select * from backup_runs where id = $1', [r.runId])).rows[0];
    expect(run).toMatchObject({ kind: 'scheduled', status: 'ok', file_name: r.file, sha256: r.sha256, mirror_ok: true, mirror_sha256: r.sha256, created_by: principalId, verified: true });
    expect(run.schema_version).toMatch(/^\d{4}_/);
    expect(run.audit_head_sequence).toBeGreaterThan(0);

    const audit = (await t.db.pool.query(`select user_id, reason, entity_id from audit_trail where action = 'BACKUP_CREATED' and entity_id = $1`, [r.file])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(principalId);
    expect(audit[0].reason).toBe('Scheduled: backup.daily');
  });

  it('keeps the backup when the mirror is unavailable, records mirror_ok=false, and the status shows a banner', async () => {
    const dir = tempDir('bplims-primary');
    const notADirectory = path.join(tempDir('bplims-x'), 'file');
    fs.writeFileSync(notADirectory, 'a file where the mirror folder should be');
    const r = await svc.runBackup({ db, pool, settings: settings({ dir, mirrorDir: path.join(notADirectory, 'share') }), actorId: principalId, kind: 'scheduled', reason: 'Scheduled: backup.daily' });

    expect(r.verified).toBe(true);
    expect(r.mirror.ok).toBe(false);
    expect(r.mirror.error).toBeTruthy();
    const run = (await t.db.pool.query('select * from backup_runs where id = $1', [r.runId])).rows[0];
    expect(run).toMatchObject({ status: 'ok', mirror_ok: false });
    expect(run.mirror_error).toBeTruthy();
    expect((await t.db.pool.query(`select 1 from audit_trail where action = 'BACKUP_MIRROR_FAILED' and entity_id = $1`, [r.file])).rowCount).toBe(1);

    const status = await svc.backupStatus(db, settings({ dir, mirrorDir: path.join(notADirectory, 'share') }));
    expect(status.mirror).toMatchObject({ configured: true, ok: false });
    expect(status.banners.map((b: any) => b.code)).toContain('MIRROR_FAILED');
  });

  it('with no passphrase configured records a failed run (and says why) instead of silently skipping', async () => {
    await expect(svc.runBackup({ db, pool, settings: settings({ passphrase: null }), actorId: principalId, kind: 'scheduled', reason: 'Scheduled: backup.daily' })).rejects.toThrow(/passphrase/i);
    const run = (await t.db.pool.query(`select * from backup_runs where status = 'failed' order by started_at desc limit 1`)).rows[0];
    expect(run.error).toMatch(/passphrase/i);
    expect(run.file_name).toBeNull();
    expect((await t.db.pool.query(`select 1 from audit_trail where action = 'BACKUP_FAILED' and user_id = $1`, [principalId])).rowCount).toBeGreaterThan(0);
  });

  it('is reported by backupStatus: lastSuccessfulBackupAt, the last run, and no stale-backup banner right after', async () => {
    const s = settings({ mirrorDir: tempDir('bplims-mirror') });
    const r = await svc.runBackup({ db, pool, settings: s, actorId: principalId, kind: 'manual', reason: 'Manual backup' });
    const status = await svc.backupStatus(db, s);
    expect(new Date(status.lastSuccessfulBackupAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(status.lastRun).toMatchObject({ id: r.runId, status: 'ok' });
    expect(status.banners.map((b: any) => b.code)).not.toContain('BACKUP_STALE');
    const later = await svc.backupStatus(db, s, new Date(Date.now() + 3 * 24 * 3600_000));
    expect(later.banners.map((b: any) => b.code)).toContain('BACKUP_STALE');
  });
});

describe('backup_runs and restore_drills are append-only', () => {
  it('refuse UPDATE, DELETE and TRUNCATE at the database', async () => {
    for (const table of ['backup_runs', 'restore_drills']) {
      await t.db.pool.query(`insert into ${table === 'backup_runs'
        ? `backup_runs (id, kind, started_at, finished_at, status, created_by) values ('run-ao', 'manual', now(), now(), 'ok', 'usr-admin')`
        : `restore_drills (id, started_at, finished_at, passed, created_by) values ('drill-ao', now(), now(), true, 'usr-admin')`}`);
      const id = table === 'backup_runs' ? 'run-ao' : 'drill-ao';
      await expect(t.db.pool.query(`update ${table} set finished_at = now() where id = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(t.db.pool.query(`delete from ${table} where id = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(t.db.pool.query(`truncate ${table}`)).rejects.toThrow(/append-only/);
    }
  });
});

describe('retention 7 daily / 4 weekly / 12 monthly', () => {
  const day = (offset: number, hour = 2) => new Date(Date.UTC(2026, 9, 13, hour) - offset * 86_400_000);
  const policy = { daily: 7, weekly: 4, monthly: 12 };
  const names = (list: Array<{ name: string; at: Date }>) => list.map(f => f.name);

  it('keeps the newest backup of each of the last 7 days, 4 weeks and 12 months, and nothing else', () => {
    // two backups a day for 400 days
    const files = Array.from({ length: 800 }, (_, i) => ({ name: `bk-${i}`, at: day(Math.floor(i / 2), i % 2 ? 2 : 14) }));
    const keep = svc.retentionKeep(files, policy);
    // daily: newest of each of the 7 most recent days
    for (let d = 0; d < 7; d++) expect(keep.has(`bk-${d * 2}`), `day ${d}`).toBe(true);
    expect(keep.has('bk-1')).toBe(false);                                   // the older backup of the same day goes
    const months = new Set(files.filter(f => keep.has(f.name)).map(f => f.at.toISOString().slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(12);
    expect(keep.size).toBeLessThanOrEqual(7 + 4 + 12);
    expect(keep.size).toBeGreaterThanOrEqual(15);
    expect(keep.has('bk-799')).toBe(false);                                  // 400 days old
  });

  it('never deletes the only backup, nor the newest one, whatever the policy says', () => {
    const one = [{ name: 'only', at: day(100) }];
    expect([...svc.retentionKeep(one, { daily: 0, weekly: 0, monthly: 0 })]).toEqual(['only']);
    const two = [{ name: 'new', at: day(0) }, { name: 'old', at: day(300) }];
    expect(svc.retentionKeep(two, { daily: 0, weekly: 0, monthly: 0 }).has('new')).toBe(true);
    expect(names(two).length).toBe(2);
  });

  it('applyRetention deletes only scheduled backups that a backup_runs row says this system made, in the primary and the mirror, and audits it; a manual backup stays', async () => {
    const dir = tempDir('bplims-ret'), mirror = tempDir('bplims-ret-mirror');
    const s = settings({ dir, mirrorDir: mirror, retention: { daily: 3, weekly: 0, monthly: 0 } });
    // Twelve runs on twelve different days. Retention reads names and times from backup_runs, not the files' contents.
    const names: string[] = [];
    for (let i = 0; i < 12; i++) {
      const at = new Date(Date.now() - i * 86_400_000);
      const name = `bplims-${at.toISOString().replace(/[:.]/g, '-')}.bak`;
      names.push(name);
      for (const d of [dir, mirror]) fs.writeFileSync(path.join(d, name), `backup ${i}`);
      await t.db.pool.query(`insert into backup_runs (id, kind, started_at, finished_at, status, file_name, created_by) values ($1, 'scheduled', $2, $2, 'ok', $3, 'usr-admin')`, [`run-ret-${process.pid}-${i}`, at, name]);
    }
    const foreign = path.join(dir, 'bplims-2020-01-01T00-00-00-000Z.bak'); // looks like ours, but no run made it
    fs.writeFileSync(foreign, 'hand copied');
    const manual = `bplims-2020-02-02T00-00-00-000Z.bak`;                  // an Administrator's own backup, long outside the rule
    fs.writeFileSync(path.join(dir, manual), 'by hand');
    await t.db.pool.query(`insert into backup_runs (id, kind, started_at, finished_at, status, file_name, created_by) values ($1, 'manual', '2020-02-02', '2020-02-02', 'ok', $2, 'usr-admin')`, [`run-man-${process.pid}`, manual]);
    const noise = path.join(dir, 'notes.txt'); fs.writeFileSync(noise, 'x');

    const out = await svc.applyRetention({ db, settings: s, actorId: principalId, reason: 'Scheduled: backup retention' });
    expect(out.deleted.sort()).toEqual(names.slice(3).sort());
    for (const f of names.slice(0, 3)) { expect(fs.existsSync(path.join(dir, f))).toBe(true); expect(fs.existsSync(path.join(mirror, f))).toBe(true); }
    for (const f of names.slice(3)) { expect(fs.existsSync(path.join(dir, f))).toBe(false); expect(fs.existsSync(path.join(mirror, f))).toBe(false); }
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(path.join(dir, manual))).toBe(true);
    expect(fs.existsSync(noise)).toBe(true);
    const audit = (await t.db.pool.query(`select new_value, user_id, reason from audit_trail where action = 'BACKUP_RETENTION' order by sequence desc limit 1`)).rows[0];
    expect(audit.user_id).toBe(principalId);
    expect(audit.reason).toBe('Scheduled: backup retention');
    for (const f of out.deleted) expect(audit.new_value).toContain(f);
  });
});

describe('the restore drill', () => {
  it('restores the latest backup into a scratch database, compares chain, counts and timestamps, records passed=true and drops the scratch database', async () => {
    const s = settings();
    const r = await svc.runBackup({ db, pool, settings: s, actorId: principalId, kind: 'manual', reason: 'Manual backup' });
    const d = await svc.runDrill({ db, pool, settings: s, actorId: principalId, reason: 'Scheduled: backup.drill' });
    expect(d).toMatchObject({ passed: true, chainIntact: true, countsMatch: true, timestampsMatch: true, hashesMatch: true, file: r.file });

    const row = (await t.db.pool.query('select * from restore_drills where id = $1', [d.drillId])).rows[0];
    expect(row).toMatchObject({ passed: true, chain_intact: true, counts_match: true, timestamps_match: true, backup_file: r.file, backup_sha256: r.sha256, created_by: principalId });
    expect(row.error).toBeNull();
    expect((await t.db.pool.query('select 1 from pg_database where datname = $1', [d.scratchDb])).rowCount).toBe(0);
    expect((await t.db.pool.query(`select 1 from audit_trail where action = 'BACKUP_DRILL' and entity_id = $1`, [d.drillId])).rowCount).toBe(1);

    const status = await svc.backupStatus(db, s);
    expect(status.lastDrill).toMatchObject({ passed: true });
  });

  it('fails with passed=false, and names the frame, when one frame of the backup is corrupt', async () => {
    const s = settings();
    const r = await svc.runBackup({ db, pool, settings: s, actorId: principalId, kind: 'manual', reason: 'Manual backup' });
    const file = path.join(s.dir, r.file);
    const frame = backup.listFrames(file).find(f => f.type === 1)!;
    const fd = fs.openSync(file, 'r+'); const at = frame.offset + 5 + 3; const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, at); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, at); fs.closeSync(fd);

    const d = await svc.runDrill({ db, pool, settings: s, actorId: principalId, reason: 'Scheduled: backup.drill', file: r.file });
    expect(d.passed).toBe(false);
    expect(d.error).toMatch(new RegExp(`frame ${frame.index}\\b`));
    const row = (await t.db.pool.query('select passed, error from restore_drills where id = $1', [d.drillId])).rows[0];
    expect(row.passed).toBe(false);
    expect(row.error).toMatch(new RegExp(`frame ${frame.index}\\b`));
    const status = await svc.backupStatus(db, s);
    expect(status.banners.map((x: any) => x.code)).toContain('DRILL_FAILED');
  });
});
