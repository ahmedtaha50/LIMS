// Domain: training (roadmap M05 "training-certify fix", M28 training matrix and qualification). Owned by r2-docs-training.
//
//   GET  /training                                   the matrix: users (no secrets), legacy certifications, curricula, assignments
//   POST /training/:userId/certify                   certification of a module, signed TRAINING_CERTIFICATION; only the LIMS
//                                                    curriculum's module can switch on the software-trained flag (M28)
//   GET  /training/curricula                         curricula with their documents
//   POST /training/curricula, PUT /training/curricula/:id   define or change a curriculum (QA); assignments follow at once
//   GET  /training/assignments[?userId&status&mine]  assignments, each with `overdue`
//   POST /training/assignments                       a manual assignment (QA)
//   POST /training/assignments/:id/acknowledge       read and understood, signed by the trainee (TRAINING_ACKNOWLEDGEMENT)
//   POST /training/assignments/:id/certify           on-the-job training, signed by a trainer who is not the trainee
//   GET  /training/qualifications[?userId]           per method: Qualified, NotQualified (overdue training) or Override
//   POST /training/qualifications/override           a QA override for one user and method, time-limited, signed with a reason
//   POST /training/qualifications/:id/revoke         ends an override early, with a reason
// Who may call what: src/server/authz/routeTable.ts. The actor is always req.user. Every change and its audit entry share a transaction.
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { trainingRecords, users } from '../../db/schema';
import { documents, documentVersions } from '../../db/schema/documents';
import { analystQualifications, OPEN_ASSIGNMENT_STATUSES, trainingAssignments, trainingCurricula, trainingCurriculumDocuments } from '../../db/schema/training';
import { writeAudit } from '../../db/utils';
import { ROLE_NAMES } from '../../lib/permissions';
import { securityEventContext } from '../auth/events';
import { trainingUser } from '../auth/publicUser';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Executor } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { todayIso } from '../lib/specs';
import { methodByCode } from '../services/result-guards/method';
import { addDays, cancelCurriculumDocument, syncCurriculum } from '../training/assign';
import '../training/entities';
import {
  assignmentCreateSchema, assignmentSignSchema, certifySchema, curriculumCreateSchema, curriculumUpdateSchema, OVERRIDE_MAX_DAYS, overrideRevokeSchema, overrideSchema,
} from '../training/schemas';
import { curriculaOfMethod, isOverdue, namesCurriculum, qualificationFor, refreshSoftwareFlag, softwareCurriculum, type Qualification } from '../training/status';

type Actor = { id: string; role: string };
const newId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Assignments with the names a matrix shows, newest due first; `overdue` is derived from today's date. */
async function listAssignments(ex: Executor, where?: ReturnType<typeof and>, today = todayIso()) {
  const q = ex.select({
    a: trainingAssignments, userName: users.name, curriculumTitle: trainingCurricula.title, curriculumCode: trainingCurricula.code,
    documentTitle: documents.title, documentCode: documents.code, revision: documentVersions.revision,
  }).from(trainingAssignments)
    .innerJoin(users, eq(users.id, trainingAssignments.userId))
    .innerJoin(trainingCurricula, eq(trainingCurricula.id, trainingAssignments.curriculumId))
    .leftJoin(documents, eq(documents.id, trainingAssignments.documentId))
    .leftJoin(documentVersions, eq(documentVersions.id, trainingAssignments.documentVersionId));
  const rows = await (where ? q.where(where) : q).orderBy(desc(trainingAssignments.dueDate), asc(users.name)).limit(2000);
  return rows.map(r => ({
    ...r.a, createdAt: r.a.createdAt.toISOString(), completedAt: iso(r.a.completedAt), overdue: isOverdue(r.a, today),
    userName: r.userName, curriculumTitle: r.curriculumTitle, curriculumCode: r.curriculumCode, documentTitle: r.documentTitle, documentCode: r.documentCode, revision: r.revision,
  }));
}

async function listCurricula(ex: Executor) {
  const curricula = await ex.select().from(trainingCurricula).orderBy(sql`lower(${trainingCurricula.code})`);
  const docs = await ex.select({ curriculumId: trainingCurriculumDocuments.curriculumId, id: documents.id, code: documents.code, title: documents.title })
    .from(trainingCurriculumDocuments).innerJoin(documents, eq(documents.id, trainingCurriculumDocuments.documentId)).orderBy(sql`lower(${documents.code})`);
  return curricula.map(c => ({ ...c, createdAt: c.createdAt.toISOString(), documents: docs.filter(d => d.curriculumId === c.id).map(({ curriculumId: _c, ...d }) => d) }));
}

