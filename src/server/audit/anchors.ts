/**
 * Daily anchors of the audit chain (roadmap M35, Annex 11 s.9, 21 CFR 11.10(e)). r2-audit-tamper owns this file.
 *
 * The chain verifier can only check the chain against itself: someone with the database owner's rights who rewrites a row and
 * re-hashes every row after it gets a chain that verifies. An anchor is a witness outside the database: a small JSON file on a second
 * path (the backup mirror by default) with the head of the audit chain (sequence, hash, seal, algorithm) and of the security-event
 * chain, signed with an HMAC key derived from the keystore (purpose audit-hmac, label anchor). The key is not in the database, so an
 * edited file fails its HMAC, and a rewritten database no longer matches the files.
 *
 *   file      <dir>/audit-anchor-<UTC time>-<sequence>.json, written atomically and made read-only
 *   register  audit_anchors (append-only): which files were written, so a file that disappears is noticed
 *   verify    every file of this database: HMAC, then the row at the anchored sequence must still have the anchored hash and seal;
 *             a head below an anchored sequence is TRUNCATED. A mismatch writes AUDIT_ANCHOR_MISMATCH (and, with an actor, opens a
 *             deviation through the QMS: source audit-chain-broken).
 *
 * Where (anchorDirectory): AUDIT_ANCHOR_DIR, else <BACKUP_MIRROR_DIR>/audit-anchors, else <BACKUP_DIR>/audit-anchors (the same disk
 * as the database: reported as not a second path), else nowhere, and writing an anchor fails with a message that says so.
 */
import fs from 'fs';
import path from 'path';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { auditTrail, securityEvents } from '../../db/schema';
import { auditAnchors } from '../../db/schema/audit-review';
import type { Db } from '../core/context';
import { withTransaction } from '../core/tx';
import { getKeystore } from '../crypto/keystore';
import { AppError } from '../http/errors';
import { autoOpenQmsRecord } from '../qms/autoOpen';
import { recordSecurityEvent, writeSecurityEvent } from './securityEvents';

export const ANCHOR_KIND = 'bplims-audit-anchor';
const FILE_PATTERN = /^audit-anchor-[0-9TZ-]+-\d+\.json$/;

export interface AnchorContent {
  kind: typeof ANCHOR_KIND;
  v: 1;
  database: string;
  sequence: number;
  hash: string;
  seal: string | null;
  hashAlg: string;
  securityEvents: { sequence: number; hash: string | null };
  anchoredAt: string;
  keyGeneration: number;
}
export interface AnchorFile extends AnchorContent { hmac: string }

export type AnchorFailureReason = 'HMAC_INVALID' | 'UNREADABLE' | 'KEY_UNAVAILABLE' | 'ROW_MISSING' | 'HASH_MISMATCH' | 'SECURITY_HASH_MISMATCH' | 'TRUNCATED' | 'FILE_MISSING';
export interface AnchorFailure { file: string; sequence: number | null; reason: AnchorFailureReason }
export interface AnchorVerification {
  isValid: boolean;
  anchorsChecked: number;
  latest: { sequence: number; anchoredAt: string; file: string } | null;
  headSequence: number;
  failures: AnchorFailure[];
}

export function anchorDirectory(env: Record<string, string | undefined> = process.env): { dir: string | null; secondPath: boolean } {
  if (env.AUDIT_ANCHOR_DIR) return { dir: env.AUDIT_ANCHOR_DIR, secondPath: true };
  if (env.BACKUP_MIRROR_DIR) return { dir: path.join(env.BACKUP_MIRROR_DIR, 'audit-anchors'), secondPath: true };
  if (env.BACKUP_DIR) return { dir: path.join(env.BACKUP_DIR, 'audit-anchors'), secondPath: false };
  return { dir: null, secondPath: false };
}

/** The signed text: the content's fields in a fixed order. */
const canonical = (c: AnchorContent) => JSON.stringify({
  kind: c.kind, v: c.v, database: c.database, sequence: c.sequence, hash: c.hash, seal: c.seal, hashAlg: c.hashAlg,
  securityEvents: { sequence: c.securityEvents.sequence, hash: c.securityEvents.hash }, anchoredAt: c.anchoredAt, keyGeneration: c.keyGeneration,
});
const hmacOf = (c: AnchorContent) => createHmac('sha256', getKeystore().deriveKey('audit-hmac', 'anchor', c.keyGeneration)).update(canonical(c)).digest('hex');

async function databaseName(db: Db): Promise<string> {
  const r: any = await db.execute(sql`select current_database() as name`);
  return (r.rows ?? r)[0].name;
}

const notConfigured = () => new AppError(400, 'ANCHOR_DIR_NOT_SET',
  'No folder for audit anchors is configured: set AUDIT_ANCHOR_DIR (or BACKUP_MIRROR_DIR, the second copy of the backups).');

