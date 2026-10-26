/**
 * What a user's training records mean (roadmap M28), derived from training_assignments, never from a flag someone sets:
 *
 *   overdue                 an open assignment past its due date (status Overdue, or Assigned with due_date before today: the guard
 *                           does not wait for the daily job)
 *   qualificationFor        per method: NotQualified while the user has an overdue assignment of a mandatory curriculum of that
 *                           method (method_code, or the method's required_training_module naming the curriculum code); Override while
 *                           an Active QA override covers today; Qualified otherwise
 *   refreshSoftwareFlag     users.has_completed_software_training, the global e-signature gate, from the LIMS curriculum only:
 *                             false  while an assignment of the LIMS curriculum is overdue;
 *                             true   when none is overdue and the user has completed LIMS training (an assignment of the LIMS
 *                                    curriculum, or a certification of its module in training_records);
 *                             else   unchanged (a new assignment, not yet due, revokes nothing; an existing installation keeps
 *                                    the value it had).
 *                           A change is written with the version predicate and audited in the caller's transaction.
 */
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { trainingRecords, users } from '../../db/schema';
import { analystQualifications, trainingAssignments, trainingCurricula } from '../../db/schema/training';
import { writeAudit } from '../../db/utils';
import { methodByCode } from '../services/result-guards/method';
import { lockRow, updateVersioned, type Executor } from '../core/tx';

/** SQL: the assignment is open and past due on `today`. */
export const overdueCondition = (today: string) => or(
  eq(trainingAssignments.status, 'Overdue'),
  and(eq(trainingAssignments.status, 'Assigned'), lt(trainingAssignments.dueDate, today)),
)!;

export const isOverdue = (a: { status: string; dueDate: string }, today: string) => a.status === 'Overdue' || (a.status === 'Assigned' && a.dueDate < today);

export async function softwareCurriculum(ex: Executor) {
  const [c] = await ex.select().from(trainingCurricula).where(eq(trainingCurricula.isSoftware, true)).limit(1);
  return c ?? null;
}

/** Whether `moduleName` names the LIMS curriculum (its code or title, ignoring case and surrounding spaces). */
export const namesCurriculum = (c: { code: string; title: string } | null, moduleName: string) =>
  !!c && [c.code, c.title].some(n => n.trim().toLowerCase() === moduleName.trim().toLowerCase());

/** Re-derives the flag; returns the new value when it changed, else null. */
export async function refreshSoftwareFlag(ex: Executor, userId: string, actorId: string, today: string, why: string): Promise<boolean | null> {
  const lims = await softwareCurriculum(ex);
  if (!lims) return null;
  const [overdue] = await ex.select({ id: trainingAssignments.id }).from(trainingAssignments)
    .where(and(eq(trainingAssignments.userId, userId), eq(trainingAssignments.curriculumId, lims.id), overdueCondition(today))).limit(1);
  let derived: boolean | null;
  if (overdue) derived = false;
  else {
    const [done] = await ex.select({ id: trainingAssignments.id }).from(trainingAssignments)
      .where(and(eq(trainingAssignments.userId, userId), eq(trainingAssignments.curriculumId, lims.id), eq(trainingAssignments.status, 'Completed'))).limit(1);
    const [certified] = done ? [done] : await ex.select({ id: trainingRecords.id }).from(trainingRecords)
      .where(and(eq(trainingRecords.userId, userId), eq(trainingRecords.status, 'Completed'),
        sql`lower(btrim(${trainingRecords.moduleName})) IN (${lims.code.trim().toLowerCase()}, ${lims.title.trim().toLowerCase()})`)).limit(1);
    derived = done || certified ? true : null;
  }
  if (derived === null) return null;
  const user = await lockRow(ex, users, userId);
  if (user.hasCompletedSoftwareTraining === derived) return null;
  await updateVersioned(ex, users, userId, user.version, { hasCompletedSoftwareTraining: derived });
  await writeAudit(ex, actorId, 'Update', 'User', userId, 'hasCompletedSoftwareTraining', String(user.hasCompletedSoftwareTraining), String(derived),
    `Derived from the ${lims.code} curriculum: ${why}`);
  return derived;
}

export type QualificationStatus = 'Qualified' | 'NotQualified' | 'Override';
export interface Qualification {
  methodCode: string;
  status: QualificationStatus;
  /** The overdue assignments that make the user not qualified. */
  overdue: string[];
  overrideId: string | null;
  overrideUntil: string | null;
}

/** The mandatory curricula that gate a method. */
export async function curriculaOfMethod(ex: Executor, methodCode: string) {
  const method = await methodByCode(ex, methodCode);
  const module = method?.requiredTrainingModule?.trim().toLowerCase();
  const byCode = sql`lower(${trainingCurricula.methodCode}) = ${methodCode.trim().toLowerCase()}`;
  return ex.select().from(trainingCurricula)
    .where(and(eq(trainingCurricula.mandatory, true), module ? or(byCode, sql`lower(${trainingCurricula.code}) = ${module}`) : byCode));
}

export async function activeOverride(ex: Executor, userId: string, methodCode: string, today: string) {
  const [row] = await ex.select().from(analystQualifications).where(and(
    eq(analystQualifications.userId, userId), sql`lower(${analystQualifications.methodCode}) = ${methodCode.trim().toLowerCase()}`,
    eq(analystQualifications.status, 'Active'), gte(analystQualifications.validUntil, today),
  )).orderBy(sql`${analystQualifications.validUntil} DESC`).limit(1);
  return row ?? null;
}

export async function qualificationFor(ex: Executor, userId: string, methodCode: string, today: string): Promise<Qualification> {
  const curricula = await curriculaOfMethod(ex, methodCode);
  const overdue = curricula.length === 0 ? [] : await ex.select({ id: trainingAssignments.id }).from(trainingAssignments).where(and(
    eq(trainingAssignments.userId, userId), inArray(trainingAssignments.curriculumId, curricula.map(c => c.id)), overdueCondition(today),
  ));
  const base = { methodCode, overdue: overdue.map(o => o.id), overrideId: null, overrideUntil: null };
  if (overdue.length === 0) return { ...base, status: 'Qualified' };
  const o = await activeOverride(ex, userId, methodCode, today);
  return o ? { ...base, status: 'Override', overrideId: o.id, overrideUntil: o.validUntil } : { ...base, status: 'NotQualified' };
}