async function assertDocumentsExist(ex: Executor, ids: readonly string[]) {
  if (ids.length === 0) return;
  const found = await ex.select({ id: documents.id }).from(documents).where(inArray(documents.id, [...ids]));
  const missing = ids.filter(id => !found.some(f => f.id === id));
  if (missing.length) throw new BadRequestError(`Document(s) ${missing.join(', ')} do not exist.`);
}

/** Puts the curriculum's document list to `wanted`, auditing each addition and removal; removed documents' open assignments are cancelled. */
async function setCurriculumDocuments(ex: Executor, actor: Actor, curriculumId: string, wanted: readonly string[]) {
  const current = await ex.select().from(trainingCurriculumDocuments).where(eq(trainingCurriculumDocuments.curriculumId, curriculumId));
  for (const d of wanted.filter(id => !current.some(c => c.documentId === id))) {
    await ex.insert(trainingCurriculumDocuments).values({ id: newId('TCD'), curriculumId, documentId: d, addedBy: actor.id });
    await writeAudit(ex, actor.id, 'Update', 'TrainingCurriculum', curriculumId, 'documents', '', `+${d}`, `Document ${d} added to the curriculum`);
  }
  for (const c of current.filter(c => !wanted.includes(c.documentId))) {
    await ex.delete(trainingCurriculumDocuments).where(eq(trainingCurriculumDocuments.id, c.id));
    await writeAudit(ex, actor.id, 'Update', 'TrainingCurriculum', curriculumId, 'documents', `${c.documentId}`, `-${c.documentId}`, `Document ${c.documentId} removed from the curriculum`);
    await cancelCurriculumDocument(ex, actor.id, curriculumId, c.documentId, `Document ${c.documentId} was removed from the curriculum`);
  }
}