export interface WriteAnchorOptions {
  dir: string | null;
  /** Who writes it: the user who asked, or the job's owner. */
  actorId: string;
  /** Record the file in audit_anchors with an AUDIT_ANCHOR security event (default true). */
  register?: boolean;
  now?: Date;
}

/** Writes an anchor of the current heads. The file is written first; the register row and the security event commit together after it. */
export async function writeAnchor(db: Db, o: WriteAnchorOptions): Promise<{ file: string; anchor: typeof auditAnchors.$inferSelect | (AnchorFile & { fileName: string }) }> {
  if (!o.dir) throw notConfigured();
  const [head] = await db.select({ sequence: auditTrail.sequence, hash: auditTrail.hash, seal: auditTrail.seal, hashAlg: auditTrail.hashAlg })
    .from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
  if (!head) throw new AppError(409, 'NOTHING_TO_ANCHOR', 'The audit trail is empty: there is nothing to anchor yet.');
  const [sec] = await db.select({ sequence: securityEvents.sequence, hash: securityEvents.hash }).from(securityEvents).orderBy(desc(securityEvents.sequence)).limit(1);

  const at = o.now ?? new Date();
  const content: AnchorContent = {
    kind: ANCHOR_KIND, v: 1, database: await databaseName(db), sequence: head.sequence, hash: head.hash, seal: head.seal ?? null, hashAlg: head.hashAlg,
    securityEvents: { sequence: sec?.sequence ?? 0, hash: sec?.hash ?? null }, anchoredAt: at.toISOString(), keyGeneration: getKeystore().current,
  };
  const file: AnchorFile = { ...content, hmac: hmacOf(content) };
  const fileName = `audit-anchor-${content.anchoredAt.replace(/[:.]/g, '')}-${String(head.sequence).padStart(9, '0')}.json`;

  fs.mkdirSync(o.dir, { recursive: true });
  const target = path.join(o.dir, fileName);
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o444); } catch { /* best effort: the HMAC, not the file mode, is the protection */ }

  if (o.register === false) return { file: target, anchor: { ...file, fileName } };
  const row = await withTransaction(db, async tx => {
    const [stored] = await tx.insert(auditAnchors).values({
      id: `AN-${randomBytes(6).toString('hex')}`, sequence: head.sequence, hash: head.hash, seal: head.seal ?? null,
      securitySequence: content.securityEvents.sequence, securityHash: content.securityEvents.hash, anchoredAt: at, fileName,
      keyGeneration: content.keyGeneration, hmac: file.hmac, createdBy: o.actorId,
    }).returning();
    await writeSecurityEvent(tx, { type: 'AUDIT_ANCHOR', outcome: 'success', actorId: o.actorId, detail: { sequence: head.sequence, file: fileName, directory: o.dir } });
    return stored;
  });
  return { file: target, anchor: row };
}

function readAnchorFile(full: string): AnchorFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (parsed?.kind !== ANCHOR_KIND || parsed.v !== 1 || !Number.isInteger(parsed.sequence) || typeof parsed.hmac !== 'string') return null;
    return parsed as AnchorFile;
  } catch { return null; }
}

