import { createHash } from 'node:crypto';
import { auditOf, writeAudit } from '../audit/index.js';
import { detail } from '../batch/service.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { sign, signaturesOf, type PasswordCheck } from '../esign/index.js';
import { textPdf } from '../logbook/pdf.js';

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };
const signer = (a: Ctx['actor']) => ({ userId: a.userId, username: a.username, displayName: a.displayName ?? a.username });
const audit = (x: Ctx, action: string, batchId: string, v: { newValue?: unknown; reason?: string | null } = {}) =>
  writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action, entity: 'batch', entityId: batchId, requestId: x.requestId, ...v });
/** A verification signed long after the step: shown to the reviewer (site setting, minutes). */
const lateMinutes = () => Number(process.env.EBR_LATE_VERIFICATION_MINUTES ?? 60);

/** E14#1: what QA reviews is the exceptions, not every step: exceptions, comments on steps, late verifications. */
export async function itemsOf(c: Client | Pool, batchId: string) {
  const d = await detail(c, batchId);
  const items: Array<{ key: string; kind: string; text: string }> = [];
  for (const e of d.exceptions) {
    const s = d.steps.find(x => x.id === e.stepId);
    items.push({ key: `exception:${e.id}`, kind: 'exception', text: `${s ? `Step ${s.seq} ${s.definition.label}: ` : 'Batch: '}${e.message}. Comment: ${e.comment}. ${e.status === 'open' ? 'OPEN' : e.deviationNumber ? `Deviation ${e.deviationNumber}` : `Closed: ${e.closeNote}`}` });
  }
  for (const s of d.steps) {
    if (s.comment && !d.exceptions.some(e => e.stepId === s.id)) items.push({ key: `comment:${s.id}`, kind: 'comment', text: `Step ${s.seq} ${s.definition.label}: comment "${s.comment}" by ${s.performedBy}` });
    if (s.verifiedAt && s.performedAt && Date.parse(s.verifiedAt) - Date.parse(s.performedAt) > lateMinutes() * 60_000) items.push({ key: `late:${s.id}`, kind: 'late_verification', text: `Step ${s.seq} ${s.definition.label}: verified ${Math.round((Date.parse(s.verifiedAt) - Date.parse(s.performedAt)) / 60_000)} minutes after it was performed` });
  }
  return { batch: d, items };
}

type Review = { batch_id: string; status: string; started_by: string; completed_by: string | null; version: number };
export async function reviewView(c: Client | Pool, batchId: string) {
  const r = (await c.query<Review>('SELECT * FROM batch_reviews WHERE batch_id = $1', [batchId])).rows[0];
  const items = (await c.query<{ id: string; item_key: string; kind: string; text: string; acknowledged_by: string | null; acknowledged_at: Date | null; note: string | null }>('SELECT * FROM batch_review_items WHERE batch_id = $1 ORDER BY id', [batchId])).rows;
  const disp = (await c.query<{ decision: string; decided_by: string; decided_at: Date; comment: string | null }>('SELECT * FROM batch_dispositions WHERE batch_id = $1', [batchId])).rows[0];
  return {
    review: r ? { status: r.status, startedBy: r.started_by, completedBy: r.completed_by, version: r.version } : null,
    items: items.map(i => ({ id: i.id, key: i.item_key, kind: i.kind, text: i.text, acknowledgedBy: i.acknowledged_by, acknowledgedAt: i.acknowledged_at?.toISOString() ?? null, note: i.note })),
    disposition: disp ? { decision: disp.decision, decidedBy: disp.decided_by, decidedAt: disp.decided_at.toISOString(), comment: disp.comment } : null,
  };
}

