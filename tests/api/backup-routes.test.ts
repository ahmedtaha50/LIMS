/**
 * Backup HTTP routes (roadmap M14). The OQ-09 behaviours of tests/backup-restore.sh, now checked in-process, plus what v2 adds:
 * status for the UI banner, the passphrase taken from the configured key when none is typed, the drill as a queued job, and
 * a job overview for administrators.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app';
import { TEST_PASSWORD } from '../helpers/db';
import { tempDir } from '../upgrade/helpers';

const PASS = 'a long enough passphrase';
let t: TestApp;
let dir: string;
let mirror: string;

beforeAll(async () => {
  dir = tempDir('bplims-routes');
  mirror = tempDir('bplims-routes-mirror');
  Object.assign(process.env, { BACKUP_DIR: dir, BACKUP_MIRROR_DIR: mirror });
  delete process.env.BACKUP_PASSPHRASE;
  t = await startTestApp();
});

// The auth header is built before the supertest request object exists (see tests/helpers/app.ts).
const backup = async (who: string, body: Record<string, unknown>) => { const h = await t.auth(who); return t.request.post('/api/admin/backup').set(h).send(body); };
const get = async (who: string, url: string) => { const h = await t.auth(who); return t.request.get(url).set(h); };

describe('POST /api/admin/backup', () => {
  it('is for administrators with their password: 401 without a token, 403 for QA, 401 for a wrong password', async () => {
    expect((await t.request.post('/api/admin/backup').send({ password: TEST_PASSWORD, passphrase: PASS })).status).toBe(401);
    expect((await backup('qa@gxp.com', { password: TEST_PASSWORD, passphrase: PASS })).status).toBe(403);
    expect((await backup('admin@gxp.com', { password: 'nope', passphrase: PASS })).status).toBe(401);
  });

  it('rejects a short passphrase and unknown fields with 400 (strict schema)', async () => {
    expect((await backup('admin@gxp.com', { password: TEST_PASSWORD, passphrase: 'short' })).status).toBe(400);
    expect((await backup('admin@gxp.com', { password: TEST_PASSWORD, passphrase: PASS, dir: '/tmp' })).status).toBe(400);
    expect((await backup('admin@gxp.com', { password: TEST_PASSWORD, passphrase: PASS, createdBy: 'usr-qa' })).status).toBe(400);
  });

  it('without a typed passphrase and without a configured one, says what is missing', async () => {
    const res = await backup('admin@gxp.com', { password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/passphrase/i);
  });

  it('creates a verified v2 backup, records the run for the signed-in administrator, audits it, and mirrors it', async () => {
    const res = await backup('admin@gxp.com', { password: TEST_PASSWORD, passphrase: PASS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: true, mirror: { configured: true, ok: true } });
    expect(res.body.file).toMatch(/^bplims-.*\.bak$/);
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.counts.users).toBeGreaterThanOrEqual(5);
    expect(fs.readFileSync(path.join(dir, res.body.file)).subarray(0, 9).toString()).toBe('BPLIMSBK2');
    expect(fs.existsSync(path.join(mirror, res.body.file))).toBe(true);

    const run = (await t.db.pool.query('select * from backup_runs where file_name = $1', [res.body.file])).rows[0];
    expect(run).toMatchObject({ kind: 'manual', status: 'ok', created_by: 'usr-admin', sha256: res.body.sha256 });
    const audit = (await t.db.pool.query(`select user_id, reason from audit_trail where action = 'BACKUP_CREATED' and entity_id = $1`, [res.body.file])).rows;
    expect(audit).toEqual([{ user_id: 'usr-admin', reason: 'Manual backup' }]);
  });

  it('uses the configured passphrase when none is typed', async () => {
    process.env.BACKUP_PASSPHRASE = 'configured passphrase 12345';
    try {
      const res = await backup('admin@gxp.com', { password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      const h = await t.auth('admin@gxp.com');
      const verify = await t.request.post('/api/admin/backup/verify').set(h).send({ password: TEST_PASSWORD, passphrase: 'configured passphrase 12345', file: res.body.file });
      expect(verify.body.ok).toBe(true);
    } finally { delete process.env.BACKUP_PASSPHRASE; }
  });
});

describe('POST /api/admin/backup/verify', () => {
  it('verifies a file in the backup folder, reports a damaged frame by index, and refuses other folders', async () => {
    const made = (await backup('admin@gxp.com', { password: TEST_PASSWORD, passphrase: PASS })).body;
    const call = async (body: Record<string, unknown>) => { const h = await t.auth('admin@gxp.com'); return t.request.post('/api/admin/backup/verify').set(h).send({ password: TEST_PASSWORD, passphrase: PASS, ...body }); };

    const ok = await call({ file: made.file });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, problems: [], corruptFrame: null });

    expect((await call({ file: made.file, passphrase: 'not the passphrase!' })).status).toBe(400);
    expect((await call({ file: '../../../etc/passwd' })).status).toBe(400);
    expect((await call({ file: 'missing.bak' })).status).toBe(400);

    const damaged = path.join(dir, 'damaged.bak');
    fs.copyFileSync(path.join(dir, made.file), damaged);
    const { listFrames } = await import('../../src/server/backup');
    const frame = listFrames(damaged).find(f => f.type === 1)!;
    const fd = fs.openSync(damaged, 'r+'); const b = Buffer.alloc(1); const at = frame.offset + 6;
    fs.readSync(fd, b, 0, 1, at); b[0] ^= 1; fs.writeSync(fd, b, 0, 1, at); fs.closeSync(fd);
    const bad = await call({ file: 'damaged.bak' });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, corruptFrame: frame.index });
  });
});

describe('GET /api/admin/backup/status', () => {
  it('shows the last good backup, the mirror, and banners, to Admin and QA only', async () => {
    expect((await get('analyst1@gxp.com', '/api/admin/backup/status')).status).toBe(403);
    expect((await t.request.get('/api/admin/backup/status')).status).toBe(401);
    for (const who of ['admin@gxp.com', 'qa@gxp.com']) {
      const res = await get(who, '/api/admin/backup/status');
      expect(res.status).toBe(200);
      expect(new Date(res.body.lastSuccessfulBackupAt).getTime()).toBeGreaterThan(Date.now() - 120_000);
      expect(res.body.mirror).toMatchObject({ configured: true, ok: true });
      expect(Array.isArray(res.body.banners)).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/"passphrase"/);
    }
  });
});

describe('POST /api/admin/backup/drill', () => {
  it('queues a restore drill owned by the administrator; it needs the password', async () => {
    const call = async (who: string, body: Record<string, unknown>) => { const h = await t.auth(who); return t.request.post('/api/admin/backup/drill').set(h).send(body); };
    expect((await call('qa@gxp.com', { password: TEST_PASSWORD })).status).toBe(403);
    expect((await call('admin@gxp.com', { password: 'nope' })).status).toBe(401);
    const res = await call('admin@gxp.com', { password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const job = (await t.db.pool.query('select type, created_by, status from jobs where id = $1', [res.body.jobId])).rows[0];
    expect(job).toEqual({ type: 'backup.drill', created_by: 'usr-admin', status: 'pending' });
  });
});

describe('GET /api/admin/jobs', () => {
  it('lists recent jobs and schedules for Admin and QA, without payloads', async () => {
    expect((await get('analyst1@gxp.com', '/api/admin/jobs')).status).toBe(403);
    const res = await get('qa@gxp.com', '/api/admin/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs.some((j: any) => j.type === 'backup.drill')).toBe(true);
    expect(res.body.jobs[0]).not.toHaveProperty('payload');
    expect(Array.isArray(res.body.schedules)).toBe(true);
  });
});
