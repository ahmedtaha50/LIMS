// Domain: environmental monitoring. r2-em (roadmap M32) owns this file.
//
//   /em/*          the monitoring programme: sampling points, approved limit profiles, results, excursions with their deviation, batch
//                  impact by room and date window, adverse trends and the heat grid (src/server/em/routes.ts). The screen uses these.
//   /env-records   the legacy records of r1-quality-fixes (roadmap M13), free-text location judged against env_limits by grade and
//                  sample type. Kept so the records made before the programme stay readable and correctable. An action-level legacy
//                  record now also opens its deviation (M27, source em-excursion) in the same transaction.
import { randomBytes } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { envExcursions, envLimits, envRecords } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { envRecordSchema, envRecordUpdateSchema, type EnvStatus } from '../../lib/validations/env';
import { utcToday } from '../../lib/validations/instruments';
import { recordDenied } from '../authz/denied';
import { registerEmRoutes } from '../em/routes';
import { autoOpenQmsRecord } from '../qms';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { AppError, ConflictError, ValidationError } from '../http/errors';
import { validate } from '../http/validate';

/** Who may correct a recorded count (conservative default, see docs/changes/r1-quality-fixes.md). */
export const ENV_EDIT_ROLES = ['QA', 'Admin'];

type Limit = typeof envLimits.$inferSelect;

async function activeLimit(tx: Tx, grade: string, sampleType: string): Promise<Limit> {
  const [limit] = await tx.select().from(envLimits)
    .where(and(eq(envLimits.grade, grade), eq(envLimits.sampleType, sampleType), eq(envLimits.active, true))).limit(1);
  if (!limit) {
    throw new ValidationError(`There is no active limit for ${grade} ${sampleType}: the result cannot be judged. QA must approve a limit for this combination first.`,
      [{ path: 'sampleType', message: 'No active limit for this grade and sample type.' }]);
  }
  return limit;
}

/** Above the action limit: Action. Above the alert limit (when the site set one): Alert. At a limit is not above it. */
export function evaluate(count: number, limit: Pick<Limit, 'alertLimit' | 'actionLimit'>): EnvStatus {
  if (count > limit.actionLimit) return 'Action';
  if (limit.alertLimit !== null && count > limit.alertLimit) return 'Alert';
  return 'Pass';
}

async function openExcursion(tx: Tx, userId: string, record: typeof envRecords.$inferSelect, limit: Limit) {
  const excursion = {
    id: `EXC-${randomBytes(4).toString('hex')}`, envRecordId: record.id, level: 'Action', grade: record.grade, sampleType: limit.sampleType,
    viableCount: record.viableCount, limitValue: limit.actionLimit, status: 'Open', openedBy: userId,
  };
  await tx.insert(envExcursions).values(excursion);
  await writeAudit(tx, userId, 'Create', 'EnvExcursion', excursion.id, 'all', '', JSON.stringify(excursion),
    `Action level exceeded: ${record.viableCount} CFU against an action limit of ${limit.actionLimit} (${record.grade}, ${limit.sampleType})`);
  await autoOpenQmsRecord(tx, {
    source: 'em-excursion', sourceId: record.id, actorId: userId,
    title: `EM action-level excursion at ${record.location} on ${record.date}`,
    description: `Environmental record ${record.id} (${record.grade}, ${limit.sampleType}): ${record.viableCount} CFU against an action limit of ${limit.actionLimit}. Excursion ${excursion.id}.`,
  });
  return excursion.id;
}

