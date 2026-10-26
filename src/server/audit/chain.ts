/**
 * The one audit-chain verifier (roadmap M08). The loop used to be copied into five places and each copy read the whole table.
 *
 *   verifyAuditRows       a list in memory (a backup, an export); pure
 *   verifyAuditChain      the whole chain in keyset batches, from the first row; also records the checkpoints it has proven
 *   verifyAuditChainTo    the chain up to one entry, starting at the nearest checkpoint: what a signature check needs
 *
 * Memory is bounded by the batch size whatever the table holds. A checkpoint is a (sequence, hash, seal) triple kept in the
 * append-only audit_checkpoints table; bounded verification trusts the chain up to a checkpoint only after confirming that the
 * audit row at that sequence still has the hash and seal the checkpoint recorded. The full verification never skips anything,
 * and is what proves the part before a checkpoint.
 */
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { auditCheckpoints, auditTrail } from '../../db/schema';
import type { Db } from '../core/context';
import { CHECKPOINT_INTERVAL, checkRow, isKeyedAlg, nextTail, normalizeAuditRow, type AuditRecord, type ChainTail, type FailureReason } from './hash';

export { CHECKPOINT_INTERVAL };
export type { FailureReason };

const DEFAULT_BATCH = 2000;

export interface RowsVerification { isValid: boolean; compromisedSequence: number | null; reason: FailureReason | null }

/** Verifies rows already in memory, in any order and in either column naming. */
export function verifyAuditRows(rows: any[]): RowsVerification {
  let prev: ChainTail | null = null;
  const sorted = rows.map(normalizeAuditRow).sort((a, b) => a.sequence - b.sequence);
  for (const r of sorted) {
    const reason = checkRow(r, prev);
    if (reason) return { isValid: false, compromisedSequence: r.sequence, reason };
    prev = nextTail(r, prev);
  }
  return { isValid: true, compromisedSequence: null, reason: null };
}

export interface FullVerification extends RowsVerification {
  /** Rows examined (all of them when the chain is valid). */
  totalRecords: number;
  headSequence: number;
  headHash: string | null;
  /** Rows per hash_version. */
  versions: Record<number, number>;
  /** Checkpoints newly recorded by this run. */
  checkpointsAdded: number;
}

export interface FullOptions {
  batchSize?: number;
  /** Record a checkpoint for every multiple of checkpointEvery proven by this run (default true). */
  writeCheckpoints?: boolean;
  checkpointEvery?: number;
}

export async function verifyAuditChain(db: Db, options: FullOptions = {}): Promise<FullVerification> {
  const batch = options.batchSize ?? DEFAULT_BATCH;
  const every = options.checkpointEvery ?? CHECKPOINT_INTERVAL;
  const write = options.writeCheckpoints ?? true;

  const [head] = await db.select({ sequence: auditTrail.sequence, hash: auditTrail.hash }).from(auditTrail).orderBy(desc(auditTrail.sequence)).limit(1);
  const headSequence = head?.sequence ?? 0;
  const stored = new Map((await db.select().from(auditCheckpoints)).map(c => [c.sequence, c]));

  const result: FullVerification = { isValid: true, compromisedSequence: null, reason: null, totalRecords: 0, headSequence, headHash: head?.hash ?? null, versions: {}, checkpointsAdded: 0 };
  let prev: ChainTail | null = null;
  let last = 0;
  let pending: Array<{ sequence: number; hash: string; seal: string | null }> = [];

  const flush = async () => {
    if (write && pending.length) {
      const inserted = await db.insert(auditCheckpoints).values(pending).onConflictDoNothing().returning({ sequence: auditCheckpoints.sequence });
      result.checkpointsAdded += inserted.length;
    }
    pending = [];
  };

  scan:
  while (last < headSequence) {
    const rows = await db.select().from(auditTrail)
      .where(and(gt(auditTrail.sequence, last), lte(auditTrail.sequence, headSequence)))
      .orderBy(asc(auditTrail.sequence)).limit(batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      const r = normalizeAuditRow(row);
      result.totalRecords++;
      let reason: FailureReason | null = checkRow(r, prev);
      if (!reason && r.sequence % every === 0) {
        const cp = stored.get(r.sequence);
        if (cp) {
          if (cp.hash !== r.hash || (cp.seal ?? null) !== r.seal) reason = 'CHECKPOINT_MISMATCH';
        } else {
          pending.push({ sequence: r.sequence, hash: r.hash, seal: r.seal });
        }
      }
      if (reason) {
        result.isValid = false; result.compromisedSequence = r.sequence; result.reason = reason;
        break scan;
      }
      result.versions[r.hashVersion] = (result.versions[r.hashVersion] ?? 0) + 1;
      prev = nextTail(r, prev);
      last = r.sequence;
    }
    await flush();
  }
  await flush(); // the verified prefix keeps its checkpoints even when the chain breaks further on
  return result;
}

