/**
 * The custody ledger and the label log (roadmap M29): two hash-linked, append-only tables.
 *
 *   custody_events  one row per movement of a container: receipt, aliquot out of the parent and into the child, transfer of place or
 *                   holder, consumption, retain registration, disposal. Each row carries the container's balance after it.
 *   label_prints    one row per label print or reprint.
 *
 * A row's hash is SHA-256 over its canonical JSON (every column but the hash, quantities as 4-decimal text, the time as ISO text)
 * followed by the previous row's hash (the genesis value for the first). Rows are numbered from a counter (`nextSequence`), whose row
 * lock is held to the end of the transaction, so concurrent writers append one after the other and the chain cannot fork; the number
 * is gap-free because a rolled-back transaction gives its number back. The database refuses UPDATE, DELETE and TRUNCATE on both
 * tables and checks the balance arithmetic of every ledger row (src/db/protections/custody.ts). `verifyChains` recomputes both
 * chains, and the balances, so a row changed behind the triggers (by someone able to disable them) is found.
 *
 * The hash is unkeyed, so someone who can rewrite the database can also rewrite the chain; each ledger row's hash is therefore copied
 * into the audit entry of the same transaction, and the audit trail is keyed (src/server/audit/hash.ts).
 *
 * Quantities are exact: they are held as integers of 1/10,000 of the unit (numeric(14, 4) in the database), never as floats.
 */
import { createHash } from 'crypto';
import { asc, desc, eq, gt } from 'drizzle-orm';
import { custodyEvents, labelPrints } from '../../db/schema/custody';
import { nextSequence, type Executor } from '../core/tx';

export const GENESIS = '0'.repeat(64);
const SCALE = 10_000n;

/** A quantity as integer ten-thousandths, from a number with at most 4 decimals or the database's numeric text. */
export function toUnits(q: number | string): bigint {
  if (typeof q === 'number') return BigInt(Math.round(q * 10_000));
  const m = /^(-?)(\d+)(?:\.(\d{1,4})\d*)?$/.exec(q.trim());
  if (!m) throw new Error(`Not a quantity: ${q}`);
  const units = BigInt(m[2]) * SCALE + BigInt((m[3] ?? '').padEnd(4, '0'));
  return m[1] ? -units : units;
}

