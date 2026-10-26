// Batch archive bundles (roadmap M42, r3-periodic-archive; migration 0330_periodic_archive; EU GMP Annex 11 section 17, 21 CFR 211.180).
//
// Archiving NEVER deletes or alters a GxP record. It does three things:
//   1. buildBatchBundle   exports everything that belongs to one batch (records as open JSON, the CoA PDFs, the raw-data files, the audit
//                         slice, the signatures) into a folder under ARCHIVE_DIR with a SHA-256 manifest. Files are read-only.
//   2. verifyArchive      re-hashes every file against the manifest (needs no database), and refuses an extra, a missing or an altered file.
//   3. decideArchive      QA e-signature (ARCHIVE_DECISION) bound to the manifest hash: re-verifies the bundle, proves the live records are
//                         still exactly what the bundle holds, and marks them archived in the sidecar archived_records. From then on an
//                         UPDATE of an archived sample, result, batch, release or CoA answers 423 (guard) or is refused by a trigger.
// restoreArchive re-imports a verified bundle (rows that are missing are inserted, rows that exist are compared, none is overwritten): it is
// the round trip the restore test exercises, into a scratch database or, as a dry run, into the live one.
// The audit trail is not copied back: it stays append-only and chained in the database; the bundle carries the slice as evidence.
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { archiveBundles, archivedRecords } from '../db/schema/periodic';
import { writeAudit } from '../db/utils';
import { appVersion } from './boot/version';
import { verifyAuditChain } from './audit/chain';
import { blobDir, blobPath, verifyBlob } from './blobs';
import type { Db } from './core/context';
import { lockRow, updateVersioned, withTransaction, type Executor, type Tx } from './core/tx';
import { registerSignable, signRecord } from './esign';
import { asyncHandler } from './core/asyncHandler';
import { AppError, ConflictError, NotFoundError } from './http/errors';

export const ARCHIVE_MEANING = 'ARCHIVE_DECISION';
export const FORMAT = 'bp-lims-archive';
export const FORMAT_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;

/** ARCHIVE_DIR, else an `archives` folder next to the backups folder (like the blob store). */
export function archiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARCHIVE_DIR || path.join(path.dirname(env.BACKUP_DIR || path.join(process.cwd(), 'backups')), 'archives');
}

export const buildSchema = z.object({ batchId: z.string('batchId is required.').trim().min(1).max(200) }).strict();
export const decideSchema = z.object({
  reason: z.string('A reason is required.').trim().min(5).max(1000),
  expectedVersion: z.number('expectedVersion is required.').int().min(1),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
}).strict();

// ---- what a batch bundle holds ---------------------------------------------------------------------------------------------------

interface TableSpec {
  name: string;
  key: string[];
  /** SELECT of the rows to export, as the table alias t, restricted through the temp tables _arch_samples / _arch_ids. */
  where: string;
  order: string;
  /** Archived entity type of the table's rows, if the table is locked when the bundle is accepted. */
  entityType?: string;
}

