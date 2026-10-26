/**
 * Roadmap M20 (r2-raw-data) with M14: attachment files are part of the backup, so a backup and restore round-trips them.
 *
 *   - the blob section of a BPLIMSBK2 file: every file the attachment register names (in the backup's snapshot) is written as
 *     authenticated frames of type 3, and the manifest lists each one with its sha256 and size;
 *   - verification decrypts the blob frames and re-hashes every file against the manifest; a damaged blob frame is named;
 *   - restore writes the files into the target blob folder, checked by hash, and checks that every registered file is there;
 *   - a file that is already damaged in the store refuses the backup (a backup never carries a file that does not match its hash).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBackup, listFrames, restoreBackup, verifyBackupFile } from '../../src/server/backup';
import { bootDatabase } from '../../src/server/boot';
import { putBlob } from '../../src/server/blobs';
import { ROOT, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const PASS = 'correct horse battery staple';
const DRIZZLE = path.join(ROOT, 'drizzle');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let src: Scratch;
let dir: string;
let blobs: string;
const files = [Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(3 * 1024 * 1024 + 17)]), Buffer.from('time,abs\n0,0.1\n')];

beforeAll(async () => {
  dir = tempDir('rawdata-backup');
  blobs = tempDir('rawdata-backup-blobs');
  src = await scratchDb('rawdata-bk-src');
  await bootDatabase({ migrate: true, pool: src.pool, dir: DRIZZLE, backup: null });
  await src.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'Analyst')`);
  await src.pool.query(`insert into samples (id, material, batch, state, created_by) values ('S0', 'M', 'B', 'Testing', 'u1')`);
  for (const [i, f] of files.entries()) {
    const stored = await putBlob(fs.createReadStream(writeTemp(f)), { dir: blobs, maxBytes: 50 * 1024 * 1024 });
    expect(stored.sha256).toBe(sha(f));
    await src.pool.query(`insert into attachments (id, sample_id, file_name, media_type, kind, bytes, sha256, uploaded_by) values ($1, 'S0', $2, 'application/pdf', 'pdf', $3, $4, 'u1')`,
      [`att-${i}`, `f${i}.pdf`, f.length, sha(f)]);
  }
  // A second register row for the same content: stored and backed up once.
  await src.pool.query(`insert into attachments (id, sample_id, file_name, media_type, kind, bytes, sha256, uploaded_by) values ('att-dup', 'S0', 'copy.pdf', 'application/pdf', 'pdf', $1, $2, 'u1')`, [files[0].length, sha(files[0])]);
});

function writeTemp(b: Buffer) {
  const p = path.join(dir, `in-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(p, b);
  return p;
}

describe('the blob section', () => {
  it('lists every registered file once and verifies; restore round-trips the files into an empty folder', async () => {
    const made = await createBackup(src.pool, PASS, dir, { frameBytes: 1024 * 1024, blobDir: blobs } as any);
    expect(made.verified, made.problems.join('; ')).toBe(true);
    expect([...made.manifest.blobs!].sort((a, b) => a.sha256.localeCompare(b.sha256)))
      .toEqual(files.map(f => ({ name: sha(f), sha256: sha(f), bytes: f.length })).sort((a, b) => a.sha256.localeCompare(b.sha256)));
    expect(listFrames(made.file).filter(f => f.type === 3).length).toBeGreaterThanOrEqual(5); // 3 MiB in 1 MiB chunks, plus the CSV
    expect(verifyBackupFile(made.file, PASS)).toMatchObject({ ok: true, problems: [] });

    const target = await scratchDb('rawdata-bk-dst');
    const into = tempDir('rawdata-restore-blobs');
    const restored = await restoreBackup(made.file, PASS, target.pool, undefined, { migrationsDir: DRIZZLE, blobDir: into } as any);
    expect(restored.problems).toEqual([]);
    expect(restored).toMatchObject({ countsMatch: true, chainIntact: true, hashesMatch: true });
    expect((restored as any).blobsRestored).toBe(2);
    for (const f of files) expect(sha(fs.readFileSync(path.join(into, sha(f))))).toBe(sha(f));
    expect((await target.pool.query('select count(*)::int as n from attachments')).rows[0].n).toBe(3);
  });

  it('a damaged blob frame fails verification and is named', async () => {
    const made = await createBackup(src.pool, PASS, dir, { blobDir: blobs } as any);
    const blobFrame = listFrames(made.file).find(f => f.type === 3)!;
    const copy = path.join(dir, 'tampered.bak');
    fs.copyFileSync(made.file, copy);
    const fd = fs.openSync(copy, 'r+');
    fs.writeSync(fd, Buffer.from([0x5a]), 0, 1, blobFrame.offset + 40);
    fs.closeSync(fd);
    const v = verifyBackupFile(copy, PASS);
    expect(v.ok).toBe(false);
    expect(v.corruptFrame).toBe(blobFrame.index);
  });

  it('a file already damaged in the store refuses the backup, naming it', async () => {
    const store = tempDir('rawdata-damaged-store');
    for (const f of fs.readdirSync(blobs)) fs.copyFileSync(path.join(blobs, f), path.join(store, f));
    const victim = path.join(store, sha(files[1]));
    fs.chmodSync(victim, 0o644);
    fs.writeFileSync(victim, 'time,abs\n0,9.9\n');
    await expect(createBackup(src.pool, PASS, dir, { blobDir: store } as any)).rejects.toThrow(new RegExp(sha(files[1])));
    fs.rmSync(victim);
    await expect(createBackup(src.pool, PASS, dir, { blobDir: store } as any)).rejects.toThrow(/missing/i);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.part'))).toEqual([]);
  });
});
