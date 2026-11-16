import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { assertDifferentPerson, sign, type PasswordCheck } from '../esign/index.js';
import { Design } from './design.js';

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };
const signer = (a: Ctx['actor']) => ({ userId: a.userId, username: a.username, displayName: a.displayName ?? a.username });
const audit = (x: Ctx, action: string, masterId: string, v: { oldValue?: unknown; newValue?: unknown; reason?: string | null } = {}) =>
  writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action, entity: 'mbr', entityId: masterId, requestId: x.requestId, ...v });

type Row = { id: string; master_id: string; version_no: number; status: string; design: Design; based_on: string | null; author_id: string; author_name: string; approved_by: string | null; approved_at: Date | string | null; effective_at: Date | string | null; version: number };
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export const view = (v: Row) => ({ id: v.id, masterId: v.master_id, versionNo: v.version_no, status: v.status, design: v.design, basedOn: v.based_on, authorId: v.author_id, authorName: v.author_name, approvedBy: v.approved_by, approvedAt: iso(v.approved_at), effectiveAt: iso(v.effective_at), rowVersion: v.version });

async function lock(c: Client, masterId: string, vid: string): Promise<Row> {
  const v = (await c.query<Row>('SELECT * FROM mbr_versions WHERE id = $1 AND master_id = $2 FOR UPDATE', [vid, masterId])).rows[0];
  if (!v) throw notFound('No such version of this master batch record.');
  return v;
}
function need(v: Row, rowVersion: number, ...status: string[]) {
  if (v.version !== rowVersion) throw conflict();
  if (!status.includes(v.status)) throw new HttpError(409, 'wrong_state', `This version is ${v.status.replace('_', ' ')}; the action needs ${status.join(' or ')}.`);
}
const record = (v: Row) => ({ masterId: v.master_id, versionNo: v.version_no, design: v.design });