// Parents first: this is also the restore order. Users are not exported (credentials); they must exist in the target.
const TABLES: readonly TableSpec[] = [
  { name: 'products', key: ['id'], where: 't.id IN (SELECT product_id FROM product_batches WHERE id IN (SELECT id FROM _arch_batch))', order: 't.id' },
  { name: 'customers', key: ['id'], where: 't.id IN (SELECT customer_id FROM sample_context WHERE customer_id IS NOT NULL AND sample_id IN (SELECT id FROM _arch_samples))', order: 't.id' },
  { name: 'specifications', key: ['id'], where: 't.id IN (SELECT spec_id FROM samples WHERE spec_id IS NOT NULL AND id IN (SELECT id FROM _arch_samples))', order: 't.id' },
  { name: 'spec_parameters', key: ['id'], where: 't.spec_id IN (SELECT spec_id FROM samples WHERE spec_id IS NOT NULL AND id IN (SELECT id FROM _arch_samples))', order: 't.id' },
  { name: 'instruments', key: ['id'], where: 't.id IN (SELECT instrument_id FROM results WHERE instrument_id IS NOT NULL AND sample_id IN (SELECT id FROM _arch_samples))', order: 't.id' },
  { name: 'product_batches', key: ['id'], where: 't.id IN (SELECT id FROM _arch_batch)', order: 't.id', entityType: 'ProductBatch' },
  { name: 'samples', key: ['id'], where: 't.id IN (SELECT id FROM _arch_samples)', order: 't.id', entityType: 'Sample' },
  { name: 'sample_context', key: ['sample_id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.sample_id' },
  { name: 'results', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id', entityType: 'Result' },
  { name: 'result_versions', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id' },
  { name: 'attachments', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id' },
  { name: 'review_checklists', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id' },
  { name: 'oos_investigations', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id' },
  { name: 'batch_releases', key: ['id'], where: 't.batch IN (SELECT batch_no FROM product_batches WHERE id IN (SELECT id FROM _arch_batch))', order: 't.id', entityType: 'BatchRelease' },
  { name: 'coa_documents', key: ['id'], where: 't.sample_id IN (SELECT id FROM _arch_samples)', order: 't.id', entityType: 'CoaDocument' },
  { name: 'report_runs', key: ['id'], where: 't.document_id IN (SELECT id FROM coa_documents WHERE sample_id IN (SELECT id FROM _arch_samples))', order: 't.id' },
  { name: 'signatures', key: ['id'], where: `t.sample_id IN (SELECT id FROM _arch_samples) OR t.entity_id IN (SELECT id FROM _arch_ids)`, order: 't.id' },
];

const rowsOf = (res: unknown): any[] => (res as { rows: any[] }).rows;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

interface Collected {
  batch: { id: string; batchNo: string; status: string; productId: string; productName: string };
  tables: Record<string, any[]>;
  audit: any[];
  actors: Array<{ id: string; name: string; role: string }>;
  entities: Array<{ entityType: string; entityId: string }>;
  pdfs: Array<{ runId: string; sha256: string; bytes: number; data: Buffer }>;
  blobs: Array<{ sha256: string; bytes: number }>;
  headAtBuild: { sequence: number; hash: string | null };
}

const requireOk = (ok: boolean, problems: string[]) => { if (!ok) throw new AppError(409, 'ARCHIVE_PRECONDITION', `The batch cannot be archived yet: ${problems.join('; ')}.`, { problems }); };

/** The batch must be finished: dispositioned, every sample approved or rejected, no investigation open. */
export async function checkBatchPreconditions(ex: Executor, batchId: string): Promise<{ id: string; batchNo: string; status: string; productName: string; sampleCount: number }> {
  const [b] = rowsOf(await ex.execute(sql`SELECT b.id, b.batch_no, b.status, p.name AS product_name FROM product_batches b JOIN products p ON p.id = b.product_id WHERE b.id = ${batchId}`));
  if (!b) throw new NotFoundError(`Batch ${batchId} was not found.`);
  const [done] = rowsOf(await ex.execute(sql`SELECT id FROM archive_bundles WHERE kind = 'batch' AND subject_id = ${batchId} AND status = 'Archived'`));
  if (done) throw new AppError(409, 'ALREADY_ARCHIVED', `Batch ${batchId} is already archived (bundle ${done.id}).`);
  const problems: string[] = [];
  if (!['Released', 'Rejected'].includes(b.status)) problems.push(`the batch is ${b.status} (only a Released or Rejected batch is archived)`);
  const sampleRows = rowsOf(await ex.execute(sql`
    SELECT s.id, s.state FROM samples s WHERE s.id IN (SELECT sample_id FROM sample_context WHERE batch_id = ${batchId})
       OR (s.batch = ${b.batch_no} AND lower(s.material) = lower(${b.product_name}) AND NOT EXISTS (SELECT 1 FROM sample_context c WHERE c.sample_id = s.id))`));
  if (sampleRows.length === 0) problems.push('the batch has no samples');
  const open = sampleRows.filter(s => !['Approved', 'Rejected'].includes(s.state)).map(s => `${s.id} is ${s.state}`);
  if (open.length) problems.push(`samples not finished: ${open.slice(0, 5).join(', ')}`);
  const oos = rowsOf(await ex.execute(sql`SELECT id FROM oos_investigations WHERE sample_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(sampleRows.map(s => s.id))}::jsonb)) AND status NOT IN ('Approved', 'Closed')`));
  if (oos.length) problems.push(`open OOS investigations: ${oos.slice(0, 5).map(o => o.id).join(', ')}`);
  requireOk(problems.length === 0, problems);
  return { id: b.id, batchNo: b.batch_no, status: b.status, productName: b.product_name, sampleCount: sampleRows.length };
}

/** Reads everything of the batch in one transaction (the caller's), through temp tables that vanish at COMMIT. */
async function collectBatch(tx: Tx, batchId: string, lock = false): Promise<Collected> {
  const batch = await checkBatchPreconditions(tx, batchId);
  await tx.execute(sql`CREATE TEMP TABLE _arch_samples ON COMMIT DROP AS
    SELECT s.id FROM samples s WHERE s.id IN (SELECT sample_id FROM sample_context WHERE batch_id = ${batchId})
       OR (s.batch = ${batch.batchNo} AND lower(s.material) = lower(${batch.productName}) AND NOT EXISTS (SELECT 1 FROM sample_context c WHERE c.sample_id = s.id))`);
  await tx.execute(sql`CREATE TEMP TABLE _arch_batch ON COMMIT DROP AS SELECT ${batchId}::text AS id`);
  if (lock) await tx.execute(sql`SELECT 1 FROM samples WHERE id IN (SELECT id FROM _arch_samples) FOR UPDATE`);
  if (lock) await tx.execute(sql`SELECT 1 FROM results WHERE sample_id IN (SELECT id FROM _arch_samples) FOR UPDATE`);
  const tables: Record<string, any[]> = {};
  // The id set the audit slice is cut from is built after the entity tables, from their keys.
  for (const spec of TABLES) {
    if (spec.name === 'signatures') {
      await tx.execute(sql`CREATE TEMP TABLE _arch_ids ON COMMIT DROP AS
        SELECT id FROM samples WHERE id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM results WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM result_versions WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM attachments WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM review_checklists WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM oos_investigations WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM coa_documents WHERE sample_id IN (SELECT id FROM _arch_samples)
        UNION SELECT id FROM report_runs WHERE document_id IN (SELECT id FROM coa_documents WHERE sample_id IN (SELECT id FROM _arch_samples))
        UNION SELECT id FROM batch_releases WHERE batch = ${batch.batchNo}
        UNION SELECT ${batch.batchNo}::text UNION SELECT ${batchId}::text`);
    }
    // report_runs.pdf is exported as a file; the row keeps its sha256 and size.
    const projection = spec.name === 'report_runs' ? `to_jsonb(t) - 'pdf'` : 'to_jsonb(t)';
    tables[spec.name] = rowsOf(await tx.execute(sql.raw(`SELECT ${projection} AS j FROM ${spec.name} t WHERE ${spec.where} ORDER BY ${spec.order} COLLATE "C"`))).map(r => r.j);
  }
  const audit = rowsOf(await tx.execute(sql`SELECT * FROM audit_trail WHERE entity_id IN (SELECT id FROM _arch_ids) ORDER BY sequence`)).map(r => ({
    id: r.id, sequence: r.sequence, timestamp: new Date(r.timestamp).toISOString(), timestampStr: r.timestamp_str, userId: r.user_id, actorName: r.actor_name, actorRole: r.actor_role,
    sessionId: r.session_id, appVersion: r.app_version, action: r.action, entity: r.entity, entityId: r.entity_id, field: r.field, oldValue: r.old_value, newValue: r.new_value,
    reason: r.reason, hash: r.hash, prevHash: r.prev_hash, hashVersion: r.hash_version, hashAlg: r.hash_alg, seal: r.seal,
  }));
  const actorIds = new Set<string>();
  for (const rows of Object.values(tables)) for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && /(_by|_id)$/.test(k) && k !== 'sample_id') actorIds.add(v);
  for (const a of audit) actorIds.add(a.userId);
  const actors = rowsOf(await tx.execute(sql`SELECT id, name, role FROM users WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify([...actorIds])}::jsonb)) ORDER BY id COLLATE "C"`)).map(u => ({ id: u.id, name: u.name, role: u.role }));
  const pdfs = rowsOf(await tx.execute(sql`SELECT id, pdf FROM report_runs WHERE document_id IN (SELECT id FROM coa_documents WHERE sample_id IN (SELECT id FROM _arch_samples)) ORDER BY id COLLATE "C"`))
    .map(r => ({ runId: r.id as string, data: r.pdf as Buffer, sha256: sha256(r.pdf), bytes: (r.pdf as Buffer).length }));
  const blobMap = new Map<string, number>();
  for (const a of tables.attachments) blobMap.set(a.sha256, Number(a.bytes));
  const entities = TABLES.flatMap(s => s.entityType ? tables[s.name].map(r => ({ entityType: s.entityType!, entityId: r[s.key[0]] as string })) : []);
  const [head] = rowsOf(await tx.execute(sql`SELECT sequence, hash FROM audit_trail ORDER BY sequence DESC LIMIT 1`));
  return {
    batch: { id: batch.id, batchNo: batch.batchNo, status: batch.status, productId: tables.product_batches[0]?.product_id, productName: batch.productName },
    tables, audit, actors, entities, pdfs,
    blobs: [...blobMap].map(([h, bytes]) => ({ sha256: h, bytes })).sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
    headAtBuild: { sequence: head?.sequence ?? 0, hash: head?.hash ?? null },
  };
}

const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

export interface ManifestFile { path: string; sha256: string; bytes: number }
export interface Manifest {
  format: typeof FORMAT; formatVersion: number; bundleId: string; kind: 'batch'; subject: { batchId: string; batchNo: string; product: string; status: string };
  createdAt: string; createdBy: string; appVersion: string;
  tables: Array<{ name: string; key: string[]; rows: number; file: string }>;
  auditSlice: { entries: number; firstSequence: number | null; lastSequence: number | null; chainHeadAtBuild: { sequence: number; hash: string | null } };
  files: ManifestFile[];
}

const README = `This folder is an archive bundle of the B-Pharma LIMS (format ${FORMAT}, version ${FORMAT_VERSION}).
Everything is in open formats: JSON (UTF-8), PDF and the original raw-data files.

MANIFEST.json   lists every file with its SHA-256 and size; MANIFEST.sha256 holds the SHA-256 of MANIFEST.json itself.
data/*.json     the records of the batch, one file per table, as exported (timestamps are ISO 8601 with offset).
data/actors.json  who the user ids in the records are (name and role; no credentials).
audit/audit_trail.json  the audit-trail entries about these records, with their hash and seal fields as recorded.
reports/        the generated Certificate of Analysis PDFs, by report run id.
blobs/          the raw-data files, named by their SHA-256.

To check the bundle without the application: sha256sum -c on the files of MANIFEST.json, and sha256sum MANIFEST.json against MANIFEST.sha256.
Archiving does not delete or alter any record in the database; the audit trail stays in the database.
`;

async function writeFileRO(file: string, data: Buffer | string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, data, { mode: 0o444 });
}

export async function buildBatchBundle(db: Db, opts: { batchId: string; actorId: string; dir?: string; now?: Date }) {
  const root = opts.dir ?? archiveDir();
  const now = opts.now ?? new Date();
  const existing = rowsOf(await db.execute(sql`SELECT id FROM archive_bundles WHERE kind = 'batch' AND subject_id = ${opts.batchId} AND status = 'Archived'`));
  if (existing.length) throw new AppError(409, 'ALREADY_ARCHIVED', `Batch ${opts.batchId} is already archived (bundle ${existing[0].id}).`);

  const bundleId = `arc-${randomBytes(8).toString('hex')}`;
  const partial = path.join(root, `${bundleId}.partial`);
  const final = path.join(root, bundleId);
  await fs.promises.mkdir(root, { recursive: true });

  try {
    const collected = await db.transaction(async (tx) => collectBatch(tx, opts.batchId), { isolationLevel: "repeatable read" });
    const files: ManifestFile[] = [];
    const put = async (rel: string, data: Buffer | string) => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      await writeFileRO(path.join(partial, rel), buf);
      files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
    };
    for (const spec of TABLES) await put(`data/${spec.name}.json`, json(collected.tables[spec.name]));
    await put('data/actors.json', json(collected.actors));
    await put('audit/audit_trail.json', json(collected.audit));
    for (const p of collected.pdfs) await put(`reports/${p.runId}.pdf`, p.data);
    for (const b of collected.blobs) {
      const v = await verifyBlob(blobDir(), b.sha256);
      if (!v.ok) throw new AppError(409, 'ARCHIVE_BLOB_MISSING', `The raw-data file ${b.sha256} is ${'problem' in v ? v.problem : 'not intact'} in the blob store: the batch cannot be archived until it is restored.`);
      const data = await fs.promises.readFile(blobPath(blobDir(), b.sha256));
      await put(`blobs/${b.sha256}`, data);
    }
    await put('README.txt', README);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const manifest: Manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, bundleId, kind: 'batch',
      subject: { batchId: collected.batch.id, batchNo: collected.batch.batchNo, product: collected.batch.productName, status: collected.batch.status },
      createdAt: now.toISOString(), createdBy: opts.actorId, appVersion: appVersion(),
      tables: TABLES.map(s => ({ name: s.name, key: s.key, rows: collected.tables[s.name].length, file: `data/${s.name}.json` })),
      auditSlice: { entries: collected.audit.length, firstSequence: collected.audit[0]?.sequence ?? null, lastSequence: collected.audit.at(-1)?.sequence ?? null, chainHeadAtBuild: collected.headAtBuild },
      files,
    };
    const manifestText = json(manifest);
    const manifestSha = sha256(manifestText);
    await writeFileRO(path.join(partial, 'MANIFEST.json'), manifestText);
    await writeFileRO(path.join(partial, 'MANIFEST.sha256'), `${manifestSha}  MANIFEST.json\n`);
    await fs.promises.rename(partial, final);
    // Read-only folders: a later write needs a deliberate chmod. (Not a security boundary: the manifest hash in the database is.)
    await lockTree(final);

    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    const recordCounts = Object.fromEntries(TABLES.map(s => [s.name, collected.tables[s.name].length]));
    const bundle = await withTransaction(db, async (tx) => {
      const [row] = await tx.insert(archiveBundles).values({
        id: bundleId, kind: 'batch', subjectId: collected.batch.id, subjectLabel: `${collected.batch.productName} ${collected.batch.batchNo}`, dirName: bundleId,
        manifestSha256: manifestSha, fileCount: files.length + 2, bytes, recordCounts, builtBy: opts.actorId, builtAt: now,
      }).returning();
      await writeAudit(tx, opts.actorId, 'Build', 'ArchiveBundle', bundleId, 'status', '', 'Built', `Archive bundle built for batch ${collected.batch.batchNo} (${files.length} files, manifest ${manifestSha})`);
      return row;
    });
    return bundle;
  } catch (e) {
    await fs.promises.rm(partial, { recursive: true, force: true });
    throw e;
  }
}

/** Makes a tree read-only (files 0444, folders 0555), deepest first. */
async function lockTree(dir: string) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await lockTree(path.join(dir, entry.name));
  }
  await fs.promises.chmod(dir, 0o555);
}

