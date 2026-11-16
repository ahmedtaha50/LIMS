import { createHash } from 'node:crypto';
import type { Client, Pool } from '../core/db.js';
import { canonical } from './canonical.js';

export type AuditEntry = {
  actorId: string | null;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  requestId?: string | null;
};
export type StoredAudit = Required<Omit<AuditEntry, 'oldValue' | 'newValue'>> & { id: string; at: string; oldValue: unknown; newValue: unknown; prevHash: string; hash: string };

export const GENESIS = '0'.repeat(64);
/** The chain is one sequence: appends are serialised with this transaction-level lock (released at COMMIT or ROLLBACK). */
const CHAIN_LOCK = 4_100_020;

const hashOf = (prev: string, e: { at: string } & AuditEntry) => createHash('sha256').update(prev + '\n' + canonical({
  at: e.at, actorId: e.actorId, actorName: e.actorName, action: e.action, entity: e.entity, entityId: e.entityId,
  oldValue: e.oldValue ?? null, newValue: e.newValue ?? null, reason: e.reason ?? null, requestId: e.requestId ?? null,
})).digest('hex');

/**
 * Appends an entry INSIDE the caller's transaction: pass the client of withTx, never the pool. If the change rolls back,
 * so does its entry; if the entry cannot be written, the change rolls back with it.
 */
export async function writeAudit(c: Client, e: AuditEntry): Promise<{ id: string; hash: string }> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
  const last = await c.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = last.rows[0]?.hash ?? GENESIS;
  const at = (await c.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  const hash = hashOf(prev, { ...e, at });
  const r = await c.query<{ id: string }>(
    `INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, old_value, new_value, reason, request_id, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [at, e.actorId, e.actorName, e.action, e.entity, e.entityId, e.oldValue === undefined ? null : JSON.stringify(e.oldValue), e.newValue === undefined ? null : JSON.stringify(e.newValue), e.reason ?? null, e.requestId ?? null, prev, hash]);
  return { id: r.rows[0]!.id, hash };
}

type Row = { id: string; at: Date; actor_id: string | null; actor_name: string; action: string; entity: string; entity_id: string; old_value: unknown; new_value: unknown; reason: string | null; request_id: string | null; prev_hash: string; hash: string };
const toEntry = (r: Row): StoredAudit => ({ id: r.id, at: r.at.toISOString(), actorId: r.actor_id, actorName: r.actor_name, action: r.action, entity: r.entity, entityId: r.entity_id, oldValue: r.old_value, newValue: r.new_value, reason: r.reason, requestId: r.request_id, prevHash: r.prev_hash, hash: r.hash });

export async function auditOf(pool: Pool, entity: string, entityId: string): Promise<StoredAudit[]> {
  const r = await pool.query<Row>('SELECT * FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id', [entity, entityId]);
  return r.rows.map(toEntry);
}

export type ChainReport = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: string; why: string };

/** Recomputes the whole chain, in pages. Reports the first entry whose content or link does not match. */
export async function verifyChain(pool: Pool, pageSize = 5000): Promise<ChainReport> {
  let prev = GENESIS, after = '0', n = 0;
  for (;;) {
    const r = await pool.query<Row>('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT $2', [after, pageSize]);
    for (const row of r.rows) {
      const e = toEntry(row);
      if (e.prevHash !== prev) return { ok: false, entries: n, brokenAt: e.id, why: 'the link to the previous entry does not match (an entry was removed or inserted)' };
      const expect = hashOf(prev, { ...e, oldValue: e.oldValue, newValue: e.newValue });
      if (expect !== e.hash) return { ok: false, entries: n, brokenAt: e.id, why: 'the content of this entry was changed after it was written' };
      prev = e.hash; after = e.id; n++;
    }
    if (r.rows.length < pageSize) return { ok: true, entries: n };
  }
}
