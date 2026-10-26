/**
 * Who has to be trained on what (roadmap M28). Every function runs in the caller's transaction and writes one audit entry per
 * assignment it creates or closes, so an assignment and its reason commit together with the event that caused it.
 *
 *   assignEffectiveVersion   a document version became Effective: the open assignments of its earlier versions are Superseded and
 *                            each curriculum that contains the document assigns the new version to every user of its roles
 *   cancelVersionAssignments a version was withdrawn (Obsolete): its open assignments are Cancelled
 *   syncCurriculum           a curriculum was created or changed, or the daily job runs: every user of its roles gets the Effective
 *                            version of each of its documents (users added later, documents added later)
 *
 * Due dates are calendar days (YYYY-MM-DD) of the server: today + the curriculum's due days. A user is eligible when the account is
 * active and has one of the four human roles (service accounts are never trained) and, when the curriculum names roles, one of them.
 */
import { randomBytes } from 'crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { documents, documentVersions } from '../../db/schema/documents';
import { users } from '../../db/schema';
import { OPEN_ASSIGNMENT_STATUSES, trainingAssignments, trainingCurricula, trainingCurriculumDocuments } from '../../db/schema/training';
import { writeAudit } from '../../db/utils';
import { ROLE_NAMES } from '../../lib/permissions';
import { updateVersioned, type Executor } from '../core/tx';

export type CurriculumRow = typeof trainingCurricula.$inferSelect;
export type AssignmentRow = typeof trainingAssignments.$inferSelect;

export const newAssignmentId = () => `TA-${randomBytes(6).toString('hex').toUpperCase()}`;

/** The calendar day `days` after `day` (YYYY-MM-DD, no time zone involved). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Active users with a human role, limited to `roles` when the curriculum names any. */
export async function eligibleUsers(ex: Executor, roles: readonly string[]): Promise<Array<{ id: string; role: string }>> {
  const wanted = roles.length ? ROLE_NAMES.filter(r => roles.includes(r)) : [...ROLE_NAMES];
  if (wanted.length === 0) return [];
  return ex.select({ id: users.id, role: users.role }).from(users)
    .where(and(eq(users.active, true), inArray(users.role, wanted))).orderBy(users.id);
}

/** Assigns `version` to every eligible user of `curriculum` who does not have it yet. Returns the assignments created. */
async function assignVersion(ex: Executor, actorId: string, curriculum: CurriculumRow, version: { id: string; documentId: string; revision: number }, today: string, origin: string) {
  const created: AssignmentRow[] = [];
  const [doc] = await ex.select({ code: documents.code, title: documents.title }).from(documents).where(eq(documents.id, version.documentId)).limit(1);
  for (const u of await eligibleUsers(ex, curriculum.roles)) {
    const row = {
      id: newAssignmentId(), userId: u.id, curriculumId: curriculum.id, documentId: version.documentId, documentVersionId: version.id,
      trainingMethod: curriculum.trainingMethod, dueDate: addDays(today, curriculum.dueDays), status: 'Assigned', origin, createdBy: actorId,
    };
    const [inserted] = await ex.insert(trainingAssignments).values(row).onConflictDoNothing().returning();
    if (!inserted) continue; // already assigned (the unique index on user, curriculum and version)
    await writeAudit(ex, actorId, 'Assign', 'TrainingAssignment', row.id, 'all', '', JSON.stringify({
      userId: u.id, curriculum: curriculum.code, document: doc?.code, revision: version.revision, trainingMethod: row.trainingMethod, dueDate: row.dueDate,
    }), `Training assigned: ${doc?.code ?? version.documentId} revision ${version.revision} (${curriculum.code}), due ${row.dueDate}`);
    created.push(inserted);
  }
  return created;
}

/** Moves open assignments to `status` (Superseded or Cancelled), each with its audit entry. Returns the users concerned. */
async function closeOpen(ex: Executor, actorId: string, where: ReturnType<typeof and>, status: 'Superseded' | 'Cancelled', reason: string): Promise<AssignmentRow[]> {
  const open = await ex.select().from(trainingAssignments)
    .where(and(where, inArray(trainingAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]))).for('update');
  for (const a of open) {
    await updateVersioned(ex, trainingAssignments, a.id, a.version, { status });
    await writeAudit(ex, actorId, status === 'Superseded' ? 'Supersede' : 'Cancel', 'TrainingAssignment', a.id, 'status', a.status, status, reason);
  }
  return open;
}

/** Curricula that contain the document. */
export async function curriculaOfDocument(ex: Executor, documentId: string): Promise<CurriculumRow[]> {
  return ex.select({ c: trainingCurricula }).from(trainingCurriculumDocuments)
    .innerJoin(trainingCurricula, eq(trainingCurricula.id, trainingCurriculumDocuments.curriculumId))
    .where(eq(trainingCurriculumDocuments.documentId, documentId)).then(rows => rows.map(r => r.c));
}

/**
 * In the transaction that makes `version` Effective. Returns the ids of the users whose assignments changed (the caller re-derives the
 * software-trained flag for them when a software curriculum is involved).
 */
export async function assignEffectiveVersion(ex: Executor, actorId: string, version: { id: string; documentId: string; revision: number }, today: string) {
  const superseded = await closeOpen(ex, actorId,
    and(eq(trainingAssignments.documentId, version.documentId), ne(trainingAssignments.documentVersionId, version.id)),
    'Superseded', `Revision ${version.revision} became effective; the earlier revision no longer has to be trained`);
  const created: AssignmentRow[] = [];
  const curricula = await curriculaOfDocument(ex, version.documentId);
  for (const c of curricula) created.push(...await assignVersion(ex, actorId, c, version, today, 'auto:effective'));
  return { superseded, created, software: curricula.some(c => c.isSoftware) || superseded.length > 0 };
}

export async function cancelVersionAssignments(ex: Executor, actorId: string, versionId: string, reason: string) {
  return closeOpen(ex, actorId, eq(trainingAssignments.documentVersionId, versionId), 'Cancelled', reason);
}

/** Cancels the open assignments of a document that was taken out of a curriculum. */
export async function cancelCurriculumDocument(ex: Executor, actorId: string, curriculumId: string, documentId: string, reason: string) {
  return closeOpen(ex, actorId, and(eq(trainingAssignments.curriculumId, curriculumId), eq(trainingAssignments.documentId, documentId)), 'Cancelled', reason);
}

/** Every eligible user gets the Effective version of each document of the curriculum. */
export async function syncCurriculum(ex: Executor, actorId: string, curriculum: CurriculumRow, today: string, origin = 'auto:sync') {
  const effective = await ex.select({ id: documentVersions.id, documentId: documentVersions.documentId, revision: documentVersions.revision })
    .from(trainingCurriculumDocuments)
    .innerJoin(documentVersions, and(eq(documentVersions.documentId, trainingCurriculumDocuments.documentId), eq(documentVersions.status, 'Effective')))
    .where(eq(trainingCurriculumDocuments.curriculumId, curriculum.id));
  const created: AssignmentRow[] = [];
  for (const v of effective) created.push(...await assignVersion(ex, actorId, curriculum, v, today, origin));
  return created;
}