// ---- verification (no database) --------------------------------------------------------------------------------------------------

export interface ArchiveCheck { ok: boolean; problems: string[]; manifestSha256: string | null; files: number; bytes: number }

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), bytes };
}

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(dir, rel)); else out.push(rel);
  }
  return out;
}

/** Re-hashes a bundle. `expectedManifestSha256` (from the register) catches a manifest that was replaced together with the files. */
export async function verifyArchive(dir: string, opts: { expectedManifestSha256?: string } = {}): Promise<ArchiveCheck> {
  const problems: string[] = [];
  let manifest: Manifest | null = null;
  let manifestSha: string | null = null;
  try {
    const text = await fs.promises.readFile(path.join(dir, 'MANIFEST.json'));
    manifestSha = sha256(text);
    manifest = JSON.parse(text.toString('utf8')) as Manifest;
  } catch (e) {
    return { ok: false, problems: [`MANIFEST.json cannot be read: ${(e as Error).message}`], manifestSha256: null, files: 0, bytes: 0 };
  }
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files)) problems.push('MANIFEST.json is not a bundle manifest');
  try {
    const recorded = (await fs.promises.readFile(path.join(dir, 'MANIFEST.sha256'), 'utf8')).split(/\s+/)[0];
    if (recorded !== manifestSha) problems.push('MANIFEST.json does not match MANIFEST.sha256');
  } catch { problems.push('MANIFEST.sha256 is missing'); }
  if (opts.expectedManifestSha256 && opts.expectedManifestSha256 !== manifestSha) problems.push('MANIFEST.json does not match the manifest hash in the archive register');

  const listed = new Set<string>();
  let bytes = 0;
  for (const f of manifest.files ?? []) {
    if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..') || !SHA256.test(f.sha256)) { problems.push(`invalid manifest entry ${JSON.stringify(f.path)}`); continue; }
    listed.add(f.path);
    try {
      const h = await hashFile(path.join(dir, f.path));
      bytes += h.bytes;
      if (h.bytes !== f.bytes) problems.push(`${f.path}: size ${h.bytes} differs from ${f.bytes}`);
      if (h.sha256 !== f.sha256) problems.push(`${f.path}: hash differs from the manifest`);
    } catch { problems.push(`${f.path}: file is missing`); }
  }
  for (const rel of await walk(dir)) {
    if (rel !== 'MANIFEST.json' && rel !== 'MANIFEST.sha256' && !listed.has(rel)) problems.push(`${rel}: file is not in the manifest`);
  }
  return { ok: problems.length === 0, problems, manifestSha256: manifestSha, files: listed.size, bytes };
}

