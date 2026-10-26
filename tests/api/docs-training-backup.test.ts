/**
 * Roadmap M28 (r2-docs-training), gxpRisk "the documents directory must be included in backup": the files of controlled document
 * versions live in the blob store (BLOB_DIR/<sha256>) and travel in the backup's blob section with the attachment files
 * (src/server/backup-blobs.ts). A restore into an empty database and an empty blob folder gives back the document register, its
 * Effective version (still frozen by its trigger) and the file, checked by hash.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../../src/server/backup';
import { bootDatabase } from '../../src/server/boot';
import { putBlob } from '../../src/server/blobs';
import { ROOT, scratchDb, tempDir, type Scratch } from '../upgrade/helpers';

const PASS = 'correct horse battery staple';
const DRIZZLE = path.join(ROOT, 'drizzle');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sop = Buffer.concat([Buffer.from('%PDF-1.7\n% SOP-QC-001 rev 1\n'), crypto.randomBytes(256 * 1024)]);

let src: Scratch;
let dir: string;
let blobs: string;

beforeAll(async () => {
  dir = tempDir('docs-backup');
  blobs = tempDir('docs-backup-blobs');
  src = await scratchDb('docs-bk-src');
  await bootDatabase({ migrate: true, pool: src.pool, dir: DRIZZLE, backup: null });
  const p = path.join(dir, 'sop.pdf');
  fs.writeFileSync(p, sop);
  expect((await putBlob(fs.createReadStream(p), { dir: blobs, maxBytes: 50 * 1024 * 1024 })).sha256).toBe(sha(sop));
  await src.pool.query(`insert into users (id, uid, name, role) values ('u1', 'u1', 'U One', 'QA')`);
  await src.pool.query(`insert into documents (id, code, title, doc_type, created_by) values ('D1', 'SOP-QC-001', 'Balance', 'SOP', 'u1')`);
  await src.pool.query(`insert into document_versions (id, document_id, revision, title, status, author_id, file_name, media_type, bytes, file_sha256, effective_at)
    values ('V1', 'D1', 1, 'Balance', 'Effective', 'u1', 'sop.pdf', 'application/pdf', $1, $2, now())`, [sop.length, sha(sop)]);
});

describe('the backup of controlled documents', () => {
  it('carries the document files in the blob section and restores them with the register', async () => {
    const made = await createBackup(src.pool, PASS, dir, { blobDir: blobs } as any);
    expect(made.verified, made.problems.join('; ')).toBe(true);
    expect(made.manifest.blobs).toEqual([{ name: sha(sop), sha256: sha(sop), bytes: sop.length }]);

    const target = await scratchDb('docs-bk-dst');
    const into = tempDir('docs-restore-blobs');
    const restored = await restoreBackup(made.file, PASS, target.pool, undefined, { migrationsDir: DRIZZLE, blobDir: into } as any);
    expect(restored.problems).toEqual([]);
    expect(restored).toMatchObject({ countsMatch: true, chainIntact: true });
    expect((restored as any).blobsRestored).toBe(1);
    expect(sha(fs.readFileSync(path.join(into, sha(sop))))).toBe(sha(sop));
    expect((await target.pool.query(`select status, file_sha256 from document_versions where id = 'V1'`)).rows).toEqual([{ status: 'Effective', file_sha256: sha(sop) }]);
    await expect(target.pool.query(`update document_versions set title = 'x' where id = 'V1'`)).rejects.toThrow(/controlled document/);
  });

  it('a document file missing from the store refuses the backup, naming it', async () => {
    fs.chmodSync(path.join(blobs, sha(sop)), 0o644);
    fs.renameSync(path.join(blobs, sha(sop)), path.join(dir, 'moved-away'));
    try {
      await expect(createBackup(src.pool, PASS, dir, { blobDir: blobs } as any)).rejects.toThrow(new RegExp(sha(sop)));
    } finally {
      fs.renameSync(path.join(dir, 'moved-away'), path.join(blobs, sha(sop)));
    }
  });
});