export async function startReview(x: Ctx, batchId: string) {
  const b = (await x.c.query<{ status: string; batch_number: string }>('SELECT status, batch_number FROM batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
  if (!b) throw notFound('No such batch.');
  if (b.status !== 'completed') throw new HttpError(409, 'batch_state', `Batch ${b.batch_number} is ${b.status.replace('_', ' ')}: it is reviewed once it is completed.`);
  const { items } = await itemsOf(x.c, batchId);
  await x.c.query('INSERT INTO batch_reviews (batch_id, started_by) VALUES ($1, $2)', [batchId, x.actor.username]);
  for (const i of items) await x.c.query('INSERT INTO batch_review_items (batch_id, item_key, kind, text) VALUES ($1, $2, $3, $4)', [batchId, i.key, i.kind, i.text]);
  await x.c.query("UPDATE batches SET status = 'in_review', version = version + 1, updated_at = now() WHERE id = $1", [batchId]);
  await audit(x, 'batch.review_started', batchId, { newValue: { items: items.length } });
  return reviewView(x.c, batchId);
}

/** E14#3: every review action is signed with meaning "reviewed" and audited. */
export async function acknowledge(x: Ctx, batchId: string, itemId: string, input: { password: string; note?: string | undefined }) {
  const it = (await x.c.query<{ id: string; text: string; acknowledged_by: string | null }>('SELECT id, text, acknowledged_by FROM batch_review_items WHERE id = $1 AND batch_id = $2 FOR UPDATE', [itemId, batchId])).rows[0];
  if (!it) throw notFound('No such review item.');
  if (it.acknowledged_by) throw new HttpError(409, 'already_reviewed', 'This item is already reviewed.');
  const r = (await x.c.query<Review>("SELECT * FROM batch_reviews WHERE batch_id = $1 AND status = 'open'", [batchId])).rows[0];
  if (!r) throw new HttpError(409, 'no_open_review', 'There is no open review of this batch.');
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'reviewed', entity: 'batch_review_item', entityId: itemId, recordVersion: 1, record: { batchId, text: it.text }, comment: input.note ?? null, requestId: x.requestId });
  await x.c.query('UPDATE batch_review_items SET acknowledged_by = $2, acknowledged_at = $3, note = $4, signature_id = $5 WHERE id = $1', [itemId, x.actor.username, sig.signedAt, input.note ?? null, sig.id]);
  await audit(x, 'batch.review_item', batchId, { newValue: { item: it.text, note: input.note ?? null } });
  return reviewView(x.c, batchId);
}

/** E14#2: the review completes only when every item is reviewed and no exception is open. */
export async function completeReview(x: Ctx, batchId: string, input: { version: number; password: string }) {
  const r = (await x.c.query<Review>('SELECT * FROM batch_reviews WHERE batch_id = $1 FOR UPDATE', [batchId])).rows[0];
  if (!r) throw new HttpError(409, 'no_review', 'The review of this batch has not started.');
  if (r.version !== input.version) throw conflict();
  if (r.status !== 'open') throw new HttpError(409, 'review_complete', 'The review is already complete.');
  const left = (await x.c.query('SELECT 1 FROM batch_review_items WHERE batch_id = $1 AND acknowledged_by IS NULL', [batchId])).rowCount ?? 0;
  const open = (await x.c.query("SELECT 1 FROM batch_exceptions WHERE batch_id = $1 AND status = 'open'", [batchId])).rowCount ?? 0;
  if (left || open) throw new HttpError(409, 'review_not_complete', [left && `${left} item(s) not reviewed`, open && `${open} exception(s) without a deviation or a closure`].filter(Boolean).join(', ') + '.');
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'reviewed', entity: 'batch_review', entityId: batchId, recordVersion: r.version, record: await reviewView(x.c, batchId), comment: 'review complete', requestId: x.requestId });
  await x.c.query("UPDATE batch_reviews SET status = 'complete', completed_by = $2, completed_at = now(), signature_id = $3, version = version + 1 WHERE batch_id = $1", [batchId, x.actor.username, sig.id]);
  await audit(x, 'batch.review_completed', batchId);
  return reviewView(x.c, batchId);
}

