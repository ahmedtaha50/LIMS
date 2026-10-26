/**
 * Encrypted, verifiable logical backup of all GxP data (URS-050), format BPLIMSBK2 (roadmap M14).
 *
 *  - One REPEATABLE READ snapshot: table contents, row counts and the audit head describe the same instant.
 *  - Streamed: tables are read in keyset batches and written as frames, so memory is bounded by one frame and one batch,
 *    not by the database (v1 built the whole database as one JSON string and failed near 512 MB).
 *  - Text-exact: every value is exported as the text PostgreSQL stores (timestamps with their microseconds, in a UTC session),
 *    never through a JavaScript Date. A restore inserts the same text, so a restored row is byte-identical to the source row.
 *  - Authenticated frames: AES-256-GCM, key = scrypt(passphrase, random salt), counter IVs, and the frame index and type in the
 *    authenticated data. A flipped bit, a dropped, swapped, repeated or appended frame fails verification and names the frame.
 *  - The manifest sits in the footer: schema version, per-table row counts and SHA-256, the audit head, the blob section (every
 *    attachment file, roadmap M20: ./backup-blobs.ts), the plaintext stream hash of the table frames.
 *  - verify: decrypt every frame, re-check counts, hashes and the audit hash chain, without loading the file.
 *  - restore: into an EMPTY database only (never overwrites), then re-installs the immutability triggers and checks the
 *    restored database against the manifest (counts, chain, per-table hashes, timestamp columns).
 *  - A v1 file (BPLIMSBK1) is still read.
 *
 * File layout (all integers big-endian):
 *   header   "BPLIMSBK2" | kdf (1: scrypt N=16384 r=8 p=1) | salt (16) | iv prefix (4)
 *   frame    type (1: data, 2: footer, 3: blob) | length (4) | ciphertext (length) | GCM tag (16)
 *              IV  = iv prefix | frame index (8)            AAD = "BPLIMSBK2" | type | frame index (8)
 *              data plaintext   = gzip(NDJSON): a line {"t":table,"c":[columns]} then one JSON array of values per row
 *                                 (every value a string or null), the header line repeated at the start of each frame
 *              blob plaintext   = one chunk of an attachment file (./backup-blobs.ts), after the data frames
 *              footer plaintext = the manifest as JSON
 *   trailer  footer offset (8) | footer frame index (8) | "BPLIMSE2"
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import pg from 'pg';
import { protectionStatements } from '../db/protections';
import { verifyAuditRows } from './audit/chain';
import { checkRow, nextTail, normalizeAuditRow, type ChainTail } from './audit/hash';
import { BlobRestorer, BlobSectionCheck, FRAME_BLOB, checkRestoredBlobs, writeBlobSection } from './backup-blobs';
import { blobDir } from './blobs';
import { buildSchemaSql } from './boot/schemaSql';
import { appVersion } from './boot/version';
import { loadMigrations } from './migrate';
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv, type Hash } from 'crypto';

const gzip = promisify(zlib.gzip);
const MAGIC1 = Buffer.from('BPLIMSBK1');
const MAGIC2 = Buffer.from('BPLIMSBK2');
const END_MAGIC = Buffer.from('BPLIMSE2');
const HEADER_BYTES = MAGIC2.length + 1 + 16 + 4; // magic, kdf, salt, iv prefix
const TRAILER_BYTES = 8 + 8 + END_MAGIC.length;
const FRAME_DATA = 1;
const FRAME_FOOTER = 2;
const TAG_BYTES = 16;
const DEFAULT_FRAME_BYTES = 1024 * 1024;
const BATCH_TARGET_BYTES = 4 * 1024 * 1024;
const TIMESTAMP_TYPES = new Set(['timestamp without time zone', 'timestamp with time zone', 'date', 'time without time zone', 'time with time zone']);
/** Every column comes back as the text PostgreSQL printed: no JavaScript Date, no float rounding, no JSON re-ordering. */
const TEXT_TYPES = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;
/** Session settings that make the text form of a value the same on every machine. */
const CANONICAL_SESSION = ["SET LOCAL TIME ZONE 'UTC'", "SET LOCAL DateStyle = 'ISO, YMD'", "SET LOCAL IntervalStyle = 'postgres'", 'SET LOCAL extra_float_digits = 1', "SET LOCAL bytea_output = 'hex'"];

export interface TableManifest {
  rows: number;
  /** SHA-256 over the row lines of the table, in primary-key order. */
  sha256: string;
  /** Columns of a date or time type, and a hash of just their values (so a timestamp can be compared on its own). */
  tsColumns: string[];
  tsSha256: string;
}