export const envRoutes = (ctx: RouteContext) => {
  const { db, requireAuth } = ctx;
  const router = createRouter();
  registerEmRoutes(router, ctx);

  router.post('/env-records', requireAuth, validate(envRecordSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as import('zod').infer<typeof envRecordSchema>;
    if (body.date > utcToday()) throw new ValidationError('The sampling date cannot be in the future.', [{ path: 'date', message: 'The sampling date cannot be in the future.' }]);

    const response = await withTransaction(db, async (tx) => {
      const limit = await activeLimit(tx, body.grade, body.sampleType);
      const record = {
        id: `ENV-${randomBytes(4).toString('hex')}`,
        location: body.location, grade: body.grade, sampleType: body.sampleType, date: body.date,
        viableCount: body.viableCount, nonViableCount: body.nonViableCount,
        status: evaluate(body.viableCount, limit), limitAlert: limit.alertLimit, limitAction: limit.actionLimit,
        testedBy: user.id, version: 1,
      };
      await tx.insert(envRecords).values(record);
      await writeAudit(tx, user.id, 'Create', 'EnvRecord', record.id, 'all', '', JSON.stringify(record), 'Environmental monitoring result recorded');
      const excursionId = record.status === 'Action' ? await openExcursion(tx, user.id, record, limit) : null;
      return { ...record, excursionId };
    });
    res.json(response);
  });

  router.put('/env-records/:id', requireAuth, validate(envRecordUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    if (!ENV_EDIT_ROLES.includes(user.role)) {
      await recordDenied(db, req, user, { rule: 'env.correct', roles: ENV_EDIT_ROLES, entity: 'EnvRecord', entityId: id });
      throw new AppError(403, 'ROLE_NOT_ALLOWED', 'A recorded environmental result is corrected by QA or an Administrator.');
    }
    const { expectedVersion, reason, ...changes } = req.body as import('zod').infer<typeof envRecordUpdateSchema>;

    const response = await withTransaction(db, async (tx) => {
      const existing = await lockRow(tx, envRecords, id);
      if (existing.version !== expectedVersion) throw new ConflictError();
      const sampleType = changes.sampleType ?? existing.sampleType;
      if (!sampleType) {
        throw new ValidationError('This record was made before sample types were recorded: give its sample type (Air, Settle plate, Contact plate, Glove print) with the correction.',
          [{ path: 'sampleType', message: 'The sample type is required.' }]);
      }
      const grade = changes.grade ?? existing.grade;
      const viableCount = changes.viableCount ?? existing.viableCount;
      const limit = await activeLimit(tx, grade, sampleType);
      const status = evaluate(viableCount, limit);

      const updated = await updateVersioned(tx, envRecords, id, expectedVersion, {
        location: changes.location ?? existing.location, grade, sampleType, viableCount,
        nonViableCount: changes.nonViableCount ?? existing.nonViableCount,
        status, limitAlert: limit.alertLimit, limitAction: limit.actionLimit,
      });
      await writeAudit(tx, user.id, 'Update', 'EnvRecord', id, 'all', JSON.stringify(existing), JSON.stringify(updated), reason);

      // A correction never closes an excursion; it opens one if the corrected result is Action and none is open.
      const excursion = await tx.select({ id: envExcursions.id, status: envExcursions.status }).from(envExcursions)
        .where(and(eq(envExcursions.envRecordId, id), eq(envExcursions.status, 'Open'))).limit(1);
      let excursionId = excursion[0]?.id ?? null;
      if (status === 'Action' && !excursionId) excursionId = await openExcursion(tx, user.id, updated, limit);
      return { ...updated, excursionId };
    });
    res.json(response);
  });

  router.get('/env-records', requireAuth, async (_req, res) => {
    const records = await db.select().from(envRecords).orderBy(desc(envRecords.date));
    const ids = records.map(r => r.id);
    const excursions = ids.length === 0 ? [] : await db.select().from(envExcursions)
      .where(inArray(envExcursions.envRecordId, ids)).orderBy(desc(envExcursions.openedAt));
    const latest = new Map<string, typeof excursions[number]>();
    for (const e of excursions) if (!latest.has(e.envRecordId)) latest.set(e.envRecordId, e);
    res.json(records.map(r => ({ ...r, excursionId: latest.get(r.id)?.id ?? null, excursionStatus: latest.get(r.id)?.status ?? null })));
  });

  return router;
};
