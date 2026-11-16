import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import type { Actor } from '../core/route.js';
import { assertDifferentPerson, sign, type PasswordCheck } from '../esign/index.js';
import { checkValues, Definition, type Flag } from './definition.js';
import { deriveStatus, type DerivedStatus } from './status.js';

export type Ctx = { c: Client; pool: Pool; check: PasswordCheck; actor: Actor & { displayName?: string }; requestId: string };
const signer = (a: Ctx['actor']) => ({ userId: a.userId, username: a.username, displayName: a.displayName ?? a.username });
const audit = (x: Ctx, action: string, entity: string, entityId: string, v: { oldValue?: unknown; newValue?: unknown; reason?: string | null } = {}) =>
  writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action, entity, entityId, requestId: x.requestId, ...v });

type VersionRow = { id: string; type_id: string; version_no: number; status: string; definition: Definition; author_id: string; author_name: string; approved_by: string | null; approved_at: Date | null; version: number };
const versionView = (v: VersionRow) => ({ id: v.id, typeId: v.type_id, versionNo: v.version_no, status: v.status, definition: v.definition, authorId: v.author_id, authorName: v.author_name, approvedBy: v.approved_by, approvedAt: v.approved_at?.toISOString() ?? null, rowVersion: v.version });

async function lockVersion(c: Client, typeId: string, vid: string): Promise<VersionRow> {
  const v = (await c.query<VersionRow>('SELECT * FROM logbook_type_versions WHERE id = $1 AND type_id = $2 FOR UPDATE', [vid, typeId])).rows[0];
  if (!v) throw notFound('No such version of this logbook type.');
  return v;
}
const need = (v: VersionRow, rowVersion: number, ...status: string[]) => {
  if (v.version !== rowVersion) throw conflict();
  if (!status.includes(v.status)) throw new HttpError(409, 'wrong_state', `This version is ${v.status}; the action needs ${status.join(' or ')}.`);
};