export interface BackupManifest {
  format: 1 | 2;
  createdAt: string;
  auditHead: { sequence: number; hash: string | null };
  counts: Record<string, number>;
  /** v1 only: SHA-256 of the JSON of all tables. */
  dataHash?: string;
  /** v2 */
  schemaVersion?: string | null;
  appVersion?: string;
  tableOrder?: string[];
  tables?: Record<string, TableManifest>;
  /** Attachment files (roadmap M20), each once: name = sha256. Carried by frames of type 3 (./backup-blobs.ts). */
  blobs?: Array<{ name: string; sha256: string; bytes: number }>;
  frames?: number;
  plainBytes?: number;
  streamSha256?: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest: BackupManifest;
  /** Index of the first frame that failed authentication, if one did; the file itself is damaged. */
  corruptFrame: number | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Audit chain check over rows in memory, kept for callers that read the whole table (tests, small tools). */
export function verifyAuditChain(rows: any[]): { isValid: boolean; compromisedSequence: number | null } {
  const { isValid, compromisedSequence } = verifyAuditRows(rows);
  return { isValid, compromisedSequence };
}

// ---- reading the database --------------------------------------------------------------------------------------------

async function tableOrder(c: pg.ClientBase): Promise<string[]> {
  const t = await c.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`);
  const names: string[] = t.rows.map(r => r.table_name);
  const fk = await c.query(`select cl.relname as child, pr.relname as parent from pg_constraint k join pg_class cl on cl.oid=k.conrelid join pg_class pr on pr.oid=k.confrelid join pg_namespace n on n.oid=cl.relnamespace where k.contype='f' and n.nspname='public'`);
  const deps = new Map(names.map(n => [n, new Set<string>()]));
  fk.rows.forEach(r => { if (r.child !== r.parent && deps.has(r.child)) deps.get(r.child)!.add(r.parent); });
  const out: string[] = [];
  while (out.length < names.length) {
    const ready = names.filter(n => !out.includes(n) && [...deps.get(n)!].every(d => out.includes(d)));
    if (!ready.length) throw new Error('Cyclic foreign keys; cannot order tables');
    out.push(...ready.sort());
  }
  return out;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function schemaVersionOf(c: pg.ClientBase): Promise<string | null> {
  const has = await c.query(`select to_regclass('public.schema_migrations') as t`);
  if (!has.rows[0].t) return null;
  const r = await c.query('select id from schema_migrations order by id desc limit 1');
  return r.rows[0]?.id ?? null;
}

/** `pk` is the key the table is read in: its primary key, or for the hash-chained tables the sequence, so that rows come in chain order. */
interface TableInfo { name: string; columns: string[]; tsColumns: string[]; pk: string[] }

/** Tables whose rows must be read in the order of their chain, not of their (random) primary key. `sequence` is unique and not null. */
const READ_ORDER: Record<string, string[]> = { audit_trail: ['sequence'], security_events: ['sequence'] };

async function describeTable(c: pg.ClientBase, name: string): Promise<TableInfo> {
  const cols = await c.query(`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`, [name]);
  const columns = cols.rows.map(r => r.column_name as string).sort();
  const tsColumns = cols.rows.filter(r => TIMESTAMP_TYPES.has(r.data_type)).map(r => r.column_name as string).sort();
  const pk = await c.query(
    `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey::int2[])
     where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [ident(name)]);
  return { name, columns, tsColumns, pk: READ_ORDER[name] ?? pk.rows.map(r => r.name as string) };
}

type Row = Array<string | null>;

/**
 * Reads one table in keyset batches ordered by its primary key (by ctid for a table without one). The batch size adapts to the
 * size of the rows, so a table of megabyte-sized attachment rows is read a few rows at a time.
 */
async function* readTable(c: pg.ClientBase, t: TableInfo): AsyncGenerator<Row[]> {
  const select = t.columns.map(ident).join(', ');
  const order = t.pk.length ? t.pk.map(ident) : ['ctid'];
  const keyCols = t.pk.length ? t.pk.map(ident) : ['ctid'];
  const keyOut = t.pk.length ? '' : ', ctid::text as "__key"';
  let after: string[] | null = null;
  let limit = 5; // small first: the rows may be megabytes each. It grows with what the rows turn out to weigh
  for (;;) {
    const where = after ? `where (${keyCols.join(', ')}) > (${after.map((_, i) => `$${i + 1}${t.pk.length ? '' : '::tid'}`).join(', ')})` : '';
    const res: pg.QueryArrayResult = await c.query({
      text: `select ${select}${keyOut} from ${ident(t.name)} ${where} order by ${order.join(', ')} limit ${limit}`,
      values: after ?? [], rowMode: 'array', types: TEXT_TYPES,
    });
    if (res.rows.length === 0) return;
    const rows = res.rows as Row[];
    const last = rows[rows.length - 1];
    after = t.pk.length ? t.pk.map(k => last[t.columns.indexOf(k)] as string) : [last[t.columns.length] as string];
    let bytes = 0;
    for (const r of rows) { for (const v of r) bytes += v === null ? 4 : v.length + 3; }
    yield t.pk.length ? rows : rows.map(r => r.slice(0, t.columns.length));
    if (rows.length < limit) return;
    limit = Math.max(1, Math.min(2000, limit * 4, Math.floor(BATCH_TARGET_BYTES / Math.max(1, bytes / rows.length))));
  }
}

type ExportEvent =
  | { kind: 'table'; table: TableInfo }
  | { kind: 'rows'; table: TableInfo; rows: Row[] };

