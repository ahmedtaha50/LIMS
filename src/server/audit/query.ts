/** Reading the audit trail: filters, keyset pages, and the CSV stream. Nothing here loads the table into memory. */
import { once } from 'events';
import { and, asc, desc, eq, gt, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Response } from 'express';
import { auditTrail } from '../../db/schema';
import type { Db } from '../core/context';

export interface AuditFilter {
  entity?: string; entityId?: string; userId?: string; actorRole?: string; action?: string; from?: string; to?: string;
  /** Records whose history is wanted together (the record itself and the records it is made of). */
  pairs?: Array<{ entity: string; entityId: string }>;
}

export function auditWhere(f: AuditFilter): SQL[] {
  const where: SQL[] = [];
  if (f.entity) where.push(eq(auditTrail.entity, f.entity));
  if (f.entityId) where.push(eq(auditTrail.entityId, f.entityId));
  if (f.userId) where.push(eq(auditTrail.userId, f.userId));
  if (f.actorRole) where.push(eq(auditTrail.actorRole, f.actorRole));
  if (f.action) where.push(eq(auditTrail.action, f.action));
  if (f.from) where.push(gte(auditTrail.timestamp, new Date(f.from)));
  if (f.to) where.push(lte(auditTrail.timestamp, new Date(f.to)));
  if (f.pairs?.length) where.push(or(...f.pairs.map(p => and(eq(auditTrail.entity, p.entity), eq(auditTrail.entityId, p.entityId))))!);
  return where;
}

export interface AuditPage { cursor?: number; limit: number; order: 'asc' | 'desc' }

/**
 * One page. `cursor` is the sequence of the last row of the previous page: newest-first pages continue below it, oldest-first
 * pages above it, so rows added meanwhile never shift a page (unlike OFFSET).
 */
export async function queryAudit(db: Db, f: AuditFilter, p: AuditPage) {
  const where = auditWhere(f);
  if (p.cursor !== undefined) where.push(p.order === 'desc' ? lt(auditTrail.sequence, p.cursor) : gt(auditTrail.sequence, p.cursor));
  const rows = await db.select().from(auditTrail).where(and(...where))
    .orderBy(p.order === 'desc' ? desc(auditTrail.sequence) : asc(auditTrail.sequence)).limit(p.limit + 1);
  const hasMore = rows.length > p.limit;
  const entries = hasMore ? rows.slice(0, p.limit) : rows;
  return { entries, hasMore, nextCursor: hasMore ? entries[entries.length - 1].sequence : null };
}

export const CSV_COLUMNS = ['sequence', 'timestamp', 'user_id', 'actor_name', 'actor_role', 'session_id', 'app_version', 'action', 'entity', 'entity_id', 'field', 'old_value', 'new_value', 'reason', 'hash_version', 'hash_alg', 'hash', 'prev_hash', 'seal'] as const;

/** One CSV cell. A text that starts with = + - @ (or a tab or return) would run as a formula in a spreadsheet: it is prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type AuditRow = typeof auditTrail.$inferSelect;
const csvLine = (r: AuditRow) => [
  r.sequence, r.timestampStr ?? r.timestamp.toISOString(), r.userId, r.actorName, r.actorRole, r.sessionId, r.appVersion, r.action, r.entity, r.entityId,
  r.field, r.oldValue, r.newValue, r.reason, r.hashVersion, r.hashAlg, r.hash, r.prevHash, r.seal,
].map(csvCell).join(',') + '\r\n';

/**
 * Writes the matching rows up to `throughSequence`, oldest first (chain order), to the response in batches, waiting for the
 * socket to drain so memory stays flat however large the export is. Stops quietly if the client goes away.
 */
export async function streamAuditCsv(db: Db, f: AuditFilter, throughSequence: number, res: Response, batch = 1000): Promise<number> {
  res.write(CSV_COLUMNS.join(',') + '\r\n');
  let last = 0, written = 0;
  for (;;) {
    const rows = await db.select().from(auditTrail)
      .where(and(...auditWhere(f), gt(auditTrail.sequence, last), lte(auditTrail.sequence, throughSequence)))
      .orderBy(asc(auditTrail.sequence)).limit(batch);
    if (rows.length === 0) return written;
    if (res.destroyed || res.writableEnded) return written;
    if (!res.write(rows.map(csvLine).join(''))) await once(res, 'drain');
    written += rows.length;
    last = rows[rows.length - 1].sequence;
  }
}
