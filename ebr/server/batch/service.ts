import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { assertDifferentPerson, sign, type PasswordCheck } from '../esign/index.js';
import type { Design, Step } from '../mbr/design.js';
import { batchHooks, handlers, needsVerification } from './steps.js';

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };
const signer = (a: Ctx['actor']) => ({ userId: a.userId, username: a.username, displayName: a.displayName ?? a.username });
const audit = (x: Ctx, action: string, batchId: string, v: { oldValue?: unknown; newValue?: unknown; reason?: string | null } = {}) =>
  writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action, entity: 'batch', entityId: batchId, requestId: x.requestId, ...v });

type BatchRow = { id: string; batch_number: string; mbr_master_id: string; mbr_version_id: string; product_name: string; batch_size: { value: number; unit: string }; status: string; created_by: string; created_at: Date; completed_at: Date | null; version: number; mbr_code?: string; mbr_version_no?: number };
type StepRow = { id: string; batch_id: string; seq: number; phase_key: string; phase_label: string; step_key: string; definition: Step; state: string; value: unknown; comment: string | null; performed_by: string | null; performed_name: string | null; performed_at: Date | null; signature_id: string | null; verified_by: string | null; verified_name: string | null; verified_at: Date | null; verify_signature_id: string | null; version: number };
type ExcRow = { id: string; batch_id: string; step_id: string; kind: string; message: string; comment: string; status: string; deviation_number: string | null; raised_by: string; raised_at: Date; closed_by: string | null; closed_at: Date | null; close_note: string | null; version: number };
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---------- creation (E10#1)
export async function createBatch(x: Ctx, input: { mbrMasterId: string; batchNumber: string }) {
  const v = (await x.c.query<{ id: string; version_no: number; design: Design; product_name: string; code: string }>(
    `SELECT v.id, v.version_no, v.design, m.product_name, m.code FROM mbr_versions v JOIN mbr_masters m ON m.id = v.master_id WHERE v.master_id = $1 AND v.status = 'effective'`, [input.mbrMasterId])).rows[0];
  if (!v) throw new HttpError(400, 'no_effective_mbr', 'This recipe has no effective version: a batch is made only from an approved, effective master batch record.');
  const b = await x.c.query<{ id: string }>('INSERT INTO batches (batch_number, mbr_master_id, mbr_version_id, product_name, batch_size, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id',
    [input.batchNumber, input.mbrMasterId, v.id, v.product_name, JSON.stringify(v.design.batchSize), x.actor.username]);
  if (!b.rows[0]) throw new HttpError(409, 'batch_number_taken', `Batch number ${input.batchNumber} is already used.`);
  let seq = 0;
  for (const ph of v.design.phases) for (const s of ph.steps) {
    seq++;
    await x.c.query('INSERT INTO batch_steps (batch_id, seq, phase_key, phase_label, step_key, definition) VALUES ($1, $2, $3, $4, $5, $6)', [b.rows[0].id, seq, ph.key, ph.label, s.key, JSON.stringify(s)]);
  }
  await audit(x, 'batch.created', b.rows[0].id, { newValue: { batchNumber: input.batchNumber, mbr: v.code, mbrVersion: v.version_no, steps: seq } });
  return detail(x.c, b.rows[0].id);
}

// ---------- reading
export async function detail(c: Client | Pool, id: string) {
  const b = (await c.query<BatchRow>('SELECT b.*, m.code AS mbr_code, v.version_no AS mbr_version_no FROM batches b JOIN mbr_masters m ON m.id = b.mbr_master_id JOIN mbr_versions v ON v.id = b.mbr_version_id WHERE b.id = $1', [id])).rows[0];
  if (!b) throw notFound('No such batch.');
  const steps = (await c.query<StepRow>('SELECT * FROM batch_steps WHERE batch_id = $1 ORDER BY seq', [id])).rows;
  const exceptions = (await c.query<ExcRow>('SELECT * FROM batch_exceptions WHERE batch_id = $1 ORDER BY id', [id])).rows;
  const next = nextStep(steps);
  return {
    id: b.id, batchNumber: b.batch_number, productName: b.product_name, batchSize: b.batch_size, status: b.status, version: b.version,
    mbr: { masterId: b.mbr_master_id, versionId: b.mbr_version_id, code: b.mbr_code, versionNo: b.mbr_version_no },
    createdBy: b.created_by, createdAt: b.created_at.toISOString(), completedAt: iso(b.completed_at),
    nextStepId: next.step?.id ?? null, waitingFor: next.waiting,
    steps: steps.map(s => ({ id: s.id, seq: s.seq, phaseKey: s.phase_key, phaseLabel: s.phase_label, stepKey: s.step_key, definition: s.definition, state: s.state, value: s.value, comment: s.comment,
      performedBy: s.performed_name, performedAt: iso(s.performed_at), verifiedBy: s.verified_name, verifiedAt: iso(s.verified_at), needsVerification: needsVerification(s.definition), version: s.version })),
    exceptions: exceptions.map(e => ({ id: e.id, stepId: e.step_id, kind: e.kind, message: e.message, comment: e.comment, status: e.status, deviationNumber: e.deviation_number, raisedBy: e.raised_by, raisedAt: e.raised_at.toISOString(), closedBy: e.closed_by, closedAt: iso(e.closed_at), closeNote: e.close_note, version: e.version })),
  };
}
export async function list(pool: Pool) {
  const r = await pool.query<{ id: string; batch_number: string; product_name: string; status: string; created_at: Date; done: number; total: number; open_exceptions: number }>(
    `SELECT b.id, b.batch_number, b.product_name, b.status, b.created_at,
            (SELECT count(*)::int FROM batch_steps s WHERE s.batch_id = b.id AND s.state = 'done') AS done,
            (SELECT count(*)::int FROM batch_steps s WHERE s.batch_id = b.id) AS total,
            (SELECT count(*)::int FROM batch_exceptions e WHERE e.batch_id = b.id AND e.status = 'open') AS open_exceptions
       FROM batches b ORDER BY b.created_at DESC LIMIT 200`);
  return r.rows.map(b => ({ id: b.id, batchNumber: b.batch_number, productName: b.product_name, status: b.status, createdAt: b.created_at.toISOString(), stepsDone: b.done, stepsTotal: b.total, openExceptions: b.open_exceptions }));
}

/** E10#2: one step at a time, in the recipe's order; a step waiting for its second person blocks the ones after it. */
function nextStep(steps: StepRow[]): { step: StepRow | null; waiting: string | null } {
  for (const s of steps) {
    if (s.state === 'pending') return { step: s, waiting: null };
    if (needsVerification(s.definition) && !s.verify_signature_id) return { step: null, waiting: `step ${s.seq} (${s.definition.label}) waits for its verification by a second person` };
  }
  return { step: null, waiting: null };
}

async function lockBatch(c: Client, id: string) {
  const b = (await c.query<BatchRow>('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound('No such batch.');
  if (!['created', 'in_progress'].includes(b.status)) throw new HttpError(409, 'batch_closed', `Batch ${b.batch_number} is ${b.status}: nothing can be recorded.`);
  return b;
}

// ---------- recording (E10#2, E10#3, E11)
export async function recordStep(x: Ctx, batchId: string, stepId: string, input: { version: number; input: Record<string, unknown>; comment?: string | undefined; password: string }) {
  const b = await lockBatch(x.c, batchId);
  const steps = (await x.c.query<StepRow>('SELECT * FROM batch_steps WHERE batch_id = $1 ORDER BY seq', [batchId])).rows;
  const s = steps.find(r => r.id === stepId);
  if (!s) throw notFound('No such step in this batch.');
  if (s.version !== input.version) throw conflict('This step was recorded by someone else meanwhile. Reload the batch.');
  if (s.state === 'done') throw new HttpError(409, 'already_recorded', 'This step is already recorded.');
  const next = nextStep(steps);
  if (next.step?.id !== s.id) throw new HttpError(409, 'out_of_order', next.waiting ? `Not yet: ${next.waiting}.` : `Not yet: step ${next.step?.seq} (${next.step?.definition.label}) comes first.`);
  const h = (await handlers()).get(s.definition.type);
  if (!h) throw new HttpError(409, 'step_type_not_available', `Steps of the type ${s.definition.type} cannot be recorded in this version of the system yet.`);
  const numbers = new Map<string, number>();
  for (const r of steps) if (r.state === 'done' && r.value && typeof (r.value as { value?: unknown }).value === 'number') numbers.set(`${r.phase_key}.${r.step_key}`, (r.value as { value: number }).value);
  const out = await h.record(input.input, s.definition, { c: x.c, pool: x.pool, actor: x.actor, batch: { id: b.id, batchNumber: b.batch_number, productName: b.product_name }, phaseKey: s.phase_key, numbers });
  const comment = input.comment?.trim() || null;
  if (out.exceptions.length && (!comment || comment.length < 3)) throw new HttpError(400, 'comment_required', `${out.exceptions.map(e => e.message).join('; ')}. A comment is required.`, out.exceptions);
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'performed', entity: 'batch_step', entityId: s.id, recordVersion: s.version, record: { batchId, seq: s.seq, value: out.value, comment }, requestId: x.requestId });
  await x.c.query(`UPDATE batch_steps SET state = 'done', value = $2, comment = $3, performed_by = $4, performed_name = $5, performed_at = $6, signature_id = $7, version = version + 1 WHERE id = $1`,
    [s.id, JSON.stringify(out.value), comment, x.actor.userId, signer(x.actor).displayName, sig.signedAt, sig.id]);
  if (out.effects) await out.effects(sig.id, sig.signedAt);
  for (const e of out.exceptions) await x.c.query('INSERT INTO batch_exceptions (batch_id, step_id, kind, message, comment, raised_by) VALUES ($1, $2, $3, $4, $5, $6)', [batchId, s.id, e.kind, e.message, comment, x.actor.username]);
  if (b.status === 'created') await x.c.query("UPDATE batches SET status = 'in_progress', version = version + 1, updated_at = now() WHERE id = $1", [batchId]);
  await audit(x, 'batch.step_recorded', batchId, { newValue: { seq: s.seq, step: `${s.phase_key}.${s.step_key}`, value: out.value, comment, exceptions: out.exceptions, signatureId: sig.id } });
  return detail(x.c, batchId);
}

/** The second person of a verified or critical step (AGENTS.md rule 3): someone else than the performer, checked here. */
export async function verifyStep(x: Ctx, batchId: string, stepId: string, input: { version: number; password: string }) {
  await lockBatch(x.c, batchId);
  const s = (await x.c.query<StepRow>('SELECT * FROM batch_steps WHERE id = $1 AND batch_id = $2 FOR UPDATE', [stepId, batchId])).rows[0];
  if (!s) throw notFound('No such step in this batch.');
  if (s.version !== input.version) throw conflict();
  if (s.state !== 'done') throw new HttpError(409, 'not_recorded', 'The step must be performed before it is verified.');
  if (!needsVerification(s.definition)) throw new HttpError(409, 'no_verification', 'This step does not need a verification.');
  if (s.verify_signature_id) throw new HttpError(409, 'already_verified', 'This step is already verified.');
  assertDifferentPerson(s.performed_by!, x.actor.userId);
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'verified', entity: 'batch_step', entityId: s.id, recordVersion: s.version, record: { batchId, seq: s.seq, value: s.value, comment: s.comment }, requestId: x.requestId });
  await x.c.query('UPDATE batch_steps SET verified_by = $2, verified_name = $3, verified_at = $4, verify_signature_id = $5, version = version + 1 WHERE id = $1', [s.id, x.actor.userId, signer(x.actor).displayName, sig.signedAt, sig.id]);
  await audit(x, 'batch.step_verified', batchId, { newValue: { seq: s.seq, signatureId: sig.id } });
  return detail(x.c, batchId);
}