/** Verifies a registered bundle and records the result (also when it fails: the failure is the news). */
export async function verifyRegistered(db: Db, actorId: string, bundleId: string, opts: { dir?: string } = {}) {
  const [bundle] = await db.select().from(archiveBundles).where(eq(archiveBundles.id, bundleId)).limit(1);
  if (!bundle) throw new NotFoundError(`Archive bundle ${bundleId} was not found.`);
  const check = await verifyArchive(path.join(opts.dir ?? archiveDir(), bundle.dirName), { expectedManifestSha256: bundle.manifestSha256 });
  await withTransaction(db, async (tx) => {
    const current = await lockRow(tx, archiveBundles, bundleId);
    await updateVersioned(tx, archiveBundles, bundleId, current.version, { lastVerifiedAt: new Date(), lastVerifiedOk: check.ok });
    await writeAudit(tx, actorId, 'Verify', 'ArchiveBundle', bundleId, 'verification', String(current.lastVerifiedOk ?? ''), check.ok ? 'ok' : 'failed',
      check.ok ? `Bundle verified (${check.files} files)` : `Bundle verification FAILED: ${check.problems.slice(0, 5).join('; ')}`);
  });
  return { bundle, check };
}

// ---- the QA decision -------------------------------------------------------------------------------------------------------------

