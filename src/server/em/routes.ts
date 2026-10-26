/**
 * The API of the environmental monitoring programme (roadmap M32, r2-em), registered on the env router (src/server/routes/env.ts).
 * Who may call each route is the route table's (src/server/authz/routeTable.ts): reading env.view, recording env.record, correcting a
 * recorded result env.correct (QA, Admin), the site map, limit profiles, batch windows and trend acknowledgement env.manage (QA, Admin).
 * Every write runs in one transaction with its audit entry, takes the row lock and checks the version it was given.
 */
import { randomBytes } from 'crypto';
import type { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { auditTrail } from '../../db/schema';
import { emBatchRooms, emExcursions, emLimitProfiles, emResults, emSamplingPoints, emTrendFlags } from '../../db/schema/em';
import { productBatches, products } from '../../db/schema/master';
import { qmsRecords } from '../../db/schema/qms';
import { writeAudit } from '../../db/utils';
import { utcToday } from '../../lib/validations/instruments';
import type { RouteContext } from '../core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../http/errors';
import { validate } from '../http/validate';
import { EM_LIMIT_APPROVAL, EM_STATUSES, isViable, METHOD_UNITS, type EmMethod } from './constants';
import { approvedProfile, findBatchEmResults, impactedBatches, judge, linkWindowToExcursions, openExcursion, type EmResult } from './engine';
import './entities';
import {
  batchRoomCreateSchema, batchRoomUpdateSchema, emptyBodySchema, heatmapQuerySchema, identificationSchema, pointCreateSchema, pointRetireSchema,
  pointUpdateSchema, profileApproveSchema, profileCreateSchema, profileUpdateSchema, resultCorrectionSchema, resultCreateSchema, resultQuerySchema,
  trendAcknowledgeSchema,
} from './schemas';
import { evaluateTrends } from './trends';

type Body<S extends z.ZodType> = z.infer<S>;
const actor = (req: unknown) => (req as { user: { id: string; role: string } }).user;
const locked = (what: string) => new AppError(423, 'RECORD_LOCKED', what);
const DAY = 86_400_000;

/** A unique code ignores case: "B104-01" and "b104-01" are the same point. */
async function assertCodeFree(tx: Tx, code: string) {
  const [dup] = await tx.select({ id: emSamplingPoints.id }).from(emSamplingPoints).where(sql`lower(${emSamplingPoints.code}) = lower(${code})`).limit(1);
  if (dup) throw new AppError(409, 'DUPLICATE_CODE', `Sampling point code ${code} is already used by ${dup.id}.`);
}

/** The approver of a limit profile wrote no part of it (created or edited it): 403 SOD_VIOLATION. */
async function assertIndependentApprover(ex: Tx | RouteContext['db'], profileId: string, userId: string) {
  const [wrote] = await ex.select({ id: auditTrail.id }).from(auditTrail)
    .where(and(eq(auditTrail.entity, 'EmLimitProfile'), eq(auditTrail.entityId, profileId), eq(auditTrail.userId, userId), inArray(auditTrail.action, ['Create', 'Update'])))
    .limit(1);
  if (wrote) throw new AppError(403, 'SOD_VIOLATION', 'A limit profile is approved by someone who did not write or edit it.');
}

function checkIncubation(b: { sampledOn: string; incubationStartedAt?: string; incubationEndedAt?: string }, now: Date) {
  // One day of slack: the sampling day is a local calendar day, the incubation start an instant.
  if (b.incubationStartedAt && Date.parse(b.incubationStartedAt) < Date.parse(`${b.sampledOn}T00:00:00Z`) - DAY) {
    throw new ValidationError('Incubation cannot start before the sample was taken.', [{ path: 'incubationStartedAt', message: 'Incubation starts on or after the sampling day.' }]);
  }
  if (b.incubationEndedAt && Date.parse(b.incubationEndedAt) > now.getTime() + 5 * 60_000) {
    throw new ValidationError('Incubation cannot end in the future: a plate is read after incubation.', [{ path: 'incubationEndedAt', message: 'Incubation end is in the future.' }]);
  }
}

const notFuture = (day: string, path: string) => {
  if (day > utcToday()) throw new ValidationError('The sampling date cannot be in the future.', [{ path, message: 'The sampling date cannot be in the future.' }]);
};

async function excursionOf(ex: RouteContext['db'] | Tx, resultId: string) {
  const [e] = await ex.select({ id: emExcursions.id, deviationId: emExcursions.qmsRecordId }).from(emExcursions).where(eq(emExcursions.resultId, resultId)).limit(1);
  return e ?? null;
}

export function registerEmRoutes(router: Router, { db, requireAuth }: RouteContext): void {
  // ---- sampling points ---------------------------------------------------------------------------------------------------------

  router.get('/em/points', requireAuth, async (_req, res) => {
    res.json(await db.select().from(emSamplingPoints).orderBy(asc(emSamplingPoints.room), asc(emSamplingPoints.code)));
  });

  router.post('/em/points', requireAuth, validate(pointCreateSchema), async (req, res) => {
    const user = actor(req);
    const body = req.body as Body<typeof pointCreateSchema>;
    const point = await withTransaction(db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('em-point-code'))`);
      await assertCodeFree(tx, body.code);
      const row = { id: `EMP-${randomBytes(4).toString('hex')}`, code: body.code, room: body.room, description: body.description, grade: body.grade, status: 'Active', createdBy: user.id };
      const [created] = await tx.insert(emSamplingPoints).values(row).returning();
      await writeAudit(tx, user.id, 'Create', 'EmSamplingPoint', created.id, 'all', '', JSON.stringify(created), 'Sampling point added to the site map');
      return created;
    });
    res.json(point);
  });

  router.put('/em/points/:id', requireAuth, validate(pointUpdateSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { reason, expectedVersion, ...changes } = req.body as Body<typeof pointUpdateSchema>;
    const point = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emSamplingPoints, id);
      if (existing.status !== 'Active') throw locked(`Sampling point ${existing.code} is retired and cannot be changed.`);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const updated = await updateVersioned(tx, emSamplingPoints, id, expectedVersion, changes);
      await writeAudit(tx, user.id, 'Update', 'EmSamplingPoint', id, 'all', JSON.stringify(existing), JSON.stringify(updated), reason);
      return updated;
    });
    res.json(point);
  });

  router.post('/em/points/:id/retire', requireAuth, validate(pointRetireSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { reason, expectedVersion } = req.body as Body<typeof pointRetireSchema>;
    const point = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emSamplingPoints, id);
      if (existing.status !== 'Active') throw locked(`Sampling point ${existing.code} is already retired.`);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const updated = await updateVersioned(tx, emSamplingPoints, id, expectedVersion, { status: 'Retired' });
      await writeAudit(tx, user.id, 'StatusChange', 'EmSamplingPoint', id, 'status', 'Active', 'Retired', reason);
      return updated;
    });
    res.json(point);
  });

  // ---- limit profiles ----------------------------------------------------------------------------------------------------------

  router.get('/em/limit-profiles', requireAuth, async (_req, res) => {
    res.json(await db.select().from(emLimitProfiles).orderBy(asc(emLimitProfiles.grade), asc(emLimitProfiles.method), asc(emLimitProfiles.occupancy), desc(emLimitProfiles.createdAt)));
  });

  router.post('/em/limit-profiles', requireAuth, validate(profileCreateSchema), async (req, res) => {
    const user = actor(req);
    const body = req.body as Body<typeof profileCreateSchema>;
    const profile = await withTransaction(db, async (tx) => {
      const row = {
        id: `EML-${randomBytes(4).toString('hex')}`, grade: body.grade, method: body.method, occupancy: body.occupancy, isoClass: body.isoClass ?? null,
        unit: METHOD_UNITS[body.method as EmMethod], alertLimit: body.alertLimit ?? null, actionLimit: body.actionLimit, source: body.source,
        status: 'Draft', origin: 'entry', createdBy: user.id,
      };
      const [created] = await tx.insert(emLimitProfiles).values(row).returning();
      await writeAudit(tx, user.id, 'Create', 'EmLimitProfile', created.id, 'all', '', JSON.stringify(created), 'Limit profile drafted');
      return created;
    });
    res.json(profile);
  });

  router.put('/em/limit-profiles/:id', requireAuth, validate(profileUpdateSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { reason, expectedVersion, ...changes } = req.body as Body<typeof profileUpdateSchema>;
    const profile = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emLimitProfiles, id);
      if (existing.status !== 'Draft') throw locked(`Limit profile ${id} is ${existing.status}: an approved limit is changed by drafting and approving a new profile.`);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const next = { ...existing, ...changes };
      if (next.alertLimit !== null && next.alertLimit !== undefined && next.alertLimit > next.actionLimit) {
        throw new ValidationError('The alert limit cannot be above the action limit.', [{ path: 'alertLimit', message: 'The alert limit cannot be above the action limit.' }]);
      }
      if (!isViable(existing.method) && !next.isoClass) throw new ValidationError('A particle limit names the ISO class it is taken from.', [{ path: 'isoClass', message: 'Required for particles.' }]);
      const updated = await updateVersioned(tx, emLimitProfiles, id, expectedVersion, changes);
      await writeAudit(tx, user.id, 'Update', 'EmLimitProfile', id, 'all', JSON.stringify(existing), JSON.stringify(updated), reason || 'Draft limit profile edited');
      return updated;
    });
    res.json(profile);
  });

  router.post('/em/limit-profiles/:id/approve', requireAuth, validate(profileApproveSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { password, totpCode, reason, expectedVersion } = req.body as Body<typeof profileApproveSchema>;
    const [current] = await db.select().from(emLimitProfiles).where(eq(emLimitProfiles.id, id)).limit(1);
    if (!current) throw new NotFoundError(`Limit profile ${id} was not found.`);
    if (current.status !== 'Draft') throw locked(`Limit profile ${id} is ${current.status}; only a Draft is approved.`);
    if (current.version !== expectedVersion) throw new ConflictError();
    await assertIndependentApprover(db, id, user.id); // before the password is checked: a refusal costs no attempt

    const { result, signature } = await signRecord({
      db, user, meaningCode: EM_LIMIT_APPROVAL, credentials: { password, totpCode }, reason, entityType: 'EmLimitProfile', entityId: id,
      execute: async (tx) => {
        const p = await lockRow(tx, emLimitProfiles, id);
        if (p.status !== 'Draft') throw locked(`Limit profile ${id} is ${p.status}; only a Draft is approved.`);
        if (p.version !== expectedVersion) throw new ConflictError();
        await assertIndependentApprover(tx, id, user.id);
        const now = new Date();
        const [previous] = await tx.select().from(emLimitProfiles)
          .where(and(eq(emLimitProfiles.grade, p.grade), eq(emLimitProfiles.method, p.method), eq(emLimitProfiles.occupancy, p.occupancy), eq(emLimitProfiles.status, 'Approved')))
          .for('update');
        if (previous) {
          await updateVersioned(tx, emLimitProfiles, previous.id, previous.version, { status: 'Retired', retiredAt: now, supersededBy: id });
          await writeAudit(tx, user.id, 'StatusChange', 'EmLimitProfile', previous.id, 'status', 'Approved', 'Retired', `Superseded by limit profile ${id}`);
        }
        const approved = await updateVersioned(tx, emLimitProfiles, id, expectedVersion, { status: 'Approved', approvedBy: user.id, approvedAt: now });
        return {
          recordVersion: approved.version, result: { ...approved, superseded: previous?.id ?? null },
          audit: { action: 'Approve', field: 'status', oldValue: 'Draft', newValue: 'Approved', reason: reason || `Limit profile approved (${p.grade}, ${p.method}, ${p.occupancy})` },
        };
      },
    });
    res.json({ ...result, signature });
  });

  // ---- results -----------------------------------------------------------------------------------------------------------------

  router.get('/em/results', requireAuth, validate(resultQuerySchema, 'query'), async (req, res) => {
    const q = req.query as Body<typeof resultQuerySchema>;
    const where: SQL[] = [];
    if (q.pointId) where.push(eq(emResults.pointId, q.pointId));
    if (q.room) where.push(eq(emResults.room, q.room));
    if (q.status) where.push(eq(emResults.status, q.status));
    if (q.from) where.push(gte(emResults.sampledOn, q.from));
    if (q.to) where.push(lte(emResults.sampledOn, q.to));
    const rows = await db.select({ r: emResults, pointCode: emSamplingPoints.code, excursionId: emExcursions.id, deviationId: emExcursions.qmsRecordId, deviationState: qmsRecords.state })
      .from(emResults)
      .innerJoin(emSamplingPoints, eq(emSamplingPoints.id, emResults.pointId))
      .leftJoin(emExcursions, eq(emExcursions.resultId, emResults.id))
      .leftJoin(qmsRecords, eq(qmsRecords.id, emExcursions.qmsRecordId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(emResults.sampledOn), desc(emResults.recordedAt)).limit(500);
    res.json(rows.map(({ r, ...rest }) => ({ ...r, ...rest })));
  });

  router.post('/em/results', requireAuth, validate(resultCreateSchema), async (req, res) => {
    const user = actor(req);
    const body = req.body as Body<typeof resultCreateSchema>;
    const now = new Date();
    notFuture(body.sampledOn, 'sampledOn');
    checkIncubation(body, now);

    const response = await withTransaction(db, async (tx) => {
      const [point] = await tx.select().from(emSamplingPoints).where(eq(emSamplingPoints.id, body.pointId)).limit(1);
      if (!point) throw new ValidationError(`Sampling point ${body.pointId} does not exist.`, [{ path: 'pointId', message: 'Unknown sampling point.' }]);
      if (point.status !== 'Active') throw new AppError(409, 'POINT_RETIRED', `Sampling point ${point.code} is retired: no result is recorded against it.`);
      const profile = await approvedProfile(tx, point.grade, body.method, body.occupancy);
      const year = now.getUTCFullYear();
      const row = {
        id: `EMR-${year}-${String(await nextSequence(tx, `em-result:${year}`)).padStart(5, '0')}`,
        pointId: point.id, room: point.room, grade: point.grade, method: body.method, occupancy: body.occupancy, sampledOn: body.sampledOn,
        count: body.count, unit: profile.unit, mediaLot: body.mediaLot ?? null,
        incubationStartedAt: body.incubationStartedAt ? new Date(body.incubationStartedAt) : null,
        incubationEndedAt: body.incubationEndedAt ? new Date(body.incubationEndedAt) : null,
        incubationConditions: body.incubationConditions ?? null,
        organism: body.organism ?? null, identifiedBy: body.organism ? user.id : null, identifiedAt: body.organism ? now : null,
        status: judge(body.count, profile), limitProfileId: profile.id, limitAlert: profile.alertLimit, limitAction: profile.actionLimit,
        recordedBy: user.id, recordedAt: now,
      };
      const [result] = await tx.insert(emResults).values(row).returning();
      await writeAudit(tx, user.id, 'Create', 'EmResult', result.id, 'all', '', JSON.stringify(result), `Environmental monitoring result recorded at ${point.code}`);
      const excursion = result.status === 'Action' ? await openExcursion(tx, user.id, result, point) : null;
      return { ...result, pointCode: point.code, excursionId: excursion?.excursionId ?? null, deviationId: excursion?.deviationId ?? null, impactedBatches: excursion?.batches ?? [] };
    });
    res.json(response);
  });

  router.put('/em/results/:id', requireAuth, validate(resultCorrectionSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { reason, expectedVersion, ...changes } = req.body as Body<typeof resultCorrectionSchema>;
    if (changes.sampledOn) notFuture(changes.sampledOn, 'sampledOn');

    const response = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emResults, id);
      if (existing.version !== expectedVersion) throw new ConflictError();
      if (!isViable(existing.method) && (changes.mediaLot !== undefined || changes.organism !== undefined)) {
        throw new ValidationError('A particle count has no media lot or organism.', [{ path: changes.mediaLot !== undefined ? 'mediaLot' : 'organism', message: 'Not for a particle count.' }]);
      }
      const count = changes.count ?? existing.count;
      if (changes.organism !== undefined && count === 0) throw new ValidationError('An organism is identified only on a plate with growth.', [{ path: 'organism', message: 'The count is 0.' }]);
      const [point] = await tx.select().from(emSamplingPoints).where(eq(emSamplingPoints.id, existing.pointId)).limit(1);
      const profile = await approvedProfile(tx, existing.grade, existing.method, existing.occupancy);
      const set: Partial<EmResult> = {
        ...changes, status: judge(count, profile), limitProfileId: profile.id, limitAlert: profile.alertLimit, limitAction: profile.actionLimit, unit: profile.unit,
      };
      if (changes.organism !== undefined) Object.assign(set, { identifiedBy: user.id, identifiedAt: new Date() });
      const updated = await updateVersioned(tx, emResults, id, expectedVersion, set);
      await writeAudit(tx, user.id, 'Update', 'EmResult', id, 'all', JSON.stringify(existing), JSON.stringify(updated), reason);
      // A correction never closes an excursion; it opens one if the corrected result is Action and none exists.
      let excursion = await excursionOf(tx, id);
      if (updated.status === 'Action' && !excursion) {
        const opened = await openExcursion(tx, user.id, updated, point);
        excursion = { id: opened.excursionId, deviationId: opened.deviationId };
      }
      return { ...updated, excursionId: excursion?.id ?? null, deviationId: excursion?.deviationId ?? null };
    });
    res.json(response);
  });

  router.post('/em/results/:id/identification', requireAuth, validate(identificationSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { organism, expectedVersion } = req.body as Body<typeof identificationSchema>;
    const updated = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emResults, id);
      if (existing.version !== expectedVersion) throw new ConflictError();
      if (!isViable(existing.method) || existing.count === 0) throw new AppError(409, 'NO_GROWTH', 'An organism is identified only on a viable plate with growth.');
      if (existing.organism) throw new AppError(409, 'ALREADY_IDENTIFIED', `Result ${id} already names ${existing.organism}: a change is a correction by QA, with a reason.`);
      const row = await updateVersioned(tx, emResults, id, expectedVersion, { organism, identifiedBy: user.id, identifiedAt: new Date() });
      await writeAudit(tx, user.id, 'Update', 'EmResult', id, 'organism', '', organism, 'Organism identified');
      return row;
    });
    res.json(updated);
  });

  // ---- excursions, batch impact ------------------------------------------------------------------------------------------------

  router.get('/em/excursions', requireAuth, async (_req, res) => {
    const rows = await db.select({
      e: emExcursions, pointCode: emSamplingPoints.code, sampledOn: emResults.sampledOn, method: emResults.method, unit: emResults.unit,
      deviationState: qmsRecords.state, deviationClassification: qmsRecords.classification,
    }).from(emExcursions)
      .innerJoin(emResults, eq(emResults.id, emExcursions.resultId))
      .innerJoin(emSamplingPoints, eq(emSamplingPoints.id, emExcursions.pointId))
      .innerJoin(qmsRecords, eq(qmsRecords.id, emExcursions.qmsRecordId))
      .orderBy(desc(emExcursions.openedAt)).limit(500);
    const out: Array<Record<string, unknown>> = [];
    for (const { e, ...rest } of rows) out.push({ ...e, ...rest, batches: (await impactedBatches(db, e.room, rest.sampledOn)).map(b => b.batchNo) });
    res.json(out);
  });

  router.get('/em/batch-impact/:batch', requireAuth, async (req, res) => {
    res.json(await findBatchEmResults(db, String(req.params.batch)));
  });

  router.get('/em/batch-rooms', requireAuth, async (_req, res) => {
    res.json(await db.select({ w: emBatchRooms, batchNo: productBatches.batchNo, productName: products.name }).from(emBatchRooms)
      .innerJoin(productBatches, eq(productBatches.id, emBatchRooms.productBatchId)).innerJoin(products, eq(products.id, productBatches.productId))
      .orderBy(desc(emBatchRooms.fromDate)).limit(500)
      .then(rows => rows.map(({ w, ...rest }) => ({ ...w, ...rest }))));
  });

  const assertRoomMonitored = async (tx: Tx, room: string) => {
    const [p] = await tx.select({ id: emSamplingPoints.id }).from(emSamplingPoints).where(eq(emSamplingPoints.room, room)).limit(1);
    if (!p) throw new ValidationError(`Room ${room} has no sampling point: its EM results could never be matched to the batch.`, [{ path: 'room', message: 'No sampling point in this room.' }]);
  };

  router.post('/em/batch-rooms', requireAuth, validate(batchRoomCreateSchema), async (req, res) => {
    const user = actor(req);
    const body = req.body as Body<typeof batchRoomCreateSchema>;
    const response = await withTransaction(db, async (tx) => {
      const [batch] = await tx.select({ id: productBatches.id }).from(productBatches).where(eq(productBatches.id, body.productBatchId)).limit(1);
      if (!batch) throw new ValidationError(`Batch ${body.productBatchId} does not exist.`, [{ path: 'productBatchId', message: 'Unknown batch.' }]);
      await assertRoomMonitored(tx, body.room);
      const [created] = await tx.insert(emBatchRooms).values({ id: `EMB-${randomBytes(4).toString('hex')}`, ...body, createdBy: user.id }).returning();
      await writeAudit(tx, user.id, 'Create', 'EmBatchRoom', created.id, 'all', '', JSON.stringify(created), `Batch exposure in room ${body.room} recorded`);
      const linkedDeviations = await linkWindowToExcursions(tx, user.id, created);
      return { ...created, linkedDeviations };
    });
    res.json(response);
  });

  router.put('/em/batch-rooms/:id', requireAuth, validate(batchRoomUpdateSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { reason, expectedVersion, ...changes } = req.body as Body<typeof batchRoomUpdateSchema>;
    const response = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emBatchRooms, id);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const next = { ...existing, ...changes };
      if (next.fromDate > next.toDate) throw new ValidationError('The window ends on or after the day it starts.', [{ path: 'toDate', message: 'Before the start.' }]);
      if (changes.room) await assertRoomMonitored(tx, changes.room);
      const updated = await updateVersioned(tx, emBatchRooms, id, expectedVersion, changes);
      await writeAudit(tx, user.id, 'Update', 'EmBatchRoom', id, 'all', JSON.stringify(existing), JSON.stringify(updated), reason);
      // Links already made stay (append-only): a deviation that once concerned the batch is still listed in its dossier.
      const linkedDeviations = await linkWindowToExcursions(tx, user.id, updated);
      return { ...updated, linkedDeviations };
    });
    res.json(response);
  });

  // ---- adverse trends, heat grid -----------------------------------------------------------------------------------------------

  router.get('/em/trends', requireAuth, async (_req, res) => {
    res.json(await db.select({ t: emTrendFlags, pointCode: emSamplingPoints.code }).from(emTrendFlags)
      .innerJoin(emSamplingPoints, eq(emSamplingPoints.id, emTrendFlags.pointId))
      .orderBy(desc(emTrendFlags.detectedAt)).limit(500)
      .then(rows => rows.map(({ t, pointCode }) => ({ ...t, pointCode }))));
  });

  router.post('/em/trends/evaluate', requireAuth, validate(emptyBodySchema), async (req, res) => {
    res.json(await evaluateTrends(db, { actorId: actor(req).id }));
  });

  router.post('/em/trends/:id/acknowledge', requireAuth, validate(trendAcknowledgeSchema), async (req, res) => {
    const user = actor(req);
    const id = String(req.params.id);
    const { acknowledgement, expectedVersion } = req.body as Body<typeof trendAcknowledgeSchema>;
    const flag = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, emTrendFlags, id);
      if (existing.status !== 'Open') throw locked(`Trend ${id} is already acknowledged.`);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const updated = await updateVersioned(tx, emTrendFlags, id, expectedVersion, { status: 'Acknowledged', acknowledgedBy: user.id, acknowledgedAt: new Date(), acknowledgement });
      await writeAudit(tx, user.id, 'StatusChange', 'EmTrendFlag', id, 'status', 'Open', 'Acknowledged', acknowledgement);
      return updated;
    });
    res.json(flag);
  });

  /** The worst status per point and week (Monday to Sunday, UTC), for the last `weeks` weeks including this one. */
  router.get('/em/heatmap', requireAuth, validate(heatmapQuerySchema, 'query'), async (req, res) => {
    const weeks = (req.query as Body<typeof heatmapQuerySchema>).weeks ?? 12;
    const today = new Date(`${utcToday()}T00:00:00Z`);
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
    const columns = Array.from({ length: weeks }, (_, i) => utcToday(new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY)));
    const rows = await db.select({ pointId: emResults.pointId, sampledOn: emResults.sampledOn, status: emResults.status }).from(emResults)
      .where(gte(emResults.sampledOn, columns[0]));
    const points = await db.select().from(emSamplingPoints).orderBy(asc(emSamplingPoints.room), asc(emSamplingPoints.code));
    const rank = (s: string) => EM_STATUSES.indexOf(s as (typeof EM_STATUSES)[number]);
    const cells = new Map<string, { worst: string; n: number }>();
    for (const r of rows) {
      const col = Math.floor((Date.parse(`${r.sampledOn}T00:00:00Z`) - Date.parse(`${columns[0]}T00:00:00Z`)) / (7 * DAY));
      if (col < 0 || col >= weeks) continue;
      const k = `${r.pointId}|${col}`;
      const c = cells.get(k);
      if (!c) cells.set(k, { worst: r.status, n: 1 });
      else { c.n++; if (rank(r.status) > rank(c.worst)) c.worst = r.status; }
    }
    res.json({
      columns,
      rows: points.filter(p => p.status === 'Active' || columns.some((_, i) => cells.has(`${p.id}|${i}`))).map(p => ({
        pointId: p.id, code: p.code, room: p.room, grade: p.grade, status: p.status,
        cells: columns.map((_, i) => cells.get(`${p.id}|${i}`) ?? null),
      })),
    });
  });
}