/** Runs inside a REPEATABLE READ READ ONLY transaction that the caller has opened and set to the canonical session. */
async function exportTables(c: pg.ClientBase, tables: string[], on: (e: ExportEvent) => Promise<void>) {
  for (const name of tables) {
    const table = await describeTable(c, name);
    await on({ kind: 'table', table });
    for await (const rows of readTable(c, table)) await on({ kind: 'rows', table, rows });
  }
}

async function openSnapshot(c: pg.ClientBase) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for (const s of CANONICAL_SESSION) await c.query(s);
}

/** Per-table counting and hashing, the same code for the backup and for the check of a restored database. */
class TableDigest {
  rows = 0;
  private readonly all = createHash('sha256');
  private readonly ts = createHash('sha256');
  private readonly tsIndex: number[];
  constructor(readonly table: TableInfo) { this.tsIndex = table.tsColumns.map(c => table.columns.indexOf(c)); }
  add(line: string, row: Row) {
    this.rows++;
    this.all.update(line);
    if (this.tsIndex.length) this.ts.update(JSON.stringify(this.tsIndex.map(i => row[i])) + '\n');
  }
  finish(): TableManifest { return { rows: this.rows, sha256: this.all.digest('hex'), tsColumns: this.table.tsColumns, tsSha256: this.ts.digest('hex') }; }
}

// ---- writing ---------------------------------------------------------------------------------------------------------

const ivFor = (prefix: Buffer, index: number) => { const iv = Buffer.alloc(12); prefix.copy(iv); iv.writeBigUInt64BE(BigInt(index), 4); return iv; };
const aadFor = (type: number, index: number) => { const a = Buffer.alloc(MAGIC2.length + 1 + 8); MAGIC2.copy(a); a[MAGIC2.length] = type; a.writeBigUInt64BE(BigInt(index), MAGIC2.length + 1); return a; };

function sealFrame(key: Buffer, ivPrefix: Buffer, type: number, index: number, plain: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, ivFor(ivPrefix, index));
  c.setAAD(aadFor(type, index));
  const body = Buffer.concat([c.update(plain), c.final()]);
  const head = Buffer.alloc(5); head[0] = type; head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

export interface CreateBackupOptions {
  /** Plaintext bytes per frame (default 1 MiB). Smaller frames localise damage better and cost a little more space. */
  frameBytes?: number;
  /** The blob store the attachment files are read from (default: blobDir(), BLOB_DIR). */
  blobDir?: string;
}

