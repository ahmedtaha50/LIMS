/**
 * The content-addressed blob store (roadmap M20): one file per distinct content, named by its SHA-256, in blobDir().
 *
 *   stageBlob   streams the upload into a temporary file in the store folder, hashing it on the way and stopping at the size limit;
 *               nothing is visible until commit(), and discard() removes the temporary file (a refused upload leaves nothing);
 *   commit      renames the temporary file to <sha256> (atomic on one file system) and makes it read-only; identical content already
 *               stored is kept, and the temporary file dropped;
 *   verifyBlob  re-hashes a stored file: the only answer a reader may act on (a file that is missing or does not match is reported).
 *
 * Files are never deleted by the application: the attachment register is append-only and names them by hash.
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { AppError } from '../http/errors';

const SHA256 = /^[0-9a-f]{64}$/;
const HEAD_BYTES = 8192;

export class BlobTooLargeError extends AppError {
  constructor(limit: number) { super(413, 'ATTACHMENT_TOO_LARGE', `The file is larger than the limit of ${limit} bytes (ATTACHMENT_MAX_BYTES).`); }
}

export function blobPath(dir: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error(`Not a SHA-256 digest: ${sha256}`);
  return path.join(dir, sha256);
}

export interface StagedBlob {
  sha256: string;
  bytes: number;
  /** The first bytes of the file, for type detection. */
  head: Buffer;
  /** Makes the content available as <dir>/<sha256>. */
  commit(): Promise<void>;
  /** Removes the temporary file. Safe to call after commit and more than once. */
  discard(): Promise<void>;
}

export async function stageBlob(input: Readable | AsyncIterable<Buffer>, opts: { dir: string; maxBytes: number }): Promise<StagedBlob> {
  await fs.promises.mkdir(opts.dir, { recursive: true, mode: 0o700 });
  const temp = path.join(opts.dir, `upload-${randomBytes(8).toString('hex')}.part`);
  const fh = await fs.promises.open(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  const heads: Buffer[] = [];
  let headLength = 0;
  let bytes = 0;
  let closed = false;
  const discard = async () => {
    if (!closed) { closed = true; await fh.close().catch(() => undefined); }
    await fs.promises.rm(temp, { force: true });
  };
  try {
    for await (const chunk of input as AsyncIterable<Buffer | string>) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += b.length;
      if (bytes > opts.maxBytes) throw new BlobTooLargeError(opts.maxBytes);
      hash.update(b);
      if (headLength < HEAD_BYTES) { const part = b.subarray(0, HEAD_BYTES - headLength); heads.push(part); headLength += part.length; }
      await fh.write(b);
    }
    await fh.sync();
    await fh.close();
    closed = true;
  } catch (e) {
    await discard();
    throw e;
  }
  const sha256 = hash.digest('hex');
  return {
    sha256, bytes, head: Buffer.concat(heads),
    discard,
    async commit() {
      const final = blobPath(opts.dir, sha256);
      const existing = await verifyBlob(opts.dir, sha256);
      if (existing.ok) { await discard(); return; }
      // Missing, or present but damaged: the verified upload takes its place (rename replaces atomically).
      await fs.promises.chmod(temp, 0o444);
      await fs.promises.rename(temp, final);
    },
  };
}

/** Stages and commits in one call (for tools and tests that already know the content is acceptable). */
export async function putBlob(input: Readable | AsyncIterable<Buffer>, opts: { dir: string; maxBytes: number }): Promise<{ sha256: string; bytes: number }> {
  const staged = await stageBlob(input, opts);
  await staged.commit();
  return { sha256: staged.sha256, bytes: staged.bytes };
}

export type BlobCheck = { ok: true; bytes: number } | { ok: false; problem: 'missing' | 'mismatch'; actual?: string; bytes?: number };

/** Re-reads and re-hashes the stored file. */
export async function verifyBlob(dir: string, sha256: string): Promise<BlobCheck> {
  const file = blobPath(dir, sha256);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) { hash.update(chunk); bytes += chunk.length; }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, problem: 'missing' };
    throw e;
  }
  const actual = hash.digest('hex');
  return actual === sha256 ? { ok: true, bytes } : { ok: false, problem: 'mismatch', actual, bytes };
}

export const openBlob = (dir: string, sha256: string): fs.ReadStream => fs.createReadStream(blobPath(dir, sha256));