registerSignable({
  type: 'ArchiveBundle',
  async canonical(ex, { id }) {
    const [b] = await ex.select().from(archiveBundles).where(eq(archiveBundles.id, id)).limit(1);
    return b ? { id: b.id, kind: b.kind, subjectId: b.subjectId, manifestSha256: b.manifestSha256, fileCount: b.fileCount, recordCounts: b.recordCounts } : null;
  },
});

export async function decideArchive(db: Db, user: { id: string }, bundleId: string, input: z.infer<typeof decideSchema>, opts: { dir?: string; context?: Parameters<typeof signRecord>[0]['context'] } = {}) {
  const root = opts.dir ?? archiveDir();
  const [first] = await db.select().from(archiveBundles).where(eq(archiveBundles.id, bundleId)).limit(1);
  if (!first) throw new NotFoundError(`Archive bundle ${bundleId} was not found.`);
  const precheck = async (b: typeof first) => {
    if (b.version !== input.expectedVersion) throw new ConflictError();
    if (b.status !== 'Built') throw new AppError(409, 'ILLEGAL_TRANSITION', `The bundle is ${b.status}.`);
    const check = await verifyArchive(path.join(root, b.dirName), { expectedManifestSha256: b.manifestSha256 });
    if (!check.ok) throw new AppError(409, 'ARCHIVE_VERIFY_FAILED', `The bundle does not verify: ${check.problems.slice(0, 3).join('; ')}.`, { problems: check.problems });
  };
  await precheck(first); // before the signature is asked for: a refused decision costs the signer no attempt

  return signRecord({
    db, user, meaningCode: ARCHIVE_MEANING, credentials: { password: input.password, totpCode: input.totpCode }, reason: input.reason,
    entityType: 'ArchiveBundle', entityId: bundleId, context: opts.context,
    execute: async (tx) => {
      const bundle = await lockRow(tx, archiveBundles, bundleId);
      await precheck(bundle);
      // Lock the live records, then prove they are exactly what the bundle holds: a record changed since the build is not archived blind.
      const collected = await collectBatch(tx, bundle.subjectId, true);
      const manifest = JSON.parse(await fs.promises.readFile(path.join(root, bundle.dirName, 'MANIFEST.json'), 'utf8')) as Manifest;
      const stale: string[] = [];
      for (const spec of TABLES) {
        const listed = manifest.files.find(f => f.path === `data/${spec.name}.json`);
        if (!listed || sha256(json(collected.tables[spec.name])) !== listed.sha256) stale.push(spec.name);
      }
      if (stale.length) throw new AppError(409, 'ARCHIVE_STALE', `Records changed since the bundle was built (${stale.join(', ')}): build a new bundle.`, { tables: stale });

      const row = await updateVersioned(tx, archiveBundles, bundleId, input.expectedVersion, { status: 'Archived', decidedBy: user.id, decidedAt: new Date() });
      for (const e of collected.entities) {
        await tx.insert(archivedRecords).values({ id: `${e.entityType}:${e.entityId}`, entityType: e.entityType, entityId: e.entityId, bundleId, archivedBy: user.id });
      }
      return {
        recordVersion: row.version,
        audit: { action: 'Archive', field: 'status', oldValue: 'Built', newValue: 'Archived', reason: input.reason },
        result: { bundle: row, archivedRecords: collected.entities.length },
      };
    },
  });
}