// ---------- logbook types (E21)
export async function createType(x: Ctx, input: { code: string; name: string; description: string; definition: unknown }) {
  const def = Definition.parse(input.definition);
  const t = await x.c.query<{ id: string }>('INSERT INTO logbook_types (code, name, description) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [input.code, input.name, input.description]);
  if (!t.rows[0]) throw new HttpError(409, 'code_taken', `A logbook type with the code ${input.code} exists.`);
  const v = (await x.c.query<VersionRow>('INSERT INTO logbook_type_versions (type_id, version_no, definition, author_id, author_name) VALUES ($1, 1, $2, $3, $4) RETURNING *', [t.rows[0].id, JSON.stringify(def), x.actor.userId, x.actor.username])).rows[0]!;
  await audit(x, 'logbook_type.created', 'logbook_type', t.rows[0].id, { newValue: { code: input.code, name: input.name, version: 1, definition: def } });
  return { id: t.rows[0].id, code: input.code, name: input.name, version: versionView(v) };
}

export async function editDraft(x: Ctx, typeId: string, vid: string, rowVersion: number, definition: unknown) {
  const v = await lockVersion(x.c, typeId, vid);
  need(v, rowVersion, 'draft');
  const def = Definition.parse(definition);
  const r = (await x.c.query<VersionRow>('UPDATE logbook_type_versions SET definition = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [vid, JSON.stringify(def)])).rows[0]!;
  await audit(x, 'logbook_type.draft_changed', 'logbook_type', typeId, { oldValue: { version: v.version_no, definition: v.definition }, newValue: { version: v.version_no, definition: def } });
  return versionView(r);
}

export async function newDraft(x: Ctx, typeId: string) {
  const open = (await x.c.query('SELECT 1 FROM logbook_type_versions WHERE type_id = $1 AND status IN (\'draft\', \'in_review\')', [typeId])).rowCount;
  if (open) throw new HttpError(409, 'draft_exists', 'This type already has a version in draft or in review.');
  const eff = (await x.c.query<VersionRow>("SELECT * FROM logbook_type_versions WHERE type_id = $1 AND status = 'effective'", [typeId])).rows[0];
  if (!eff) throw notFound('This type has no effective version to start from.');
  const max = (await x.c.query<{ n: number }>('SELECT max(version_no)::int AS n FROM logbook_type_versions WHERE type_id = $1', [typeId])).rows[0]!.n;
  const v = (await x.c.query<VersionRow>('INSERT INTO logbook_type_versions (type_id, version_no, definition, author_id, author_name) VALUES ($1, $2, $3, $4, $5) RETURNING *', [typeId, max + 1, JSON.stringify(eff.definition), x.actor.userId, x.actor.username])).rows[0]!;
  await audit(x, 'logbook_type.new_version', 'logbook_type', typeId, { newValue: { version: v.version_no, from: eff.version_no } });
  return versionView(v);
}

const recordOf = (v: VersionRow) => ({ typeId: v.type_id, versionNo: v.version_no, definition: v.definition });
export async function submit(x: Ctx, typeId: string, vid: string, rowVersion: number, password: string) {
  const v = await lockVersion(x.c, typeId, vid);
  need(v, rowVersion, 'draft');
  if (v.author_id !== x.actor.userId) throw new HttpError(403, 'not_author', 'Only the author of this version submits it for review.');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'authored', entity: 'logbook_type_version', entityId: vid, recordVersion: v.version_no, record: recordOf(v), requestId: x.requestId });
  const r = (await x.c.query<VersionRow>("UPDATE logbook_type_versions SET status = 'in_review', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid])).rows[0]!;
  await audit(x, 'logbook_type.submitted', 'logbook_type', typeId, { newValue: { version: v.version_no, status: 'in_review' } });
  return versionView(r);
}

/** QA approval (E21#2): a signature by someone other than the author; the version becomes effective, the previous one retires. */
export async function approve(x: Ctx, typeId: string, vid: string, rowVersion: number, password: string, comment: string | null) {
  const v = await lockVersion(x.c, typeId, vid);
  need(v, rowVersion, 'in_review');
  assertDifferentPerson(v.author_id, x.actor.userId);
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'approved', entity: 'logbook_type_version', entityId: vid, recordVersion: v.version_no, record: recordOf(v), comment, requestId: x.requestId });
  const prev = await x.c.query<{ version_no: number }>("UPDATE logbook_type_versions SET status = 'retired', version = version + 1, updated_at = now() WHERE type_id = $1 AND status = 'effective' RETURNING version_no", [typeId]);
  const r = (await x.c.query<VersionRow>("UPDATE logbook_type_versions SET status = 'effective', approved_by = $2, approved_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid, x.actor.username])).rows[0]!;
  await audit(x, 'logbook_type.approved', 'logbook_type', typeId, { newValue: { version: v.version_no, status: 'effective', retired: prev.rows.map(p => p.version_no) }, reason: comment });
  return versionView(r);
}

export async function reject(x: Ctx, typeId: string, vid: string, rowVersion: number, password: string, reason: string) {
  const v = await lockVersion(x.c, typeId, vid);
  need(v, rowVersion, 'in_review');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'rejected', entity: 'logbook_type_version', entityId: vid, recordVersion: v.version_no, record: recordOf(v), comment: reason, requestId: x.requestId });
  const r = (await x.c.query<VersionRow>("UPDATE logbook_type_versions SET status = 'draft', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *", [vid])).rows[0]!;
  await audit(x, 'logbook_type.rejected', 'logbook_type', typeId, { newValue: { version: v.version_no, status: 'draft' }, reason });
  return versionView(r);
}

export async function listTypes(pool: Pool) {
  const r = await pool.query<{ id: string; code: string; name: string; description: string; built_in: boolean; versions: VersionRow[] }>(
    `SELECT t.id, t.code, t.name, t.description, t.built_in, coalesce(json_agg(v ORDER BY v.version_no) FILTER (WHERE v.id IS NOT NULL), '[]') AS versions
       FROM logbook_types t LEFT JOIN logbook_type_versions v ON v.type_id = t.id GROUP BY t.id ORDER BY t.name`);
  return r.rows.map(t => ({ id: t.id, code: t.code, name: t.name, description: t.description, builtIn: t.built_in, versions: t.versions.map(v => ({ ...versionView({ ...v, approved_at: v.approved_at ? new Date(v.approved_at) : null }) })) }));
}

// ---------- logbooks (E06)
type LogbookRow = { id: string; type_id: string; object_kind: string; object_code: string; name: string; location: string; settings: { cleanHoldHours?: number | undefined }; status: string; version: number; type_code: string; type_name: string };
const LB = `SELECT l.*, t.code AS type_code, t.name AS type_name FROM logbooks l JOIN logbook_types t ON t.id = l.type_id`;
const logbookView = (l: LogbookRow) => ({ id: l.id, typeId: l.type_id, typeCode: l.type_code, typeName: l.type_name, objectKind: l.object_kind, objectCode: l.object_code, name: l.name, location: l.location, settings: l.settings, status: l.status, version: l.version });

export async function createLogbook(x: Ctx, input: { typeCode: string; objectKind: string; objectCode: string; name: string; location: string; settings: { cleanHoldHours?: number | undefined } }) {
  const t = (await x.c.query<{ id: string }>("SELECT t.id FROM logbook_types t JOIN logbook_type_versions v ON v.type_id = t.id AND v.status = 'effective' WHERE lower(t.code) = lower($1)", [input.typeCode])).rows[0];
  if (!t) throw new HttpError(400, 'no_effective_type', `There is no approved, effective logbook type ${input.typeCode}.`);
  const r = await x.c.query<{ id: string }>('INSERT INTO logbooks (type_id, object_kind, object_code, name, location, settings) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id', [t.id, input.objectKind, input.objectCode, input.name, input.location, JSON.stringify(input.settings)]);
  if (!r.rows[0]) throw new HttpError(409, 'object_taken', `${input.objectKind} ${input.objectCode} already has a logbook.`);
  await audit(x, 'logbook.created', 'logbook', r.rows[0].id, { newValue: input });
  return logbookView((await x.c.query<LogbookRow>(`${LB} WHERE l.id = $1`, [r.rows[0].id])).rows[0]!);
}

export async function changeLogbook(x: Ctx, id: string, input: { version: number; reason: string; name?: string | undefined; location?: string | undefined; settings?: { cleanHoldHours?: number | undefined } | undefined }) {
  const old = (await x.c.query<LogbookRow>(`${LB} WHERE l.id = $1 FOR UPDATE OF l`, [id])).rows[0];
  if (!old) throw notFound('No such logbook.');
  if (old.version !== input.version) throw conflict();
  if (old.status !== 'active') throw new HttpError(409, 'retired', 'This logbook is retired.');
  await x.c.query('UPDATE logbooks SET name = COALESCE($2, name), location = COALESCE($3, location), settings = COALESCE($4, settings), version = version + 1, updated_at = now() WHERE id = $1', [id, input.name ?? null, input.location ?? null, input.settings ? JSON.stringify(input.settings) : null]);
  const now = (await x.c.query<LogbookRow>(`${LB} WHERE l.id = $1`, [id])).rows[0]!;
  await audit(x, 'logbook.changed', 'logbook', id, { oldValue: { name: old.name, location: old.location, settings: old.settings }, newValue: { name: now.name, location: now.location, settings: now.settings }, reason: input.reason });
  return logbookView(now);
}

/** Retiring, never deleting (AGENTS.md rule 6): the logbook and its entries stay readable. */
export async function retireLogbook(x: Ctx, id: string, version: number, reason: string, password: string) {
  const old = (await x.c.query<LogbookRow>(`${LB} WHERE l.id = $1 FOR UPDATE OF l`, [id])).rows[0];
  if (!old) throw notFound('No such logbook.');
  if (old.version !== version) throw conflict();
  if (old.status !== 'active') throw new HttpError(409, 'retired', 'This logbook is already retired.');
  await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password, meaning: 'retired', entity: 'logbook', entityId: id, recordVersion: old.version, record: logbookView(old), comment: reason, requestId: x.requestId });
  await x.c.query("UPDATE logbooks SET status = 'retired', version = version + 1, updated_at = now() WHERE id = $1", [id]);
  await audit(x, 'logbook.retired', 'logbook', id, { oldValue: { status: 'active' }, newValue: { status: 'retired' }, reason });
}