export async function createBackup(pool: pg.Pool, passphrase: string, dir: string, options: CreateBackupOptions = {}) {
  if (passphrase.length < 12) throw new Error('Backup passphrase must be at least 12 characters');
  const frameBytes = options.frameBytes ?? DEFAULT_FRAME_BYTES;
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const name = `bplims-${createdAt.replace(/[:.]/g, '-')}.bak`;
  const full = path.join(dir, name);
  const part = `${full}.part`;
  if (fs.existsSync(full)) throw new Error(`Backup file ${name} already exists`);

  const salt = randomBytes(16), ivPrefix = randomBytes(4);
  const key = scryptSync(passphrase, salt, 32);
  const c = await pool.connect();
  let fh: fs.promises.FileHandle | null = null;
  let finished = false;
  try {
    fh = await fs.promises.open(part, 'wx', 0o600);
    const fileHash = createHash('sha256');
    let written = 0;
    const put = async (b: Buffer) => { await fh!.write(b, 0, b.length, written); written += b.length; fileHash.update(b); };
    const streamHash = createHash('sha256');
    let plainBytes = 0;
    let frameIndex = 0;
    let lines: string[] = [];
    let lineBytes = 0;
    let current: TableInfo | null = null;
    const headerLine = (t: TableInfo) => JSON.stringify({ t: t.name, c: t.columns }) + '\n';

    const flush = async () => {
      if (lines.length === 0) return;
      const plain = Buffer.from(lines.join(''), 'utf8');
      streamHash.update(plain);
      plainBytes += plain.length;
      await put(sealFrame(key, ivPrefix, FRAME_DATA, frameIndex++, await gzip(plain)));
      lines = []; lineBytes = 0;
    };
    const push = async (line: string) => {
      if (lines.length === 0 && current) { const h = headerLine(current); lines.push(h); lineBytes += h.length; } // each frame stands on its own
      lines.push(line); lineBytes += line.length;
      if (lineBytes >= frameBytes) await flush();
    };

    const header = Buffer.concat([MAGIC2, Buffer.from([1]), salt, ivPrefix]);
    await put(header);

    await openSnapshot(c);
    const order = await tableOrder(c);
    const schemaVersion = await schemaVersionOf(c);
    const tables: Record<string, TableManifest> = {};
    const counts: Record<string, number> = {};
    const open = { digest: null as TableDigest | null };
    const closeTable = () => {
      if (!open.digest) return;
      tables[open.digest.table.name] = open.digest.finish(); counts[open.digest.table.name] = open.digest.rows;
      open.digest = null;
    };
    await exportTables(c, order, async (e) => {
      if (e.kind === 'table') {
        closeTable();
        current = e.table; open.digest = new TableDigest(e.table);
        const h = headerLine(e.table); // a table without rows still gets its header, so the reader knows the table exists
        lines.push(h); lineBytes += h.length;
        return;
      }
      for (const row of e.rows) { const line = JSON.stringify(row) + '\n'; open.digest!.add(line, row); await push(line); }
    });
    closeTable();
    await flush();
    // The files the backed-up register names, read in the same snapshot; a missing or damaged file refuses the backup.
    const blobs = await writeBlobSection(c, {
      dir: options.blobDir ?? blobDir(), chunkBytes: frameBytes,
      seal: async (plain) => { await put(sealFrame(key, ivPrefix, FRAME_BLOB, frameIndex++, plain)); },
    });
    const head = await c.query('select sequence, hash from audit_trail order by sequence desc limit 1');
    await c.query('COMMIT');

    const manifest: BackupManifest = {
      format: 2, createdAt, schemaVersion, appVersion: appVersion(), tableOrder: order, tables, counts,
      auditHead: { sequence: head.rows[0]?.sequence ?? 0, hash: head.rows[0]?.hash ?? null },
      blobs, frames: frameIndex, plainBytes, streamSha256: streamHash.digest('hex'),
    };
    const footerOffset = written;
    await put(sealFrame(key, ivPrefix, FRAME_FOOTER, frameIndex, Buffer.from(JSON.stringify(manifest), 'utf8')));
    const trailer = Buffer.alloc(TRAILER_BYTES);
    trailer.writeBigUInt64BE(BigInt(footerOffset), 0); trailer.writeBigUInt64BE(BigInt(frameIndex), 8); END_MAGIC.copy(trailer, 16);
    await put(trailer);
    await fh.sync();
    await fh.close(); fh = null;

    // Re-read the file from disk and verify it before it becomes "the backup". A file that cannot be read back is not kept.
    let verification: VerifyResult;
    try { verification = await verifyBackup(part, passphrase); } catch (e: any) { throw new Error(`The backup file could not be read back: ${e.message}`); }
    if (verification.corruptFrame !== null) throw new Error(`The backup file is damaged on disk: ${verification.problems.join('; ')}`);
    fs.renameSync(part, full);
    finished = true;
    return { file: full, name, bytes: written, sha256: fileHash.digest('hex'), manifest, verified: verification.ok, problems: verification.problems };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* no transaction open */ }
    throw e;
  } finally {
    c.release();
    if (fh) await fh.close().catch(() => undefined);
    if (!finished) fs.rmSync(part, { force: true });
  }
}

// ---- reading a file --------------------------------------------------------------------------------------------------

interface Header { key: Buffer; ivPrefix: Buffer }
export interface FrameInfo { index: number; type: number; offset: number; length: number }

const DAMAGED = 'Cannot decrypt backup: wrong passphrase or file damaged';
const INCOMPLETE = 'Backup file is incomplete or damaged (end marker missing)';

function keyFor(headBytes: Buffer, passphrase: string): Header {
  if (!headBytes.subarray(0, MAGIC2.length).equals(MAGIC2)) throw new Error('Not a B-Pharma LIMS backup file');
  if (headBytes[MAGIC2.length] !== 1) throw new Error('Unsupported backup key derivation');
  const salt = headBytes.subarray(MAGIC2.length + 1, MAGIC2.length + 17);
  return { key: scryptSync(passphrase, salt, 32), ivPrefix: Buffer.from(headBytes.subarray(MAGIC2.length + 17, HEADER_BYTES)) };
}