function hmacMatches(f: AnchorFile): boolean | 'KEY_UNAVAILABLE' {
  let expected: string;
  try { expected = hmacOf(f); } catch { return 'KEY_UNAVAILABLE'; }
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(f.hmac, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export interface VerifyAnchorOptions {
  dir: string | null;
  /** Compare the files with the register (default true): a registered file that is gone is FILE_MISSING. */
  register?: boolean;
  /** Write the outcome as a security event (default true): AUDIT_ANCHOR_MISMATCH on a failure, AUDIT_ANCHOR_VERIFY otherwise. */
  record?: boolean;
  /** Who asked; with an actor, a mismatch also opens a deviation (QMS, source audit-chain-broken). */
  actorId?: string | null;
}

export async function verifyAnchors(db: Db, o: VerifyAnchorOptions): Promise<AnchorVerification> {
  if (!o.dir) throw notConfigured();
  const database = await databaseName(db);
  const names = fs.existsSync(o.dir) ? fs.readdirSync(o.dir).filter(n => FILE_PATTERN.test(n)).sort() : [];
  const [head] = await db.select({ sequence: auditTrail.sequence }).from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
  const [secHead] = await db.select({ sequence: securityEvents.sequence }).from(securityEvents).orderBy(desc(securityEvents.sequence)).limit(1);
  const headSequence = head?.sequence ?? 0;

  const failures: AnchorFailure[] = [];
  let checked = 0;
  let latest: AnchorVerification['latest'] = null;
  for (const name of names) {
    const f = readAnchorFile(path.join(o.dir, name));
    if (!f) { failures.push({ file: name, sequence: null, reason: 'UNREADABLE' }); continue; }
    if (f.database !== database) continue; // a folder shared by several installations: not this database's anchor
    checked++;
    const mac = hmacMatches(f);
    if (mac !== true) { failures.push({ file: name, sequence: f.sequence, reason: mac === false ? 'HMAC_INVALID' : mac }); continue; }

    let reason: AnchorFailureReason | null = null;
    if (f.sequence > headSequence) reason = 'TRUNCATED';
    else {
      const [row] = await db.select({ hash: auditTrail.hash, seal: auditTrail.seal }).from(auditTrail).where(eq(auditTrail.sequence, f.sequence)).limit(1);
      if (!row) reason = 'ROW_MISSING';
      else if (row.hash !== f.hash || (row.seal ?? null) !== (f.seal ?? null)) reason = 'HASH_MISMATCH';
    }
    if (!reason && f.securityEvents?.sequence > 0) {
      if (f.securityEvents.sequence > (secHead?.sequence ?? 0)) reason = 'TRUNCATED';
      else {
        const [ev] = await db.select({ hash: securityEvents.hash }).from(securityEvents).where(eq(securityEvents.sequence, f.securityEvents.sequence)).limit(1);
        if (!ev || ev.hash !== f.securityEvents.hash) reason = 'SECURITY_HASH_MISMATCH';
      }
    }
    if (reason) failures.push({ file: name, sequence: f.sequence, reason });
    else if (!latest || f.sequence >= latest.sequence) latest = { sequence: f.sequence, anchoredAt: f.anchoredAt, file: name };
  }

  if (o.register !== false) {
    const present = new Set(names);
    for (const r of await db.select({ fileName: auditAnchors.fileName, sequence: auditAnchors.sequence }).from(auditAnchors).orderBy(auditAnchors.sequence)) {
      if (!present.has(r.fileName)) failures.push({ file: r.fileName, sequence: r.sequence, reason: 'FILE_MISSING' });
    }
  }

  const result: AnchorVerification = { isValid: failures.length === 0, anchorsChecked: checked, latest, headSequence, failures };
  if (o.record !== false) await recordOutcome(db, result, o);
  return result;
}

async function recordOutcome(db: Db, v: AnchorVerification, o: VerifyAnchorOptions) {
  const detail = { anchorsChecked: v.anchorsChecked, headSequence: v.headSequence, latest: v.latest?.sequence ?? null, failures: v.failures.slice(0, 20), directory: o.dir };
  if (v.isValid) {
    await recordSecurityEvent(db, { type: 'AUDIT_ANCHOR_VERIFY', outcome: 'success', actorId: o.actorId ?? null, detail });
    return;
  }
  await withTransaction(db, async tx => {
    if (o.actorId) {
      const first = v.failures[0];
      await autoOpenQmsRecord(tx, {
        source: 'audit-chain-broken', sourceId: `anchor:${first.file}`, actorId: o.actorId, classification: 'Critical',
        title: `Audit trail does not match its anchor (${first.reason}, sequence ${first.sequence ?? 'unknown'})`,
        description: `The anchor verification found ${v.failures.length} problem(s): ${v.failures.slice(0, 5).map(f => `${f.file} ${f.reason}`).join('; ')}.`,
      });
    }
    await writeSecurityEvent(tx, { type: 'AUDIT_ANCHOR_MISMATCH', outcome: 'failure', actorId: o.actorId ?? null, detail });
  });
}

/**
 * The start-up check of the chain tail against the anchors. Never stops the start (the records must stay readable for the
 * investigation); a mismatch is logged as an error and written as AUDIT_ANCHOR_MISMATCH.
 */
export async function startupAnchorCheck(db: Db, o: { env?: Record<string, string | undefined>; log?: (m: string) => void } = {}): Promise<AnchorVerification | null> {
  const log = o.log ?? ((m: string) => console.log(m));
  const { dir } = anchorDirectory(o.env ?? process.env);
  if (!dir) { log('WARNING Audit anchors: no folder is configured (AUDIT_ANCHOR_DIR or BACKUP_MIRROR_DIR); the chain is not checked against an outside witness.'); return null; }
  try {
    const v = await verifyAnchors(db, { dir });
    if (v.isValid) log(`Audit anchors: ${v.anchorsChecked} checked, the audit trail matches${v.latest ? ` (latest at sequence ${v.latest.sequence})` : ''}.`);
    else log(`ERROR Audit anchors: the audit trail does NOT match its anchors: ${v.failures.slice(0, 5).map(f => `${f.file} ${f.reason}`).join('; ')}. Inform QA; see the Audit review screen.`);
    return v;
  } catch (err: any) {
    log(`ERROR Audit anchors: the check could not run: ${err?.message ?? err}`);
    return null;
  }
}
