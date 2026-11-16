import type { Client, Pool } from '../core/db.js';
import { HttpError } from '../core/errors.js';
import type { Definition } from '../logbook/definition.js';
import { logbookDetail } from '../logbook/service.js';

/**
 * The interlock between a batch and the logbooks (E13): equipment or a room is used only when its logbook says it may be,
 * and its use is written into that logbook by the system, signed with the operator's step signature.
 */
type Lb = { id: string; type_id: string; object_code: string; name: string; status: string };

/** Locks the logbook row, so two batches cannot take the same equipment at the same moment. */
export async function lockFor(c: Client, kind: 'equipment' | 'room', code: string): Promise<Lb> {
  const lb = (await c.query<Lb>('SELECT id, type_id, object_code, name, status FROM logbooks WHERE object_kind = $1 AND lower(object_code) = lower($2) FOR UPDATE', [kind, code])).rows[0];
  if (!lb) throw new HttpError(404, 'no_logbook', `There is no logbook for ${kind} ${code}: it cannot be used.`);
  if (lb.status !== 'active') throw new HttpError(409, 'equipment_retired', `${kind} ${code} is retired.`);
  return lb;
}

/** E13#1: only clean (and, through the derived status, calibrated) equipment may start a batch step. */
export async function assertReady(pool: Pool, lb: Lb) {
  const d = await logbookDetail(pool, lb.id);
  if (d.derived.status !== 'clean') {
    const why = d.derived.reasons.length ? ` (${d.derived.reasons.join('; ')})` : '';
    throw new HttpError(409, 'equipment_not_ready', `${lb.object_code} ${lb.name} is ${d.derived.status.replace(/_/g, ' ')}${why}: it cannot be used. Clean it, or have it released, first.`, { status: d.derived.status, reasons: d.derived.reasons });
  }
}

/** Writes an automatic entry (use_start or use_end) with a signature that already exists: the step's or the batch's. */
export async function writeUse(c: Client, lb: Lb, kind: 'use_start' | 'use_end', values: Record<string, string>, by: { userId: string; username: string }, signatureId: string, signedAt: string, comment: string) {
  const v = (await c.query<{ id: string; definition: Definition }>("SELECT id, definition FROM logbook_type_versions WHERE type_id = $1 AND status = 'effective'", [lb.type_id])).rows[0];
  if (!v) throw new HttpError(409, 'no_effective_type', `The logbook type of ${lb.object_code} has no effective version.`);
  const k = v.definition.entryKinds.find(e => e.key === kind);
  if (!k) throw new HttpError(409, 'no_use_entry', `The logbook of ${lb.object_code} has no "${kind}" entry kind, so its use cannot be recorded.`);
  const keep = Object.fromEntries(Object.entries(values).filter(([key]) => k.fields.some(f => f.key === key)));
  const r = await c.query<{ id: string }>(`INSERT INTO logbook_entries (logbook_id, type_version_id, kind, "values", flags, comment, author_id, author_name, recorded_at, signature_id)
     VALUES ($1, $2, $3, $4, '[]', $5, $6, $7, $8, $9) RETURNING id`, [lb.id, v.id, kind, JSON.stringify(keep), comment, by.userId, by.username, signedAt, signatureId]);
  return r.rows[0]!.id;
}

/** The logbooks a batch started using and has not released yet. */
export async function inUseBy(c: Client, batchNumber: string): Promise<Lb[]> {
  return (await c.query<Lb>(`SELECT DISTINCT l.id, l.type_id, l.object_code, l.name, l.status FROM logbooks l JOIN logbook_entries s ON s.logbook_id = l.id
     WHERE s.kind = 'use_start' AND s."values"->>'batch' = $1
       AND NOT EXISTS (SELECT 1 FROM logbook_entries e WHERE e.logbook_id = l.id AND e.kind = 'use_end' AND e."values"->>'batch' = $1 AND e.id > s.id)`, [batchNumber])).rows;
}