function openFrame(h: Header, type: number, index: number, body: Buffer, tag: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', h.key, ivFor(h.ivPrefix, index));
  d.setAAD(aadFor(type, index)); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

/** Random access to a file, synchronous (CLI, tests) or asynchronous (server): the same layout, read two ways. */
interface SyncSource { size: number; read(offset: number, length: number): Buffer; close(): void }
interface AsyncSource { size: number; read(offset: number, length: number): Promise<Buffer>; close(): Promise<void> }
const syncSource = (file: string): SyncSource => {
  const fd = fs.openSync(file, 'r');
  return { size: fs.fstatSync(fd).size, close: () => fs.closeSync(fd), read: (o, l) => { const b = Buffer.alloc(l); const n = fs.readSync(fd, b, 0, l, o); if (n !== l) throw new Error(INCOMPLETE); return b; } };
};
const asyncSource = async (file: string): Promise<AsyncSource> => {
  const fh = await fs.promises.open(file, 'r');
  const size = (await fh.stat()).size;
  return { size, close: () => fh.close(), read: async (o, l) => { const b = Buffer.alloc(l); const { bytesRead } = await fh.read(b, 0, l, o); if (bytesRead !== l) throw new Error(INCOMPLETE); return b; } };
};

/** Layout of a v2 file, read from its last bytes. */
function parseTrailer(size: number, trailer: Buffer): { footerOffset: number; footerIndex: number } {
  if (size < HEADER_BYTES + TRAILER_BYTES || !trailer.subarray(16).equals(END_MAGIC)) throw new Error(INCOMPLETE);
  const footerOffset = Number(trailer.readBigUInt64BE(0)), footerIndex = Number(trailer.readBigUInt64BE(8));
  if (footerOffset < HEADER_BYTES || footerOffset > size - TRAILER_BYTES) throw new Error(INCOMPLETE);
  return { footerOffset, footerIndex };
}

function decodeManifest(h: Header, footerIndex: number, frame: Buffer): BackupManifest {
  if (frame[0] !== FRAME_FOOTER || frame.length < 5 + TAG_BYTES) throw new Error(DAMAGED);
  const len = frame.readUInt32BE(1);
  if (frame.length !== 5 + len + TAG_BYTES) throw new Error(INCOMPLETE);
  try { return JSON.parse(openFrame(h, FRAME_FOOTER, footerIndex, frame.subarray(5, 5 + len), frame.subarray(5 + len)).toString('utf8')); }
  catch { throw new Error(DAMAGED); }
}

/** Frame by frame, up to the footer. `next` reads one frame; it returns null at the footer. */
function framePlan(footerOffset: number) {
  let pos = HEADER_BYTES, index = 0;
  return {
    get done() { return pos >= footerOffset; },
    take(head: Buffer) { // head: the 5 bytes at pos
      const len = head.readUInt32BE(1);
      const frame = { index, type: head[0], offset: pos, length: 5 + len + TAG_BYTES };
      if (frame.offset + frame.length > footerOffset) throw new Error(INCOMPLETE);
      pos += frame.length; index++;
      return frame;
    },
    get pos() { return pos; },
  };
}

/** The frames of a v2 file with their positions (no decryption): for diagnostics and for tests that damage a frame. */
export function listFrames(file: string): FrameInfo[] {
  const s = syncSource(file);
  try {
    if (!s.read(0, MAGIC2.length).equals(MAGIC2)) throw new Error('Not a B-Pharma LIMS backup file (version 2)');
    const { footerOffset, footerIndex } = parseTrailer(s.size, s.read(s.size - TRAILER_BYTES, TRAILER_BYTES));
    const plan = framePlan(footerOffset);
    const out: FrameInfo[] = [];
    while (!plan.done) out.push(plan.take(s.read(plan.pos, 5)));
    const len = s.read(footerOffset, 5).readUInt32BE(1);
    out.push({ index: footerIndex, type: FRAME_FOOTER, offset: footerOffset, length: 5 + len + TAG_BYTES });
    return out;
  } finally { s.close(); }
}

/** Reads the manifest of a file without reading its data frames (the passphrase is still needed: the footer is encrypted). */
export function readManifest(file: string, passphrase: string): BackupManifest {
  const s = syncSource(file);
  try {
    if (s.read(0, MAGIC1.length).equals(MAGIC1)) return openV1(fs.readFileSync(file), passphrase).manifest;
    const h = keyFor(s.read(0, HEADER_BYTES), passphrase);
    const { footerOffset, footerIndex } = parseTrailer(s.size, s.read(s.size - TRAILER_BYTES, TRAILER_BYTES));
    return decodeManifest(h, footerIndex, s.read(footerOffset, s.size - TRAILER_BYTES - footerOffset));
  } finally { s.close(); }
}

// ---- verification ----------------------------------------------------------------------------------------------------

/** The audit chain, row by row, in constant memory. */
class AuditChain {
  private prev: ChainTail | null = null;
  rows = 0;
  head: { sequence: number; hash: string | null } = { sequence: 0, hash: null };
  brokenAt: number | null = null;
  /** `row` uses the column names of audit_trail. */
  add(row: Record<string, unknown>) {
    if (this.brokenAt !== null) return;
    const r = normalizeAuditRow({ ...row, sequence: Number(row.sequence), hash_version: row.hash_version === undefined ? undefined : Number(row.hash_version) });
    this.rows++;
    if (checkRow(r, this.prev)) { this.brokenAt = r.sequence; return; }
    this.prev = nextTail(r, this.prev);
    this.head = { sequence: r.sequence, hash: r.hash };
  }
}

/** Everything the verification looks at, fed with the decoded lines of each data frame in order. */
class V2Check {
  readonly problems: string[] = [];
  corruptFrame: number | null = null;
  private frames = 0;
  private plainBytes = 0;
  private readonly stream: Hash = createHash('sha256');
  private table: { digest: TableDigest; info: TableInfo; audit: boolean } | null = null;
  private readonly seen = new Map<string, TableManifest>();
  private readonly audit = new AuditChain();
  private readonly blobs: BlobSectionCheck;
  constructor(private readonly manifest: BackupManifest) { this.blobs = new BlobSectionCheck(manifest.blobs ?? []); }

  /** A blob frame: counted, and its chunk re-hashed into its file (not part of the table stream hash). */
  blob(plain: Buffer) { this.frames++; this.blobs.frame(plain); }

  frame(plain: Buffer) {
    this.frames++; this.plainBytes += plain.length; this.stream.update(plain);
    for (const line of plain.toString('utf8').split('\n')) {
      if (line === '') continue;
      const v = JSON.parse(line);
      if (!Array.isArray(v)) {
        if (this.table && this.table.info.name === v.t) continue; // header repeated at the start of a frame
        this.closeTable();
        const info: TableInfo = { name: v.t, columns: v.c, tsColumns: (this.manifest.tables?.[v.t]?.tsColumns ?? []), pk: [] };
        this.table = { digest: new TableDigest(info), info, audit: v.t === 'audit_trail' };
      } else if (this.table) {
        this.table.digest.add(line + '\n', v);
        if (this.table.audit) this.audit.add(Object.fromEntries(this.table.info.columns.map((c, i) => [c, v[i]])));
      }
    }
  }
  private closeTable() { if (this.table) { this.seen.set(this.table.info.name, this.table.digest.finish()); this.table = null; } }

  finish(): string[] {
    this.closeTable();
    const m = this.manifest;
    if (this.corruptFrame !== null) return this.problems;
    if (this.frames !== m.frames) this.problems.push(`frame count mismatch: ${this.frames} read, ${m.frames} in the manifest`);
    if (this.plainBytes !== m.plainBytes || this.stream.digest('hex') !== m.streamSha256) this.problems.push('stream hash mismatch');
    for (const [t, want] of Object.entries(m.tables ?? {})) {
      const got = this.seen.get(t);
      if (!got) { this.problems.push(`table missing: ${t}`); continue; }
      if (got.rows !== want.rows) this.problems.push(`row count mismatch: ${t}`);
      else if (got.sha256 !== want.sha256 || got.tsSha256 !== want.tsSha256) this.problems.push(`data hash mismatch: ${t}`);
    }
    for (const t of this.seen.keys()) if (!m.tables?.[t]) this.problems.push(`table not in the manifest: ${t}`);
    if (this.audit.brokenAt !== null) this.problems.push(`audit chain broken at sequence ${this.audit.brokenAt}`);
    if ((this.audit.head.hash ?? null) !== m.auditHead.hash) this.problems.push('audit head differs from manifest');
    this.problems.push(...this.blobs.finish());
    return this.problems;
  }
}

/** The plaintext of a frame (its type, from the frame, is in the authenticated data). */
function openRaw(h: Header, frame: FrameInfo, raw: Buffer): Buffer {
  const len = raw.readUInt32BE(1);
  const body = raw.subarray(5, 5 + len), tag = raw.subarray(5 + len, 5 + len + TAG_BYTES);
  return openFrame(h, raw[0], frame.index, body, tag);
}

function decodeData(h: Header, frame: FrameInfo, raw: Buffer): Buffer {
  return zlib.gunzipSync(openRaw(h, frame, raw));
}

/** Feeds one frame to the check: a blob frame as its raw chunk, a data frame decompressed. */
function checkFrame(check: V2Check, h: Header, frame: FrameInfo, raw: Buffer) {
  if (frame.type === FRAME_BLOB) check.blob(openRaw(h, frame, raw));
  else check.frame(decodeData(h, frame, raw));
}

function v1Result(file: string, passphrase: string): VerifyResult {
  const p = openV1(fs.readFileSync(file), passphrase);
  const problems: string[] = [];
  if (sha(JSON.stringify(p.tables)) !== p.manifest.dataHash) problems.push('data hash mismatch');
  for (const [t, n] of Object.entries(p.manifest.counts)) if ((p.tables[t] || []).length !== n) problems.push(`row count mismatch: ${t}`);
  const chain = verifyAuditChain(p.tables['audit_trail'] || []);
  if (!chain.isValid) problems.push(`audit chain broken at sequence ${chain.compromisedSequence}`);
  const rows = p.tables['audit_trail'] || []; const head = rows.length ? rows.reduce((a, b) => (b.sequence > a.sequence ? b : a)) : null;
  if ((head?.hash ?? null) !== p.manifest.auditHead.hash) problems.push('audit head differs from manifest');
  return { ok: problems.length === 0, problems, manifest: p.manifest, corruptFrame: null };
}

const isV1 = (head: Buffer) => head.subarray(0, MAGIC1.length).equals(MAGIC1);

/** Verifies a backup file, synchronously (CLI, tests, small files). The server uses verifyBackup(), which does not block. */
export function verifyBackupFile(file: string, passphrase: string): VerifyResult {
  const s = syncSource(file);
  try {
    if (s.size >= MAGIC1.length && isV1(s.read(0, MAGIC1.length))) return v1Result(file, passphrase);
    const h = keyFor(s.read(0, HEADER_BYTES), passphrase);
    const { footerOffset, footerIndex } = parseTrailer(s.size, s.read(s.size - TRAILER_BYTES, TRAILER_BYTES));
    const manifest = decodeManifest(h, footerIndex, s.read(footerOffset, s.size - TRAILER_BYTES - footerOffset));
    const check = new V2Check(manifest);
    const plan = framePlan(footerOffset);
    while (!plan.done && check.corruptFrame === null) {
      const frame = plan.take(s.read(plan.pos, 5));
      try { checkFrame(check, h, frame, s.read(frame.offset, frame.length)); }
      catch { check.corruptFrame = frame.index; check.problems.push(`frame ${frame.index} is corrupt (authentication failed)`); }
    }
    const problems = check.finish();
    return { ok: problems.length === 0, problems, manifest, corruptFrame: check.corruptFrame };
  } finally { s.close(); }
}

/** Same checks as verifyBackupFile(), reading with asynchronous I/O so the server keeps answering while a large file is verified. */
export async function verifyBackup(file: string, passphrase: string): Promise<VerifyResult> {
  const s = await asyncSource(file);
  try {
    if (s.size >= MAGIC1.length && isV1(await s.read(0, MAGIC1.length))) return v1Result(file, passphrase);
    const h = keyFor(await s.read(0, HEADER_BYTES), passphrase);
    const { footerOffset, footerIndex } = parseTrailer(s.size, await s.read(s.size - TRAILER_BYTES, TRAILER_BYTES));
    const manifest = decodeManifest(h, footerIndex, await s.read(footerOffset, s.size - TRAILER_BYTES - footerOffset));
    const check = new V2Check(manifest);
    const plan = framePlan(footerOffset);
    while (!plan.done && check.corruptFrame === null) {
      const frame = plan.take(await s.read(plan.pos, 5));
      const raw = await s.read(frame.offset, frame.length);
      try { checkFrame(check, h, frame, raw); }
      catch { check.corruptFrame = frame.index; check.problems.push(`frame ${frame.index} is corrupt (authentication failed)`); }
    }
    const problems = check.finish();
    return { ok: problems.length === 0, problems, manifest, corruptFrame: check.corruptFrame };
  } finally { await s.close(); }
}

// ---- version 1 -------------------------------------------------------------------------------------------------------

interface V1Payload { manifest: BackupManifest; tables: Record<string, any[]> }

function openV1(file: Buffer, passphrase: string): V1Payload {
  if (!isV1(file)) throw new Error('Not a B-Pharma LIMS backup file');
  let o = MAGIC1.length;
  const salt = file.subarray(o, o += 16), iv = file.subarray(o, o += 12), tag = file.subarray(o, o += 16);
  const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv); d.setAuthTag(tag);
  try { return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(file.subarray(o)), d.final()])).toString()); }
  catch { throw new Error(DAMAGED); }
}