// ---------- exceptions (E11#1, E11#2)
async function lockException(x: Ctx, batchId: string, eid: string, version: number) {
  const e = (await x.c.query<ExcRow>('SELECT * FROM batch_exceptions WHERE id = $1 AND batch_id = $2 FOR UPDATE', [eid, batchId])).rows[0];
  if (!e) throw notFound('No such exception in this batch.');
  if (e.version !== version) throw conflict();
  if (e.status !== 'open') throw new HttpError(409, 'exception_closed', 'This exception is already closed.');
  return e;
}
export async function raiseDeviation(x: Ctx, batchId: string, eid: string, input: { version: number; deviationNumber: string; password: string }) {
  const e = await lockException(x, batchId, eid, input.version);
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'reviewed', entity: 'batch_exception', entityId: eid, recordVersion: e.version, record: { batchId, message: e.message, deviation: input.deviationNumber }, comment: `raised as deviation ${input.deviationNumber}`, requestId: x.requestId });
  await x.c.query("UPDATE batch_exceptions SET deviation_number = $2, status = 'closed', closed_by = $3, closed_at = now(), close_note = $4, version = version + 1 WHERE id = $1", [eid, input.deviationNumber, x.actor.username, `handled in deviation ${input.deviationNumber}`]);
  await audit(x, 'batch.exception_to_deviation', batchId, { newValue: { exceptionId: eid, deviationNumber: input.deviationNumber } });
  return detail(x.c, batchId);
}
export async function closeException(x: Ctx, batchId: string, eid: string, input: { version: number; note: string; password: string }) {
  const e = await lockException(x, batchId, eid, input.version);
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'reviewed', entity: 'batch_exception', entityId: eid, recordVersion: e.version, record: { batchId, message: e.message }, comment: input.note, requestId: x.requestId });
  await x.c.query("UPDATE batch_exceptions SET status = 'closed', closed_by = $2, closed_at = now(), close_note = $3, version = version + 1 WHERE id = $1", [eid, x.actor.username, input.note]);
  await audit(x, 'batch.exception_closed', batchId, { newValue: { exceptionId: eid }, reason: input.note });
  return detail(x.c, batchId);
}