/** The text form the database stores (numeric(14, 4)): 20 -> "20.0000", -5.5 -> "-5.5000". */
export function unitsText(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / SCALE}.${(a % SCALE).toString().padStart(4, '0')}`;
}

export const unitsNumber = (u: bigint): number => Number(unitsText(u));
export const quantityNumber = (q: string | number): number => unitsNumber(toUnits(q));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type CustodyEventRow = typeof custodyEvents.$inferSelect;
export type LabelPrintRow = typeof labelPrints.$inferSelect;

function eventContent(e: Omit<CustodyEventRow, 'hash'>) {
  return {
    id: e.id, seq: e.seq, containerId: e.containerId, sampleId: e.sampleId, eventType: e.eventType,
    qtyDelta: unitsText(toUnits(e.qtyDelta)), balanceAfter: unitsText(toUnits(e.balanceAfter)), unit: e.unit,
    fromLocationId: e.fromLocationId ?? null, toLocationId: e.toLocationId ?? null, fromHolderId: e.fromHolderId ?? null,
    toHolderId: e.toHolderId ?? null, relatedContainerId: e.relatedContainerId ?? null, reason: e.reason, actorId: e.actorId,
    at: new Date(e.at).toISOString(), prevHash: e.prevHash,
  };
}
export const eventHash = (e: Omit<CustodyEventRow, 'hash'>) => sha256(JSON.stringify(eventContent(e)) + e.prevHash);

function printContent(p: Omit<LabelPrintRow, 'hash'>) {
  return {
    id: p.id, seq: p.seq, entityType: p.entityType, entityId: p.entityId, code: p.code, symbology: p.symbology, copies: p.copies,
    isReprint: p.isReprint, reason: p.reason ?? null, printedBy: p.printedBy, printedAt: new Date(p.printedAt).toISOString(), prevHash: p.prevHash,
  };
}
export const printHash = (p: Omit<LabelPrintRow, 'hash'>) => sha256(JSON.stringify(printContent(p)) + p.prevHash);

export interface NewEvent {
  containerId: string;
  sampleId: string;
  eventType: 'Receipt' | 'Aliquot out' | 'Aliquot in' | 'Transfer' | 'Consume' | 'Retain' | 'Dispose';
  /** Change of the container's quantity, in units (negative out of it). */
  delta: bigint;
  /** The container's balance before this event, in units: the caller holds the container's row lock. */
  balanceBefore: bigint;
  unit: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  fromHolderId?: string | null;
  toHolderId?: string | null;
  relatedContainerId?: string | null;
  reason: string;
  actorId: string;
}

export class NegativeBalanceError extends Error {}

/** Appends one ledger row inside the caller's transaction. The caller has locked the container. */
export async function appendEvent(tx: Executor, e: NewEvent): Promise<CustodyEventRow> {
  const after = e.balanceBefore + e.delta;
  if (after < 0n) throw new NegativeBalanceError(`The balance of ${e.containerId} would go below zero.`);
  const seq = await nextSequence(tx, 'custody_event');
  const [last] = await tx.select({ hash: custodyEvents.hash }).from(custodyEvents).orderBy(desc(custodyEvents.seq)).limit(1);
  const row: Omit<CustodyEventRow, 'hash'> = {
    id: `CE-${String(seq).padStart(9, '0')}`, seq, containerId: e.containerId, sampleId: e.sampleId, eventType: e.eventType,
    qtyDelta: unitsText(e.delta), balanceAfter: unitsText(after), unit: e.unit,
    fromLocationId: e.fromLocationId ?? null, toLocationId: e.toLocationId ?? null, fromHolderId: e.fromHolderId ?? null,
    toHolderId: e.toHolderId ?? null, relatedContainerId: e.relatedContainerId ?? null, reason: e.reason, actorId: e.actorId,
    at: new Date(), prevHash: last?.hash ?? GENESIS,
  };
  const full = { ...row, hash: eventHash(row) };
  await tx.insert(custodyEvents).values(full);
  return full;
}

/** Appends one label-log row inside the caller's transaction; `isReprint` is decided under the counter's lock. */
export async function appendPrint(tx: Executor, p: Omit<LabelPrintRow, 'id' | 'seq' | 'prevHash' | 'hash' | 'printedAt' | 'isReprint'>,
  isReprint: (tx: Executor) => Promise<boolean>): Promise<LabelPrintRow> {
  const seq = await nextSequence(tx, 'label_print');
  const reprint = await isReprint(tx);
  const [last] = await tx.select({ hash: labelPrints.hash }).from(labelPrints).orderBy(desc(labelPrints.seq)).limit(1);
  const row: Omit<LabelPrintRow, 'hash'> = {
    ...p, id: `LBL-${String(seq).padStart(9, '0')}`, seq, isReprint: reprint, printedAt: new Date(), prevHash: last?.hash ?? GENESIS,
  };
  const full = { ...row, hash: printHash(row) };
  await tx.insert(labelPrints).values(full);
  return full;
}

export interface ChainCheck { valid: boolean; count: number; brokenAt: number | null; problem: string | null }

const BATCH = 2000;

async function walk<T extends { seq: number; prevHash: string; hash: string }>(
  read: (afterSeq: number) => Promise<T[]>, hashOf: (row: T) => string, extra?: (row: T) => string | null,
): Promise<ChainCheck> {
  let prev = GENESIS;
  let expectedSeq = 1;
  let count = 0;
  for (let after = 0; ;) {
    const rows = await read(after);
    if (rows.length === 0) break;
    for (const row of rows) {
      count++;
      const fail = (problem: string): ChainCheck => ({ valid: false, count, brokenAt: row.seq, problem });
      if (row.seq !== expectedSeq) return fail(`row ${expectedSeq} is missing`);
      if (row.prevHash !== prev) return fail('the link to the previous row is broken');
      if (hashOf(row) !== row.hash) return fail('the row does not match its hash');
      const other = extra?.(row);
      if (other) return fail(other);
      prev = row.hash;
      expectedSeq++;
    }
    after = rows[rows.length - 1].seq;
  }
  return { valid: true, count, brokenAt: null, problem: null };
}

/** Recomputes the ledger (links, hashes, balances) and the label log from the first row. */
export async function verifyChains(ex: Executor): Promise<{ ledger: ChainCheck; labels: ChainCheck }> {
  const balances = new Map<string, bigint>();
  const ledger = await walk<CustodyEventRow>(
    (after) => ex.select().from(custodyEvents).where(gt(custodyEvents.seq, after)).orderBy(asc(custodyEvents.seq)).limit(BATCH),
    eventHash,
    (row) => {
      const before = balances.get(row.containerId) ?? 0n;
      const after = before + toUnits(row.qtyDelta);
      if (after !== toUnits(row.balanceAfter) || after < 0n) return `the balance of ${row.containerId} does not follow from its ledger`;
      balances.set(row.containerId, after);
      return null;
    },
  );
  const labels = await walk<LabelPrintRow>(
    (after) => ex.select().from(labelPrints).where(gt(labelPrints.seq, after)).orderBy(asc(labelPrints.seq)).limit(BATCH),
    printHash,
    (row) => (row.isReprint && (row.reason ?? '').trim().length < 5 ? 'a reprint without its reason' : null),
  );
  return { ledger, labels };
}

/** The ledger of one sample, in order. */
export const eventsOfSample = (ex: Executor, sampleId: string) =>
  ex.select().from(custodyEvents).where(eq(custodyEvents.sampleId, sampleId)).orderBy(asc(custodyEvents.seq));