// ---- restore ---------------------------------------------------------------------------------------------------------

export interface RestoreOptions {
  /** Folder with the migration files, used to build the schema of the backup's version when no schema SQL is given. */
  migrationsDir?: string;
  /** The blob store the attachment files are restored into (default: blobDir(), BLOB_DIR). */
  blobDir?: string;
}

export interface RestoreResult {
  restored: Record<string, number>;
  chainIntact: boolean;
  countsMatch: boolean;
  /** v2 only (null for a v1 file): every restored table re-read and hashed like the backup, and compared with the manifest. */
  hashesMatch: boolean | null;
  timestampsMatch: boolean | null;
  auditHead: { sequence: number; hash: string | null };
  tablesCompared: number;
  /** Attachment files written into (or already intact in) the target blob store. */
  blobsRestored: number;
  problems: string[];
}

const asParam = (x: unknown): string | null => (x === null || x === undefined ? null : typeof x === 'object' ? JSON.stringify(x) : String(x));

async function insertBatch(c: pg.ClientBase, table: string, columns: string[], rows: Row[]) {
  const per = Math.max(1, Math.min(2000, Math.floor(60000 / columns.length)));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const values = part.map((_, r) => `(${columns.map((_, k) => `$${r * columns.length + k + 1}`).join(',')})`).join(',');
    await c.query(`insert into ${ident(table)} (${columns.map(ident).join(',')}) values ${values}`, part.flat());
  }
}