export const trainingRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actorOf = (req: Request) => (req as any).user as Actor;
  const certifierOnly: RequestHandler = (req, _res, next) =>
    next(['Admin', 'QA'].includes((req as any).user.role) ? undefined : new ForbiddenError('Only Admin or QA can certify training.'));

  // ---- the matrix --------------------------------------------------------------------------------------------------------------

  router.get('/training', requireAuth, async (_req, res) => {
    // Service and instrument accounts are never trained: the matrix lists the four human roles.
    const people = await db.select().from(users).where(inArray(users.role, [...ROLE_NAMES])).orderBy(asc(users.name));
    const records = await db.select().from(trainingRecords);
    res.json({ users: people.map(trainingUser), records, curricula: await listCurricula(db), assignments: await listAssignments(db) });
  });

  router.post('/training/:userId/certify', requireAuth, certifierOnly, validate(certifySchema), async (req, res) => {
    const certifier = actorOf(req);
    const targetId = String(req.params.userId);
    const { password, totpCode, moduleName } = req.body as z.infer<typeof certifySchema>;
    if (targetId === certifier.id) throw new AppError(403, 'SELF_CERTIFICATION_FORBIDDEN', 'You cannot certify your own training. Another Administrator or QA officer must do it.');
    const alreadyDone = async (ex: Executor, name: string) => {
      const done = await ex.select({ id: trainingRecords.id }).from(trainingRecords)
        .where(and(eq(trainingRecords.userId, targetId), eq(trainingRecords.moduleName, moduleName), eq(trainingRecords.status, 'Completed'))).limit(1);
      if (done.length > 0) throw new AppError(409, 'ALREADY_CERTIFIED', `${name} is already certified for ${moduleName}.`);
    };
    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) throw new NotFoundError(`users ${targetId} was not found.`);
    await alreadyDone(db, target.name);

    // The signature is on the training record it creates (a TrainingRecord), with the certification meaning.
    const recordId = newId('TRN');
    const { result } = await signRecord({
      db, user: certifier, meaningCode: 'TRAINING_CERTIFICATION', credentials: { password, totpCode }, entityType: 'TrainingRecord', entityId: recordId,
      context: securityEventContext(req),
      execute: async (tx) => {
        const locked = await lockRow(tx, users, targetId);
        await alreadyDone(tx, locked.name);
        const [record] = await tx.insert(trainingRecords).values({
          id: recordId, userId: targetId, moduleName, status: 'Completed', completedAt: new Date(), certifiedBy: certifier.id,
        }).returning();
        // Only the LIMS curriculum's module can switch on the e-signature gate; any other module is recorded and nothing more (M28).
        const lims = await softwareCurriculum(tx);
        if (namesCurriculum(lims, moduleName)) await refreshSoftwareFlag(tx, targetId, certifier.id, todayIso(), `${moduleName} certified by ${certifier.role}`);
        const [after] = await tx.select({ flag: users.hasCompletedSoftwareTraining }).from(users).where(eq(users.id, targetId));
        return {
          recordVersion: record.version,
          audit: { action: 'Certify', field: 'training', oldValue: '', newValue: `${moduleName} (${targetId})`, reason: `Training certified: ${moduleName} for ${locked.name} (meaning: certification by ${certifier.role})` },
          result: after.flag,
        };
      },
    });
    res.json({ success: true, hasCompletedSoftwareTraining: result });
  });

  // ---- curricula ---------------------------------------------------------------------------------------------------------------

  router.get('/training/curricula', requireAuth, async (_req, res) => {
    res.json(await listCurricula(db));
  });

  router.post('/training/curricula', requireAuth, validate(curriculumCreateSchema), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof curriculumCreateSchema>;
    const created = await withTransaction(db, async (tx) => {
      const [dup] = await tx.select({ code: trainingCurricula.code }).from(trainingCurricula).where(sql`lower(${trainingCurricula.code}) = ${body.code.toLowerCase()}`).limit(1);
      if (dup) throw new AppError(409, 'DUPLICATE', `A curriculum with the code ${dup.code} already exists.`);
      await assertDocumentsExist(tx, body.documentIds ?? []);
      const row = {
        id: newId('CUR'), code: body.code, title: body.title, description: body.description ?? '', methodCode: body.methodCode ?? null, roles: body.roles ?? [],
        mandatory: body.mandatory ?? true, dueDays: body.dueDays ?? 30, trainingMethod: body.trainingMethod, isSoftware: false, createdBy: actor.id,
      };
      const [c] = await tx.insert(trainingCurricula).values(row).returning();
      await writeAudit(tx, actor.id, 'Create', 'TrainingCurriculum', c.id, 'all', '', JSON.stringify(row), `Curriculum ${c.code} defined`);
      await setCurriculumDocuments(tx, actor, c.id, body.documentIds ?? []);
      await syncCurriculum(tx, actor.id, c, todayIso(), 'auto:curriculum');
      return c;
    });
    res.json({ ...created, createdAt: created.createdAt.toISOString() });
  });

  router.put('/training/curricula/:id', requireAuth, validate(curriculumUpdateSchema), async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const { expectedVersion, documentIds, ...changes } = req.body as z.infer<typeof curriculumUpdateSchema>;
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, trainingCurricula, id);
      if (current.version !== expectedVersion) throw new ConflictError();
      const text = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v));
      const set = Object.fromEntries(Object.entries(changes).filter(([k, v]) => v !== undefined && text(v) !== text((current as any)[k])));
      if (Object.keys(set).length === 0 && documentIds === undefined) throw new BadRequestError('Nothing changes: the values sent are the values the curriculum already holds.');
      // The version moves on every accepted change, document list included, so a second editor with the old version gets 409.
      const row = await updateVersioned(tx, trainingCurricula, id, expectedVersion, set);
      for (const [field, value] of Object.entries(set)) {
        await writeAudit(tx, actor.id, 'Update', 'TrainingCurriculum', id, field, text((current as any)[field]), text(value), `Curriculum ${current.code}: ${field} changed`);
      }
      if (documentIds !== undefined) {
        await assertDocumentsExist(tx, documentIds);
        await setCurriculumDocuments(tx, actor, id, documentIds);
      }
      await syncCurriculum(tx, actor.id, row, todayIso(), 'auto:curriculum');
      return row;
    });
    res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  });

  // ---- assignments -------------------------------------------------------------------------------------------------------------

  router.get('/training/assignments', requireAuth, async (req, res) => {
    const me = actorOf(req);
    const userId = req.query.mine === 'true' ? me.id : typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const conditions = [userId ? eq(trainingAssignments.userId, userId) : undefined, status ? eq(trainingAssignments.status, status) : undefined].filter(Boolean);
    res.json(await listAssignments(db, conditions.length ? and(...conditions as any) : undefined));
  });

  router.post('/training/assignments', requireAuth, validate(assignmentCreateSchema), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof assignmentCreateSchema>;
    const row = await withTransaction(db, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, body.userId)).limit(1);
      if (!user || !user.active || !(ROLE_NAMES as readonly string[]).includes(user.role)) throw new BadRequestError(`${body.userId} is not an active user who can be trained.`);
      const curriculum = await lockRow(tx, trainingCurricula, body.curriculumId);
      let versionId: string | null = null;
      if (body.documentId) {
        const [v] = await tx.select({ id: documentVersions.id }).from(documentVersions)
          .where(and(eq(documentVersions.documentId, body.documentId), eq(documentVersions.status, 'Effective'))).limit(1);
        if (!v) throw new BadRequestError(`Document ${body.documentId} has no Effective version to train on.`);
        versionId = v.id;
      }
      const values = {
        id: newId('TA'), userId: body.userId, curriculumId: curriculum.id, documentId: body.documentId ?? null, documentVersionId: versionId,
        trainingMethod: curriculum.trainingMethod, dueDate: body.dueDate, status: 'Assigned', origin: 'manual', createdBy: actor.id,
      };
      const [inserted] = await tx.insert(trainingAssignments).values(values).onConflictDoNothing().returning();
      if (!inserted) throw new AppError(409, 'ALREADY_ASSIGNED', `${user.name} already has this training assigned.`);
      await writeAudit(tx, actor.id, 'Assign', 'TrainingAssignment', values.id, 'all', '', JSON.stringify(values), `Training assigned manually (${curriculum.code}), due ${body.dueDate}`);
      if (curriculum.isSoftware) await refreshSoftwareFlag(tx, body.userId, actor.id, todayIso(), `assignment ${values.id}`);
      return inserted;
    });
    res.json({ ...row, createdAt: row.createdAt.toISOString(), completedAt: null, overdue: isOverdue(row, todayIso()) });
  });

  /** Completes an assignment with the signature of `meaning`; `who` decides whether the actor may sign it. */
  const complete = (meaning: 'TRAINING_ACKNOWLEDGEMENT' | 'TRAINING_CERTIFICATION', method: 'READ_AND_UNDERSTOOD' | 'OJT') => async (req: Request, res: any) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const { password, totpCode, reason, expectedVersion } = req.body as z.infer<typeof assignmentSignSchema>;
    const check = (a: typeof trainingAssignments.$inferSelect) => {
      if (!(OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Assignment ${a.id} is ${a.status}; only open training is completed.`);
      if (a.trainingMethod !== method) {
        throw new AppError(409, 'WRONG_TRAINING_METHOD', a.trainingMethod === 'OJT'
          ? `Assignment ${a.id} is on-the-job training: a trainer certifies it.` : `Assignment ${a.id} is read and understood: the trainee signs it.`);
      }
      if (method === 'READ_AND_UNDERSTOOD' && a.userId !== actor.id) throw new ForbiddenError('Only the trainee signs their own training as read and understood.');
      if (method === 'OJT' && a.userId === actor.id) throw new AppError(403, 'SELF_CERTIFICATION_FORBIDDEN', 'You cannot certify your own on-the-job training. Another trainer must do it.');
      if (a.version !== expectedVersion) throw new ConflictError();
    };
    const [first] = await db.select().from(trainingAssignments).where(eq(trainingAssignments.id, id)).limit(1);
    if (!first) throw new NotFoundError(`Assignment ${id} was not found.`);
    check(first);
    const { result, signature } = await signRecord({
      db, user: actor, meaningCode: meaning, credentials: { password, totpCode }, reason, entityType: 'TrainingAssignment', entityId: id,
      context: securityEventContext(req),
      execute: async (tx) => {
        const a = await lockRow(tx, trainingAssignments, id);
        check(a);
        const [v] = a.documentVersionId
          ? await tx.select({ sha: documentVersions.fileSha256, revision: documentVersions.revision }).from(documentVersions).where(eq(documentVersions.id, a.documentVersionId))
          : [];
        const row = await updateVersioned(tx, trainingAssignments, id, expectedVersion, {
          status: 'Completed', completedBy: actor.id, completedAt: new Date(), trainerId: method === 'OJT' ? actor.id : null,
        });
        const lims = await softwareCurriculum(tx);
        if (lims && lims.id === a.curriculumId) await refreshSoftwareFlag(tx, a.userId, actor.id, todayIso(), `assignment ${id} completed`);
        const what = v ? `rev ${v.revision} sha256:${v.sha}` : 'no document';
        return {
          recordVersion: row.version,
          audit: {
            action: method === 'OJT' ? 'CertifyTraining' : 'Acknowledge', field: 'status', oldValue: a.status, newValue: `Completed (${what})`,
            reason: method === 'OJT' ? `On-the-job training of ${a.userId} certified by trainer ${actor.id}` : 'Training read and understood',
          },
          result: row,
        };
      },
    });
    res.json({ assignment: { ...result, createdAt: result.createdAt.toISOString(), completedAt: iso(result.completedAt) }, signature });
  };
  router.post('/training/assignments/:id/acknowledge', requireAuth, validate(assignmentSignSchema), complete('TRAINING_ACKNOWLEDGEMENT', 'READ_AND_UNDERSTOOD'));
  router.post('/training/assignments/:id/certify', requireAuth, validate(assignmentSignSchema), complete('TRAINING_CERTIFICATION', 'OJT'));

  // ---- qualifications ----------------------------------------------------------------------------------------------------------

  router.get('/training/qualifications', requireAuth, async (req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : actorOf(req).id;
    const today = todayIso();
    const codes = await db.selectDistinct({ code: trainingCurricula.methodCode }).from(trainingCurricula)
      .where(and(eq(trainingCurricula.mandatory, true), sql`${trainingCurricula.methodCode} IS NOT NULL`));
    // Methods that name a curriculum as their required training module are gated by it too.
    const viaModule = await db.execute(sql`SELECT DISTINCT m.code FROM methods m JOIN training_curricula c ON lower(c.code) = lower(m.required_training_module) WHERE c.mandatory`);
    const all = [...new Set([...codes.map(c => c.code!), ...((viaModule as any).rows as Array<{ code: string }>).map(r => r.code)])].sort();
    const out: Qualification[] = [];
    for (const code of all) out.push(await qualificationFor(db, userId, code, today));
    res.json(out);
  });

  router.post('/training/qualifications/override', requireAuth, validate(overrideSchema), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof overrideSchema>;
    const today = todayIso();
    if (body.validUntil < today) throw new BadRequestError('validUntil is in the past.');
    if (body.validUntil > addDays(today, OVERRIDE_MAX_DAYS)) throw new BadRequestError(`An override lasts at most ${OVERRIDE_MAX_DAYS} days (until ${addDays(today, OVERRIDE_MAX_DAYS)}).`);
    if (body.userId === actor.id) throw new AppError(403, 'SELF_CERTIFICATION_FORBIDDEN', 'You cannot authorise an override for yourself.');
    const [user] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, body.userId)).limit(1);
    if (!user?.active) throw new BadRequestError(`${body.userId} is not an active user.`);
    if (!(await methodByCode(db, body.methodCode))) throw new BadRequestError(`Method ${body.methodCode} does not exist.`);
    if ((await curriculaOfMethod(db, body.methodCode)).length === 0) throw new BadRequestError(`No mandatory curriculum gates method ${body.methodCode}: there is nothing to override.`);
    const id = newId('AQ');
    const { result, signature } = await signRecord({
      db, user: actor, meaningCode: 'QUALIFICATION_OVERRIDE', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
      entityType: 'AnalystQualification', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const values = { id, userId: body.userId, methodCode: body.methodCode, basis: 'QA_OVERRIDE', reason: body.reason, validUntil: body.validUntil, status: 'Active', grantedBy: actor.id };
        const [row] = await tx.insert(analystQualifications).values(values).returning();
        return {
          recordVersion: row.version,
          audit: { action: 'Create', field: 'all', oldValue: '', newValue: JSON.stringify(values), reason: body.reason },
          result: row,
        };
      },
    });
    res.json({ qualification: result, signature });
  });

  router.post('/training/qualifications/:id/revoke', requireAuth, validate(overrideRevokeSchema), async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const { reason, expectedVersion } = req.body as z.infer<typeof overrideRevokeSchema>;
    const row = await withTransaction(db, async (tx) => {
      const q = await lockRow(tx, analystQualifications, id);
      if (q.status !== 'Active') throw new AppError(409, 'ILLEGAL_TRANSITION', `Override ${id} is ${q.status}.`);
      if (q.version !== expectedVersion) throw new ConflictError();
      const updated = await updateVersioned(tx, analystQualifications, id, expectedVersion, { status: 'Revoked', revokedBy: actor.id, revokedAt: new Date(), revokeReason: reason });
      await writeAudit(tx, actor.id, 'Revoke', 'AnalystQualification', id, 'status', 'Active', 'Revoked', reason);
      return updated;
    });
    res.json(row);
  });

  return router;
};