/** E15#1: release or reject, with a QA signature, only after a complete review. */
export async function dispose(x: Ctx, batchId: string, decision: 'released' | 'rejected', input: { password: string; comment?: string | undefined }) {
  const b = (await x.c.query<{ status: string; batch_number: string; version: number }>('SELECT status, batch_number, version FROM batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
  if (!b) throw notFound('No such batch.');
  const r = (await x.c.query<Review>('SELECT * FROM batch_reviews WHERE batch_id = $1', [batchId])).rows[0];
  if (b.status !== 'in_review' || r?.status !== 'complete') throw new HttpError(409, 'review_not_complete', `Batch ${b.batch_number} can be ${decision} only after its review is complete.`);
  if (decision === 'rejected' && !input.comment) throw new HttpError(400, 'reason_required', 'A rejection needs a reason.');
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: decision, entity: 'batch', entityId: batchId, recordVersion: b.version, record: { batchNumber: b.batch_number, decision }, comment: input.comment ?? null, requestId: x.requestId });
  await x.c.query('INSERT INTO batch_dispositions (batch_id, decision, decided_by, decided_at, comment, signature_id) VALUES ($1, $2, $3, $4, $5, $6)', [batchId, decision, x.actor.username, sig.signedAt, input.comment ?? null, sig.id]);
  await x.c.query('UPDATE batches SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [batchId, decision]);
  await audit(x, `batch.${decision}`, batchId, { newValue: { decision }, reason: input.comment ?? null });
  return reviewView(x.c, batchId);
}

/**
 * E15#2: the certified copy is generated from the stored record: every value, signature, exception, the reconciliation,
 * the review, the disposition and the audit trail. E15#3: the SHA-256 of the file is registered, so a copy can be
 * checked later.
 */
export async function certifiedCopy(pool: Pool, batchId: string, by: string) {
  const { batch: d } = await itemsOf(pool, batchId);
  const rv = await reviewView(pool, batchId);
  const rec = (await pool.query<{ output_quantity: string; unit: string; theoretical: string; yield_pct: string; materials: Array<{ material: string; dispensed: number; target: number; unit: string; differencePct: number }>; recorded_by: string; recorded_at: Date }>('SELECT * FROM batch_reconciliations WHERE batch_id = $1', [batchId])).rows[0];
  const stepSigs = new Map<string, string[]>();
  for (const s of d.steps) stepSigs.set(s.id, (await signaturesOf(pool, 'batch_step', s.id)).map(g => `${g.meaning} by ${g.signerName} at ${g.signedAt}`));
  const trail = await auditOf(pool, 'batch', batchId);
  const lines = [
    `Batch ${d.batchNumber} - ${d.productName} - batch size ${d.batchSize.value} ${d.batchSize.unit}`,
    `Recipe ${d.mbr.code} version ${d.mbr.versionNo}. Status: ${d.status}. Created by ${d.createdBy} at ${d.createdAt}.`,
    `Certified copy generated by ${by} at ${new Date().toISOString()} (server time, UTC), from the stored record.`, '',
    'STEPS',
    ...d.steps.flatMap(s => [`${s.seq}. [${s.phaseLabel}] ${s.definition.label} (${s.definition.type})`, `    value: ${JSON.stringify(s.value)}${s.comment ? `; comment: ${s.comment}` : ''}`, ...(stepSigs.get(s.id) ?? []).map(t => `    signed: ${t}`)]),
    '', 'EXCEPTIONS', ...(d.exceptions.length ? d.exceptions.map(e => `#${e.id} ${e.kind}: ${e.message}; comment: ${e.comment}; ${e.status}${e.deviationNumber ? `, deviation ${e.deviationNumber}` : e.closeNote ? `, ${e.closeNote}` : ''}`) : ['none']),
    '', 'RECONCILIATION', ...(rec ? [`output ${rec.output_quantity} ${rec.unit} of ${rec.theoretical}: yield ${rec.yield_pct}%; by ${rec.recorded_by} at ${rec.recorded_at.toISOString()}`, ...rec.materials.map(m => `    ${m.material}: ${m.dispensed} of ${m.target} ${m.unit} (${m.differencePct}%)`)] : ['not applicable']),
    '', 'REVIEW BY EXCEPTION', ...(rv.items.length ? rv.items.map(i => `- ${i.text} -> reviewed by ${i.acknowledgedBy ?? 'NOT YET'}${i.note ? ` (${i.note})` : ''}`) : ['no item to review']),
    `Review: ${rv.review ? `${rv.review.status}, by ${rv.review.completedBy ?? rv.review.startedBy}` : 'not started'}`,
    `Disposition: ${rv.disposition ? `${rv.disposition.decision.toUpperCase()} by ${rv.disposition.decidedBy} at ${rv.disposition.decidedAt}${rv.disposition.comment ? ` (${rv.disposition.comment})` : ''}` : 'none yet'}`,
    '', 'AUDIT TRAIL', ...trail.map(t => `${t.at} ${t.actorName} ${t.action}${t.reason ? ` (${t.reason})` : ''}`),
  ];
  const { pdf } = await textPdf(`Certified copy - batch ${d.batchNumber}`, lines);
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  await pool.query('INSERT INTO certified_copies (batch_id, sha256, bytes, generated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING', [batchId, sha256, pdf.length, by]);
  return { pdf, sha256, batchNumber: d.batchNumber };
}

export async function verifyCopy(pool: Pool, pdf: Buffer) {
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const r = (await pool.query<{ batch_number: string; generated_by: string; generated_at: Date }>('SELECT b.batch_number, c.generated_by, c.generated_at FROM certified_copies c JOIN batches b ON b.id = c.batch_id WHERE c.sha256 = $1', [sha256])).rows[0];
  return r ? { genuine: true, sha256, batchNumber: r.batch_number, generatedBy: r.generated_by, generatedAt: r.generated_at.toISOString() } : { genuine: false, sha256 };
}