/** Walks the frames of a v2 file (already verified) and calls back per table header and batch of rows, and per blob chunk. */
async function replayV2(file: string, passphrase: string, on: (table: string, columns: string[], rows: Row[]) => Promise<void>, onBlob: (plain: Buffer) => Promise<void>) {
  const s = await asyncSource(file);
  try {
    const h = keyFor(await s.read(0, HEADER_BYTES), passphrase);
    const { footerOffset } = parseTrailer(s.size, await s.read(s.size - TRAILER_BYTES, TRAILER_BYTES));
    const plan = framePlan(footerOffset);
    while (!plan.done) {
      const frame = plan.take(await s.read(plan.pos, 5));
      const raw = await s.read(frame.offset, frame.length);
      if (frame.type === FRAME_BLOB) { await onBlob(openRaw(h, frame, raw)); continue; }
      const plain = decodeData(h, frame, raw);
      let name = '', columns: string[] = [], rows: Row[] = [];
      const flush = async () => { if (name && rows.length) await on(name, columns, rows); rows = []; };
      for (const line of plain.toString('utf8').split('\n')) {
        if (line === '') continue;
        const v = JSON.parse(line);
        if (Array.isArray(v)) rows.push(v);
        else { await flush(); name = v.t; columns = v.c; }
      }
      await flush();
    }
  } finally { await s.close(); }
}