export async function create(x: Ctx, input: { code: string; productName: string; design: unknown }) {
  const design = Design.parse(input.design);
  const m = await x.c.query<{ id: string }>('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [input.code, input.productName]);
  if (!m.rows[0]) throw new HttpError(409, 'code_taken', `A master batch record with the code ${input.code} exists.`);
  const v = (await x.c.query<Row>('INSERT INTO mbr_versions (master_id, version_no, design, author_id, author_name) VALUES ($1, 1, $2, $3, $4) RETURNING *', [m.rows[0].id, JSON.stringify(design), x.actor.userId, x.actor.username])).rows[0]!;
  await audit(x, 'mbr.created', m.rows[0].id, { newValue: { code: input.code, productName: input.productName, version: 1, design } });
  return { id: m.rows[0].id, code: input.code, productName: input.productName, version: view(v) };
}

export async function editDraft(x: Ctx, masterId: string, vid: string, rowVersion: number, designIn: unknown) {
  const v = await lock(x.c, masterId, vid);
  need(v, rowVersion, 'draft');
  const design = Design.parse(designIn);
  const r = (await x.c.query<Row>('UPDATE mbr_versions SET design = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [vid, JSON.stringify(design)])).rows[0]!;
  await audit(x, 'mbr.draft_changed', masterId, { oldValue: { version: v.version_no, design: v.design }, newValue: { version: v.version_no, design } });
  return view(r);
}

/** A change to an approved or effective recipe is a new draft based on it (E09#3); the history stays. */
export async function newDraft(x: Ctx, masterId: string) {
  if ((await x.c.query("SELECT 1 FROM mbr_versions WHERE master_id = $1 AND status IN ('draft', 'in_review', 'approved')", [masterId])).rowCount)
    throw new HttpError(409, 'version_open', 'A version of this recipe is already in draft, in review or approved but not effective.');
  const from = (await x.c.query<Row>("SELECT * FROM mbr_versions WHERE master_id = $1 AND status = 'effective'", [masterId])).rows[0];
  if (!from) throw notFound('This recipe has no effective version to start from.');
  const n = (await x.c.query<{ n: number }>('SELECT max(version_no)::int AS n FROM mbr_versions WHERE master_id = $1', [masterId])).rows[0]!.n + 1;
  const v = (await x.c.query<Row>('INSERT INTO mbr_versions (master_id, version_no, design, based_on, author_id, author_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [masterId, n, JSON.stringify(from.design), from.id, x.actor.userId, x.actor.username])).rows[0]!;
  await audit(x, 'mbr.new_version', masterId, { newValue: { version: n, basedOn: from.version_no } });
  return view(v);
}

export async function submit(x: Ctx, masterId: string, vid: string, rowVersion: number, password: string) {
  const v = await lock(x.c, masterId, vid);
  need(v, rowVersion, 'draft');
  if (v.author_id !== x.actor.userId) throw new HttpError(403, 'not_author', 'Only the author of this version sends it to review.');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'authored', entity: 'mbr_version', entityId: vid, recordVersion: v.version_no, record: record(v), requestId: x.requestId });
  const r = (await x.c.query<Row>("UPDATE mbr_versions SET status = 'in_review', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid])).rows[0]!;
  await audit(x, 'mbr.submitted', masterId, { newValue: { version: v.version_no, status: 'in_review' } });
  return view(r);
}

/** E09#1: approval needs a QA signature from someone other than the author. */
export async function approve(x: Ctx, masterId: string, vid: string, rowVersion: number, password: string, comment: string | null) {
  const v = await lock(x.c, masterId, vid);
  need(v, rowVersion, 'in_review');
  assertDifferentPerson(v.author_id, x.actor.userId);
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'approved', entity: 'mbr_version', entityId: vid, recordVersion: v.version_no, record: record(v), comment, requestId: x.requestId });
  const r = (await x.c.query<Row>("UPDATE mbr_versions SET status = 'approved', approved_by = $2, approved_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid, x.actor.username])).rows[0]!;
  await audit(x, 'mbr.approved', masterId, { newValue: { version: v.version_no, status: 'approved' }, reason: comment });
  return view(r);
}

export async function reject(x: Ctx, masterId: string, vid: string, rowVersion: number, password: string, reason: string) {
  const v = await lock(x.c, masterId, vid);
  need(v, rowVersion, 'in_review');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'rejected', entity: 'mbr_version', entityId: vid, recordVersion: v.version_no, record: record(v), comment: reason, requestId: x.requestId });
  const r = (await x.c.query<Row>("UPDATE mbr_versions SET status = 'draft', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid])).rows[0]!;
  await audit(x, 'mbr.rejected', masterId, { newValue: { version: v.version_no, status: 'draft' }, reason });
  return view(r);
}

/** E09#2: one effective version at a time; making a new one effective retires the previous one (same transaction). */
export async function makeEffective(x: Ctx, masterId: string, vid: string, rowVersion: number, password: string) {
  const v = await lock(x.c, masterId, vid);
  need(v, rowVersion, 'approved');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'approved', entity: 'mbr_version', entityId: vid, recordVersion: v.version_no, record: record(v), comment: 'made effective', requestId: x.requestId });
  const prev = await x.c.query<{ version_no: number }>("UPDATE mbr_versions SET status = 'retired', version = version + 1, updated_at = now() WHERE master_id = $1 AND status = 'effective' RETURNING version_no", [masterId]);
  const r = (await x.c.query<Row>("UPDATE mbr_versions SET status = 'effective', effective_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid])).rows[0]!;
  await audit(x, 'mbr.effective', masterId, { newValue: { version: v.version_no, status: 'effective', retired: prev.rows.map(p => p.version_no) } });
  return view(r);
}

export async function list(pool: Pool) {
  const r = await pool.query<{ id: string; code: string; product_name: string; versions: Row[] }>(
    `SELECT m.id, m.code, m.product_name, coalesce(json_agg(v ORDER BY v.version_no) FILTER (WHERE v.id IS NOT NULL), '[]') AS versions
       FROM mbr_masters m LEFT JOIN mbr_versions v ON v.master_id = m.id GROUP BY m.id ORDER BY lower(m.code)`);
  return r.rows.map(m => ({ id: m.id, code: m.code, productName: m.product_name, versions: m.versions.map(view) }));
}

/** The effective version of a recipe, for R2 batch creation (E10#1 takes a batch only from this). */
export async function effectiveVersion(c: Client | Pool, masterId: string) {
  const v = (await c.query<Row>("SELECT * FROM mbr_versions WHERE master_id = $1 AND status = 'effective'", [masterId])).rows[0];
  return v ? view(v) : null;
}