export interface BoundedVerification extends RowsVerification {
  startedFrom: 'genesis' | 'checkpoint';
  checkpointSequence: number | null;
  rowsChecked: number;
  verifiedThrough: number | null;
}

/** Verifies the chain from the nearest checkpoint at or below the entry, through the entry. `target` is the entry's sequence or id. */
export async function verifyAuditChainTo(db: Db, target: { sequence?: number; id?: string }, options: { batchSize?: number } = {}): Promise<BoundedVerification> {
  const batch = options.batchSize ?? DEFAULT_BATCH;
  const notFound: BoundedVerification = { isValid: false, compromisedSequence: null, reason: 'ENTRY_NOT_FOUND', startedFrom: 'genesis', checkpointSequence: null, rowsChecked: 0, verifiedThrough: null };

  const [entry] = await db.select({ sequence: auditTrail.sequence }).from(auditTrail)
    .where(target.id !== undefined ? eq(auditTrail.id, target.id) : eq(auditTrail.sequence, target.sequence ?? -1)).limit(1);
  if (!entry) return notFound;
  const through = entry.sequence;

  const [cp] = await db.select().from(auditCheckpoints).where(lte(auditCheckpoints.sequence, through)).orderBy(desc(auditCheckpoints.sequence)).limit(1);
  let prev: ChainTail | null = null;
  let last = 0;
  if (cp) {
    const [row] = await db.select({ hash: auditTrail.hash, seal: auditTrail.seal, hashAlg: auditTrail.hashAlg }).from(auditTrail).where(eq(auditTrail.sequence, cp.sequence)).limit(1);
    if (!row || row.hash !== cp.hash || (row.seal ?? null) !== (cp.seal ?? null)) {
      return { isValid: false, compromisedSequence: cp.sequence, reason: 'CHECKPOINT_MISMATCH', startedFrom: 'checkpoint', checkpointSequence: cp.sequence, rowsChecked: 0, verifiedThrough: null };
    }
    // From a checkpoint, a downgrade is caught from the first keyed row on (the full verification checks the part before it).
    prev = { hash: cp.hash, seal: cp.seal ?? null, keyed: isKeyedAlg(row.hashAlg) };
    last = cp.sequence;
  }

  const result: BoundedVerification = { isValid: true, compromisedSequence: null, reason: null, startedFrom: cp ? 'checkpoint' : 'genesis', checkpointSequence: cp?.sequence ?? null, rowsChecked: 0, verifiedThrough: through };
  while (last < through) {
    const rows = await db.select().from(auditTrail)
      .where(and(gt(auditTrail.sequence, last), lte(auditTrail.sequence, through)))
      .orderBy(asc(auditTrail.sequence)).limit(batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      const r: AuditRecord = normalizeAuditRow(row);
      const reason = checkRow(r, prev);
      result.rowsChecked++;
      if (reason) return { ...result, isValid: false, compromisedSequence: r.sequence, reason, verifiedThrough: null };
      prev = nextTail(r, prev);
      last = r.sequence;
    }
  }
  return result;
}