/** Restores `file` into an empty database. `schemaSql` defaults to the schema of the backup's version, built from the migrations. */
export async function restoreBackup(file: string, passphrase: string, target: pg.Pool, schemaSql?: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const v = await verifyBackup(file, passphrase);
  if (!v.ok) throw new Error('Backup failed verification: ' + v.problems.join('; '));
  const manifest = v.manifest;
  const c = await target.connect();
  try {
    const exists = await c.query(`select to_regclass('public.users') as t`);
    if (exists.rows[0].t) {
      const n = await c.query('select count(*)::int as n from users');
      if (n.rows[0].n > 0) throw new Error('Target database is not empty; restore never overwrites existing data');
    } else {
      let sqlText = schemaSql;
      if (sqlText === undefined) {
        const files = loadMigrations(options.migrationsDir);
        const newest = files[files.length - 1]?.id;
        if (manifest.schemaVersion && newest && manifest.schemaVersion > newest) {
          throw new Error(`The backup was made by a newer version of the application (schema ${manifest.schemaVersion}; this one knows ${newest}). Install that version or a newer one to restore it.`);
        }
        sqlText = buildSchemaSql(files, manifest.schemaVersion ?? undefined);
      }
      await c.query(sqlText);
    }

    const dir = options.blobDir ?? blobDir();
    const blobs = new BlobRestorer(dir);
    await c.query('BEGIN');
    for (const s of CANONICAL_SESSION) await c.query(s);
    if (manifest.format === 2) {
      await replayV2(file, passphrase, async (table, columns, rows) => { if (rows.length) await insertBatch(c, table, columns, rows); }, p => blobs.frame(p));
    } else {
      const p = openV1(fs.readFileSync(file), passphrase);
      for (const t of await tableOrder(c)) {
        const rows = p.tables[t] || [];
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        await insertBatch(c, t, columns, rows.map(r => columns.map(k => asParam(r[k]))));
      }
    }
    await c.query('COMMIT');
    for (const st of protectionStatements) await c.query(st);
    const files = await blobs.finish();
    const result = await checkRestored(c, manifest);
    result.blobsRestored = files.restored;
    result.problems.push(...files.problems, ...await checkRestoredBlobs(c, dir));
    return result;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* none open */ } throw e; }
  finally { c.release(); }
}

/** Independent check of the restored database itself against the manifest. */
async function checkRestored(c: pg.ClientBase, manifest: BackupManifest): Promise<RestoreResult> {
  const problems: string[] = [];
  const restored: Record<string, number> = {};
  let countsMatch = true;
  for (const [t, n] of Object.entries(manifest.counts)) {
    const got = (await c.query(`select count(*)::int as n from ${ident(t)}`)).rows[0].n;
    restored[t] = got;
    if (got !== n) { countsMatch = false; problems.push(`row count mismatch after restore: ${t} (${got}, expected ${n})`); }
  }

  // The audit chain of the restored table, read back in batches.
  const chain = new AuditChain();
  let last = 0;
  for (;;) {
    const res = await c.query('select * from audit_trail where sequence > $1 order by sequence limit 5000', [last]);
    if (res.rows.length === 0) break;
    for (const r of res.rows) chain.add(r);
    last = res.rows[res.rows.length - 1].sequence;
  }
  const chainIntact = chain.brokenAt === null && (chain.head.hash ?? null) === manifest.auditHead.hash;
  if (!chainIntact) problems.push(chain.brokenAt !== null ? `audit chain broken at sequence ${chain.brokenAt} after restore` : 'audit head differs from manifest after restore');

  let hashesMatch: boolean | null = null, timestampsMatch: boolean | null = null, tablesCompared = 0;
  if (manifest.format === 2 && manifest.tables) {
    hashesMatch = true; timestampsMatch = true;
    await openSnapshot(c);
    try {
      const open = { digest: null as TableDigest | null };
      const close = () => {
        if (!open.digest) return;
        const want = manifest.tables![open.digest.table.name], got = open.digest.finish();
        tablesCompared++;
        if (got.rows !== want.rows || got.sha256 !== want.sha256) { hashesMatch = false; problems.push(`restored table differs from the backup: ${open.digest.table.name}`); }
        if (got.tsSha256 !== want.tsSha256) { timestampsMatch = false; problems.push(`timestamps differ from the backup: ${open.digest.table.name}`); }
        open.digest = null;
      };
      await exportTables(c, manifest.tableOrder ?? Object.keys(manifest.tables), async (e) => {
        if (e.kind === 'table') { close(); open.digest = new TableDigest(e.table); return; }
        for (const row of e.rows) open.digest!.add(JSON.stringify(row) + '\n', row);
      });
      close();
    } finally { await c.query('COMMIT'); }
  }
  return { restored, chainIntact, countsMatch, hashesMatch, timestampsMatch, auditHead: manifest.auditHead, tablesCompared, blobsRestored: 0, problems };
}
