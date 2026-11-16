import { writeAudit } from '../audit/index.js';
import type { Client, Pool } from '../core/db.js';
import { HttpError, notFound } from '../core/errors.js';
import { sign } from '../esign/index.js';
import type { Ctx } from './service.js';

/**
 * E28: the built-in equipment and room logbook types are usable only after QA has reviewed them. Until then every write
 * with them (an entry on the logbook screen, or a use written by the batch interlock) is refused with this reason.
 */
/** The same check from a logbook: its type's effective version must not wait for a QA review. */
export async function assertLogbookTypeReviewed(c: Client | Pool, typeId: string, what: string) {
  const v = (await c.query<{ id: string }>("SELECT id FROM logbook_type_versions WHERE type_id = $1 AND status = 'effective'", [typeId])).rows[0];
  if (v) await assertTypeReviewed(c, v.id, what);
}

export async function assertTypeReviewed(c: Client | Pool, typeVersionId: string, what: string) {
  const v = (await c.query<{ needs_qa_review: boolean; name: string; version_no: number }>(
    'SELECT v.needs_qa_review, t.name, v.version_no FROM logbook_type_versions v JOIN logbook_types t ON t.id = v.type_id WHERE v.id = $1', [typeVersionId])).rows[0];
  if (v?.needs_qa_review) throw new HttpError(409, 'type_not_reviewed',
    `${what}: the logbook type "${v.name}" (version ${v.version_no}) is built in and has not been reviewed by QA yet. QA reviews it in Logbook types before it is used.`);
}

/** QA reviews a built-in type version with a signature (meaning reviewed); the reason or remark is the comment. */
export async function reviewBuiltIn(x: Ctx, typeId: string, vid: string, input: { password: string; comment: string }) {
  const v = (await x.c.query<{ id: string; version_no: number; needs_qa_review: boolean; definition: unknown; code: string }>(
    'SELECT v.id, v.version_no, v.needs_qa_review, v.definition, t.code FROM logbook_type_versions v JOIN logbook_types t ON t.id = v.type_id WHERE v.id = $1 AND v.type_id = $2 FOR UPDATE OF v',
    [vid, typeId])).rows[0];
  if (!v) throw notFound('No such version of this logbook type.');
  if (!v.needs_qa_review) throw new HttpError(409, 'no_review_needed', 'This version does not wait for a QA review (it was approved by QA, or already reviewed).');
  await sign(x.c, x.pool, x.check, { signer: { userId: x.actor.userId, username: x.actor.username, displayName: x.actor.displayName ?? x.actor.username },
    password: input.password, meaning: 'reviewed', entity: 'logbook_type_version', entityId: vid, recordVersion: v.version_no,
    record: { code: v.code, versionNo: v.version_no, definition: v.definition }, comment: input.comment, requestId: x.requestId });
  await x.c.query('UPDATE logbook_type_versions SET needs_qa_review = false, qa_reviewed_by = $2, qa_reviewed_at = now(), version = version + 1, updated_at = now() WHERE id = $1', [vid, x.actor.username]);
  await writeAudit(x.c, { actorId: x.actor.userId, actorName: x.actor.username, action: 'logbook_type.qa_reviewed', entity: 'logbook_type', entityId: typeId,
    requestId: x.requestId, newValue: { code: v.code, version: v.version_no, reviewedBy: x.actor.username }, reason: input.comment });
  return { typeId, versionId: vid, versionNo: v.version_no, qaReviewedBy: x.actor.username };
}