/** E11#1: a batch cannot be closed while a step is not done, not verified, or an exception is open. */
export async function completeBatch(x: Ctx, batchId: string, input: { version: number; password: string }) {
  const b = await lockBatch(x.c, batchId);
  if (b.version !== input.version) throw conflict();
  const d = await detail(x.c, batchId);
  const missing = d.steps.filter(s => s.state !== 'done').length, unverified = d.steps.filter(s => s.needsVerification && !s.verifiedBy).length, open = d.exceptions.filter(e => e.status === 'open').length;
  if (missing || unverified || open) throw new HttpError(409, 'not_complete', [missing && `${missing} step(s) not recorded`, unverified && `${unverified} step(s) not verified`, open && `${open} exception(s) open`].filter(Boolean).join(', ') + ': the batch cannot be closed.');
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: 'performed', entity: 'batch', entityId: batchId, recordVersion: b.version, record: { batchNumber: b.batch_number, steps: d.steps.map(s => ({ seq: s.seq, value: s.value })) }, comment: 'batch completed', requestId: x.requestId });
  for (const hook of await batchHooks()) await hook({ c: x.c, pool: x.pool, actor: x.actor, batch: { id: b.id, batchNumber: b.batch_number, productName: b.product_name }, signatureId: sig.id, signedAt: sig.signedAt });
  await x.c.query("UPDATE batches SET status = 'completed', completed_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [batchId]);
  await audit(x, 'batch.completed', batchId, { oldValue: { status: b.status }, newValue: { status: 'completed' } });
  return detail(x.c, batchId);
}