export async function listBundles(db: Db) {
  return db.select().from(archiveBundles).orderBy(asc(archiveBundles.builtAt), asc(archiveBundles.id));
}

/** The archived record, if any: what the 423 guard asks. */
export async function archivedEntry(ex: Executor, entityType: string, entityId: string) {
  const [r] = await ex.select().from(archivedRecords).where(and(eq(archivedRecords.entityType, entityType), eq(archivedRecords.entityId, entityId))).limit(1);
  return r ?? null;
}

// ---- restore ---------------------------------------------------------------------------------------------------------------------

export interface RestoreResult {
  ok: boolean; verified: ArchiveCheck; dryRun: boolean;
  tables: Array<{ name: string; rows: number; inserted: number; alreadyPresent: number; different: number }>;
  blobs: { restored: number; present: number };
  problems: string[];
}

/**
 * Re-imports a verified bundle. Rows missing from the target are inserted; rows that exist are compared field by field and never
 * overwritten (a difference is reported and fails the restore). Users must exist in the target (the bundle carries no credentials).
 * With dryRun the transaction is rolled back, so a restore test can run against the live database without changing it.
 */
export async function restoreArchive(db: Db, dir: string, opts: { dryRun?: boolean; blobTarget?: string } = {}): Promise<RestoreResult> {
  const verified = await verifyArchive(dir);
  const result: RestoreResult = { ok: false, verified, dryRun: !!opts.dryRun, tables: [], blobs: { restored: 0, present: 0 }, problems: [...verified.problems] };
  if (!verified.ok) return result;
  const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;
  const read = async (rel: string) => JSON.parse(await fs.promises.readFile(path.join(dir, rel), 'utf8')) as any[];

  const rollback = new Error('rollback');
  try {
    await db.transaction(async (tx) => {
      const actors = await read('data/actors.json');
      const missing = rowsOf(await tx.execute(sql`SELECT a.id FROM jsonb_to_recordset(${JSON.stringify(actors)}::jsonb) AS a(id text) WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.id)`));
      if (missing.length) result.problems.push(`users missing in the target: ${missing.map(m => m.id).join(', ')}`);
      if (result.problems.length === verified.problems.length) {
        for (const t of manifest.tables) {
          const rows = await read(t.file);
          if (t.name === 'report_runs') {
            for (const r of rows) {
              const pdf = await fs.promises.readFile(path.join(dir, 'reports', `${r.id}.pdf`));
              r.pdf = `\\x${pdf.toString('hex')}`;
            }
          }
          const doc = JSON.stringify(rows);
          const name = sql.identifier(t.name);
          const total = rows.length;
          const inserted = rowsOf(await tx.execute(sql`INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name}, ${doc}::jsonb) ON CONFLICT DO NOTHING RETURNING 1`)).length;
          const keyMatch = sql.raw(t.key.map(k => `x.${k} = (r.doc_row->>'${k}')`).join(' AND '));
          const compared = rowsOf(await tx.execute(sql`
            SELECT count(*) FILTER (WHERE to_jsonb(x) - 'pdf' = r.doc_row - 'pdf') AS same, count(*) AS found
            FROM jsonb_array_elements(${doc}::jsonb) AS r(doc_row) JOIN ${name} x ON ${keyMatch}`))[0];
          const different = Number(compared.found) - Number(compared.same);
          result.tables.push({ name: t.name, rows: total, inserted, alreadyPresent: total - inserted, different });
          if (Number(compared.found) !== total) result.problems.push(`${t.name}: ${total - Number(compared.found)} rows are not in the target after the restore`);
          if (different) result.problems.push(`${t.name}: ${different} rows in the target differ from the bundle`);
        }
      }
      if (opts.dryRun || result.problems.length) throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }

  // Raw-data files go back to the blob store only for a real restore, each checked before it becomes visible.
  if (!opts.dryRun && result.problems.length === verified.problems.length) {
    const target = opts.blobTarget ?? blobDir();
    for (const f of manifest.files.filter(f => f.path.startsWith('blobs/'))) {
      const hash = f.path.slice('blobs/'.length);
      const present = await verifyBlob(target, hash);
      if (present.ok) { result.blobs.present++; continue; }
      await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
      const data = await fs.promises.readFile(path.join(dir, f.path));
      if (sha256(data) !== hash) { result.problems.push(`${f.path}: content does not match its name`); continue; }
      const temp = path.join(target, `restore-${randomBytes(6).toString('hex')}.part`);
      await fs.promises.writeFile(temp, data, { mode: 0o444 });
      await fs.promises.rename(temp, blobPath(target, hash));
      result.blobs.restored++;
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** The chain stays whole after archiving: a convenience for the evidence and the tests. */
export async function chainStillVerifies(db: Db) {
  const r = await verifyAuditChain(db, { writeCheckpoints: false });
  return { valid: r.isValid, entries: r.totalRecords, compromisedSequence: r.compromisedSequence };
}

// ---- the 423 guard ---------------------------------------------------------------------------------------------------------------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The archived record a write request addresses, from its path (relative to /api), or null. Creating routes (POST /samples) address none. */
export function archivedTargets(method: string, p: string): Array<{ entityType: string; entityId: string; viaResultVersion?: boolean }> {
  if (!MUTATING.has(method)) return [];
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
  const [head, id, sub] = seg;
  if (!id) return [];
  switch (head) {
    case 'batches': return [{ entityType: 'ProductBatch', entityId: id }];
    case 'samples': return id === 'bulk-import' ? [] : [{ entityType: 'Sample', entityId: id }];
    case 'coa': return id === 'documents' && sub ? [{ entityType: 'CoaDocument', entityId: sub }] : [{ entityType: 'Sample', entityId: id }];
    case 'custody': return id === 'samples' && sub ? [{ entityType: 'Sample', entityId: sub }] : [];
    case 'result-versions': return [{ entityType: 'Sample', entityId: id, viaResultVersion: true }];
    default: return [];
  }
}

/** Mounted after the authorisation layer (src/server/app.ts). An archived record is read-only: a write answers 423 before its handler runs. */
export function archivedRecordGuard(db: Db) {
  return asyncHandler(async function archivedRecord(req: Request, _res: Response, next: NextFunction) {
    for (const t of archivedTargets(req.method, req.path)) {
      let entityId = t.entityId;
      if (t.viaResultVersion) {
        const [rv] = rowsOf(await db.execute(sql`SELECT sample_id FROM result_versions WHERE id = ${entityId}`));
        if (!rv) continue;
        entityId = rv.sample_id;
      }
      const hit = await archivedEntry(db, t.entityType, entityId);
      if (hit) {
        throw new AppError(423, 'ARCHIVED_RECORD', `${t.entityType} ${entityId} is archived (bundle ${hit.bundleId}) and read-only.`, { entityType: t.entityType, entityId, bundleId: hit.bundleId });
      }
    }
    next();
  });
}
