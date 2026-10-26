/**
 * The blob section of a backup (roadmap M20 with M14): the raw-data files of the attachment register and the files of controlled
 * document versions (M28) travel inside the encrypted BPLIMSBK2 file, after the table frames and before the footer, so a backup and
 * its restore carry the files with the records.
 *
 *   frame type 3   plaintext = header length (2 bytes) | header JSON {"s": sha256, "n": chunk number, "last": true|false} | bytes
 *                  One file is a run of chunks (at most frameBytes each) in order; files are in sha256 order, each once, however many
 *                  register rows name it. Every frame is sealed like the others (AES-256-GCM, frame index and type in the AAD).
 *   manifest       `blobs`: [{ name, sha256, bytes }] for every file written.
 *
 * Writing (writeBlobSection) reads the register inside the backup's snapshot, so the files are exactly those the backed-up rows name,
 * and re-hashes each file while it is written: a file that is missing or does not match its name refuses the backup (a backup never
 * carries a file that does not match its hash; the failed run is recorded and raises a deviation like any failed backup).
 * Verification (BlobSectionCheck) re-hashes every file from the frames and compares it with the manifest. Restore (BlobRestorer) writes
 * the files into the target blob store, each checked before it becomes visible, and checkRestoredBlobs confirms that every registered
 * file is in the store. src/server/backup.ts calls these four; this file knows nothing else of the format.
 */