// ---------- entries (E06#2, E21#4)
type EntryRow = { id: string; logbook_id: string; type_version_id: string; version_no: number; kind: string; values: Record<string, unknown>; flags: Flag[]; comment: string | null; author_id: string; author_name: string; recorded_at: Date; corrects_entry_id: string | null; correction_reason: string | null; signature_id: string; meaning: string; signer_name: string; signed_at: Date; corrected_by: string | null };
export async function writeEntry(x: Ctx, logbookId: string, input: { kind: string; values: Record<string, unknown>; comment?: string | null | undefined; password: string; correctsEntryId?: string | undefined; reason?: string | undefined }) {
  const lb = (await x.c.query<LogbookRow>(`${LB} WHERE l.id = $1 FOR UPDATE OF l`, [logbookId])).rows[0];
  if (!lb) throw notFound('No such logbook.');
  if (lb.status !== 'active') throw new HttpError(409, 'retired', 'This logbook is retired: nothing can be written in it.');
  const v = (await x.c.query<VersionRow>("SELECT * FROM logbook_type_versions WHERE type_id = $1 AND status = 'effective'", [lb.type_id])).rows[0];
  if (!v) throw new HttpError(409, 'no_effective_type', 'The type of this logbook has no effective version.');
  if (input.correctsEntryId) {
    const orig = (await x.c.query<{ kind: string; corrected: boolean }>('SELECT kind, EXISTS (SELECT 1 FROM logbook_entries c WHERE c.corrects_entry_id = e.id) AS corrected FROM logbook_entries e WHERE e.id = $1 AND e.logbook_id = $2', [input.correctsEntryId, logbookId])).rows[0];
    if (!orig) throw notFound('The entry to correct is not in this logbook.');
    if (orig.corrected) throw new HttpError(409, 'already_corrected', 'This entry was already corrected: correct the correction.');
    if (orig.kind !== input.kind) throw new HttpError(400, 'kind_mismatch', 'A correction has the same kind as the entry it corrects.');
    if (!input.reason || input.reason.trim().length < 3) throw new HttpError(400, 'reason_required', 'A correction needs a reason.');
  }
  const kind = v.definition.entryKinds.find(k => k.key === input.kind);
  if (!kind) throw new HttpError(400, 'unknown_kind', `${input.kind} is not an entry kind of ${lb.type_name}.`);
  const checked = checkValues(kind, input.values, input.comment);
  if (checked.errors.length) throw new HttpError(400, 'invalid_entry', 'The entry is not valid.', checked.errors);
  const record = { logbookId, typeVersionId: v.id, kind: input.kind, values: checked.values, comment: input.comment ?? null, correctsEntryId: input.correctsEntryId ?? null, reason: input.reason ?? null };
  // the entry's number is reserved first, so the signature names the entry it signs
  const entryId = (await x.c.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('logbook_entries', 'id'))::text AS id")).rows[0]!.id;
  const sig = await sign(x.c, x.pool, x.check, { signer: signer(x.actor), password: input.password, meaning: input.correctsEntryId ? 'corrected' : 'performed', entity: 'logbook_entry', entityId: entryId, recordVersion: 1, record, comment: input.reason ?? null, requestId: x.requestId });
  const e = (await x.c.query<{ id: string }>(`INSERT INTO logbook_entries (id, logbook_id, type_version_id, kind, "values", flags, comment, author_id, author_name, recorded_at, corrects_entry_id, correction_reason, signature_id)
      VALUES ($13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [logbookId, v.id, input.kind, JSON.stringify(checked.values), JSON.stringify(checked.flags), input.comment ?? null, x.actor.userId, x.actor.username, sig.signedAt, input.correctsEntryId ?? null, input.reason ?? null, sig.id, entryId])).rows[0]!;
  await audit(x, input.correctsEntryId ? 'logbook.entry_corrected' : 'logbook.entry_written', 'logbook', logbookId, { newValue: { entryId: e.id, ...record, flags: checked.flags, signatureId: sig.id }, reason: input.reason ?? null });
  return { id: e.id, flags: checked.flags, typeVersion: v.version_no, signatureId: sig.id, recordedAt: sig.signedAt };
}

export type LogbookDetail = ReturnType<typeof logbookView> & { status: string; definition: Definition | null; derived: DerivedStatus; entries: Array<{ id: string; kind: string; kindLabel: string; typeVersion: number; values: Record<string, unknown>; flags: Flag[]; comment: string | null; author: string; recordedAt: string; meaning: string; signedBy: string; signedAt: string; correctsEntryId: string | null; correctionReason: string | null; correctedBy: string | null }> };
export async function logbookDetail(pool: Pool, id: string): Promise<LogbookDetail> {
  const lb = (await pool.query<LogbookRow>(`${LB} WHERE l.id = $1`, [id])).rows[0];
  if (!lb) throw notFound('No such logbook.');
  const def = (await pool.query<{ definition: Definition }>("SELECT definition FROM logbook_type_versions WHERE type_id = $1 AND status = 'effective'", [lb.type_id])).rows[0]?.definition;
  const rows = (await pool.query<EntryRow>(`SELECT e.*, tv.version_no, s.meaning, s.signer_name, s.signed_at, (SELECT min(c.id)::text FROM logbook_entries c WHERE c.corrects_entry_id = e.id) AS corrected_by
       FROM logbook_entries e JOIN signatures s ON s.id = e.signature_id JOIN logbook_type_versions tv ON tv.id = e.type_version_id WHERE e.logbook_id = $1 ORDER BY e.id`, [id])).rows;
  const derived = def ? deriveStatus(def, rows.map(r => ({ kind: r.kind, values: r.values, recorded_at: r.recorded_at, corrected: !!r.corrected_by })), lb.settings) : { status: 'unknown', since: null, calibrationDue: null, reasons: ['no effective type version'] };
  return {
    ...logbookView(lb), definition: def ?? null, derived,
    entries: rows.map(r => ({ id: r.id, kind: r.kind, kindLabel: def?.entryKinds.find(k => k.key === r.kind)?.label ?? r.kind, typeVersion: r.version_no, values: r.values, flags: r.flags, comment: r.comment, author: r.author_name, recordedAt: r.recorded_at.toISOString(), meaning: r.meaning, signedBy: r.signer_name, signedAt: r.signed_at.toISOString(), correctsEntryId: r.corrects_entry_id, correctionReason: r.correction_reason, correctedBy: r.corrected_by })),
  };
}

export async function listLogbooks(pool: Pool, filter: { objectKind?: string | undefined; status?: string | undefined }) {
  const ids = (await pool.query<{ id: string }>(`SELECT l.id FROM logbooks l WHERE ($1::text IS NULL OR l.object_kind = $1) AND ($2::text IS NULL OR l.status = $2) ORDER BY l.object_kind, lower(l.object_code) LIMIT 500`, [filter.objectKind ?? null, filter.status ?? null])).rows;
  const out = [];
  for (const { id } of ids) { const d = await logbookDetail(pool, id); const { entries, definition: _def, ...rest } = d; void _def; out.push({ ...rest, entryCount: entries.length, lastEntryAt: entries.at(-1)?.recordedAt ?? null }); }
  return out;
}