import { createHash, randomBytes, type Hash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type pg from 'pg';
import { blobPath, verifyBlob } from './blobs';

export const FRAME_BLOB = 3;

export interface BlobEntry { name: string; sha256: string; bytes: number }

interface ChunkHeader { s: string; n: number; last: boolean }

function encode(header: ChunkHeader, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(2); len.writeUInt16BE(h.length, 0);
  return Buffer.concat([len, h, data]);
}

export function decodeBlobFrame(plain: Buffer): { sha256: string; chunk: number; last: boolean; data: Buffer } {
  const len = plain.readUInt16BE(0);
  const header = JSON.parse(plain.subarray(2, 2 + len).toString('utf8')) as ChunkHeader;
  if (!/^[0-9a-f]{64}$/.test(header.s) || !Number.isInteger(header.n) || typeof header.last !== 'boolean') throw new Error('malformed blob frame header');
  return { sha256: header.s, chunk: header.n, last: header.last, data: plain.subarray(2 + len) };
}

/** The tables that name files of the blob store: the attachment register (0120) and controlled document versions (0200, M28). */
const BLOB_REGISTERS = [
  { table: 'attachments', select: 'select sha256, bytes from attachments' },
  { table: 'instrument_files', select: 'select sha256, bytes from instrument_files' },
  { table: 'document_versions', select: 'select file_sha256 as sha256, bytes from document_versions where file_sha256 is not null' },
];

/** The files the registers name, as the backup's snapshot sees it, each once. None before migration 0120. */
async function registeredBlobs(c: pg.ClientBase): Promise<Array<{ sha256: string; bytes: number }>> {
  const present: string[] = [];
  for (const r of BLOB_REGISTERS) if ((await c.query('select to_regclass($1) as t', [`public.${r.table}`])).rows[0].t) present.push(r.select);
  if (present.length === 0) return [];
  const { rows } = await c.query(`select sha256, max(bytes)::text as bytes from (${present.join(' union all ')}) f group by sha256 order by sha256`);
  return rows.map(r => ({ sha256: r.sha256 as string, bytes: Number(r.bytes) }));
}

/**
 * Writes every registered file as blob frames through `seal` (which assigns the frame index). Runs inside the backup's snapshot
 * transaction on `c`. Throws, naming the file, when a file is missing or does not match its sha256 or registered size.
 */
export async function writeBlobSection(c: pg.ClientBase, opts: { dir: string; chunkBytes: number; seal: (plain: Buffer) => Promise<void> }): Promise<BlobEntry[]> {
  const out: BlobEntry[] = [];
  for (const blob of await registeredBlobs(c)) {
    const file = blobPath(opts.dir, blob.sha256);
    const hash = createHash('sha256');
    let bytes = 0, chunk = 0;
    let pending: Buffer[] = [], pendingBytes = 0;
    const emit = async (last: boolean) => {
      const data = Buffer.concat(pending, pendingBytes);
      await opts.seal(encode({ s: blob.sha256, n: chunk++, last }, data));
      pending = []; pendingBytes = 0;
    };
    try {
      for await (const part of fs.createReadStream(file, { highWaterMark: Math.min(opts.chunkBytes, 1024 * 1024) }) as AsyncIterable<Buffer>) {
        let rest = part;
        while (rest.length > 0) {
          const take = rest.subarray(0, opts.chunkBytes - pendingBytes);
          pending.push(take); pendingBytes += take.length; rest = rest.subarray(take.length);
          hash.update(take); bytes += take.length;
          if (pendingBytes === opts.chunkBytes) await emit(false);
        }
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw new Error(`Attachment file ${blob.sha256} is missing from the blob store (${opts.dir}); the backup was not made. Restore the file, then back up again.`);
      throw e;
    }
    const actual = hash.digest('hex');
    if (actual !== blob.sha256 || bytes !== blob.bytes) {
      throw new Error(`Attachment file ${blob.sha256} in the blob store is damaged (it hashes to ${actual}, ${bytes} bytes; registered ${blob.bytes} bytes); the backup was not made.`);
    }
    await emit(true); // the last chunk (possibly empty when the size is a multiple of the chunk size)
    out.push({ name: blob.sha256, sha256: blob.sha256, bytes });
  }
  return out;
}

/** Re-hashes the files of the blob frames, in order, and compares them with the manifest. */
export class BlobSectionCheck {
  private readonly problems: string[] = [];
  private current: { sha256: string; next: number; hash: Hash; bytes: number } | null = null;
  private readonly seen = new Map<string, number>();
  constructor(private readonly expected: BlobEntry[]) {}

  frame(plain: Buffer) {
    let f: ReturnType<typeof decodeBlobFrame>;
    try { f = decodeBlobFrame(plain); } catch (e: any) { this.problems.push(`blob frame unreadable: ${e.message}`); return; }
    if (this.current && this.current.sha256 !== f.sha256) { this.problems.push(`attachment file ${this.current.sha256} is incomplete in the backup`); this.current = null; }
    if (!this.current) {
      if (f.chunk !== 0) { this.problems.push(`attachment file ${f.sha256} starts at chunk ${f.chunk}`); return; }
      this.current = { sha256: f.sha256, next: 0, hash: createHash('sha256'), bytes: 0 };
    }
    const cur = this.current;
    if (f.chunk !== cur.next) { this.problems.push(`attachment file ${f.sha256}: chunk ${f.chunk} where ${cur.next} was expected`); this.current = null; return; }
    cur.next++; cur.hash.update(f.data); cur.bytes += f.data.length;
    if (f.last) {
      const actual = cur.hash.digest('hex');
      if (actual !== cur.sha256) this.problems.push(`attachment file ${cur.sha256} in the backup hashes to ${actual}`);
      if (this.seen.has(cur.sha256)) this.problems.push(`attachment file ${cur.sha256} appears twice in the backup`);
      this.seen.set(cur.sha256, cur.bytes);
      this.current = null;
    }
  }

  finish(): string[] {
    if (this.current) this.problems.push(`attachment file ${this.current.sha256} is incomplete in the backup`);
    const want = new Map(this.expected.map(b => [b.sha256, b.bytes]));
    for (const [sha, bytes] of want) {
      if (!this.seen.has(sha)) this.problems.push(`attachment file ${sha} is in the manifest but not in the backup`);
      else if (this.seen.get(sha) !== bytes) this.problems.push(`attachment file ${sha}: ${this.seen.get(sha)} bytes, the manifest says ${bytes}`);
    }
    for (const sha of this.seen.keys()) if (!want.has(sha)) this.problems.push(`attachment file ${sha} is in the backup but not in the manifest`);
    return this.problems;
  }
}

/** Writes the files of the blob frames into a blob store; each becomes <sha256> only once its content has been checked. */
export class BlobRestorer {
  private current: { sha256: string; temp: string; fh: fs.promises.FileHandle; hash: Hash } | null = null;
  private restored = 0;
  private readonly problems: string[] = [];
  constructor(private readonly dir: string) {}

  async frame(plain: Buffer) {
    const f = decodeBlobFrame(plain); // the file was verified before the restore began
    if (!this.current) {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = path.join(this.dir, `restore-${randomBytes(8).toString('hex')}.part`);
      this.current = { sha256: f.sha256, temp, fh: await fs.promises.open(temp, 'wx', 0o600), hash: createHash('sha256') };
    }
    const cur = this.current;
    await cur.fh.write(f.data);
    cur.hash.update(f.data);
    if (!f.last) return;
    await cur.fh.sync(); await cur.fh.close();
    this.current = null;
    if (cur.hash.digest('hex') !== cur.sha256) { await fs.promises.rm(cur.temp, { force: true }); this.problems.push(`attachment file ${cur.sha256} did not restore intact`); return; }
    if ((await verifyBlob(this.dir, cur.sha256)).ok) { await fs.promises.rm(cur.temp, { force: true }); this.restored++; return; }
    await fs.promises.chmod(cur.temp, 0o444);
    await fs.promises.rename(cur.temp, blobPath(this.dir, cur.sha256));
    this.restored++;
  }

  async finish(): Promise<{ restored: number; problems: string[] }> {
    if (this.current) {
      await this.current.fh.close().catch(() => undefined);
      await fs.promises.rm(this.current.temp, { force: true });
      this.problems.push(`attachment file ${this.current.sha256} was cut off in the backup`);
      this.current = null;
    }
    return { restored: this.restored, problems: this.problems };
  }
}

/** Every file the restored register names must be in the store and match its hash. */
export async function checkRestoredBlobs(c: pg.ClientBase, dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const blob of await registeredBlobs(c)) {
    const check = await verifyBlob(dir, blob.sha256);
    if (!check.ok) problems.push(`attachment file ${blob.sha256} is ${check.problem === 'missing' ? 'missing from' : 'damaged in'} the restored blob store`);
  }
  return problems;
}
