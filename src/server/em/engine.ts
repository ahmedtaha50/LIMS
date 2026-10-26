/**
 * The environmental monitoring engine (roadmap M32, r2-em): how a reading is judged, how an excursion is opened, and which batches a
 * reading concerns.
 *
 *   judge           a count above the action limit is Action; above the alert limit (where the profile sets one) is Alert; at a limit
 *                   is not above it. Only an Approved limit profile for the point's grade, the method and the occupancy state judges.
 *   openExcursion   inside the result's transaction: the deviation (M27 autoOpenQmsRecord, source em-excursion), the excursion row and
 *                   an `affects` link from the deviation to every batch exposed in the room on the sampling day, so the QMS release
 *                   blocker holds that batch while the deviation is open and not classified Minor.
 *   batch impact    a batch is exposed in a room over a window of days (em_batch_rooms). The EM results of a batch are those of
 *                   sampling points in its rooms with a sampling day inside a window; nothing else.
 */
import { randomBytes } from 'crypto';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { productBatches, products } from '../../db/schema/master';
import { qmsLinks, qmsRecords } from '../../db/schema/qms';
import { emBatchRooms, emExcursions, emLimitProfiles, emResults, emSamplingPoints } from '../../db/schema/em';
import { writeAudit } from '../../db/utils';
import type { Executor, Tx } from '../core/tx';
import { AppError } from '../http/errors';
import { autoOpenQmsRecord } from '../qms';
import { LIFECYCLES } from '../qms/states';
import type { EmStatus } from './constants';

export type Profile = typeof emLimitProfiles.$inferSelect;
export type EmResult = typeof emResults.$inferSelect;
export type Point = typeof emSamplingPoints.$inferSelect;

export function judge(count: number, limit: { alertLimit: number | null; actionLimit: number }): EmStatus {
  if (count > limit.actionLimit) return 'Action';
  if (limit.alertLimit !== null && count > limit.alertLimit) return 'Alert';
  return 'Pass';
}

/** The Approved profile for the key, or 400 NO_APPROVED_LIMIT: a result nobody can judge is not recorded. */
export async function approvedProfile(ex: Executor, grade: string, method: string, occupancy: string): Promise<Profile> {
  const [p] = await ex.select().from(emLimitProfiles)
    .where(and(eq(emLimitProfiles.grade, grade), eq(emLimitProfiles.method, method), eq(emLimitProfiles.occupancy, occupancy), eq(emLimitProfiles.status, 'Approved')))
    .limit(1);
  if (!p) {
    throw new AppError(400, 'NO_APPROVED_LIMIT',
      `There is no approved limit for ${grade}, ${method}, ${occupancy}: the result cannot be judged. QA must approve a limit profile for this combination first.`,
      [{ path: 'method', message: 'No approved limit for this grade, method and occupancy.' }]);
  }
  return p;
}

/** The batches exposed in `room` on `day` (YYYY-MM-DD), by batch number. */
export async function impactedBatches(ex: Executor, room: string, day: string): Promise<Array<{ productBatchId: string; batchNo: string; productName: string }>> {
  return ex.selectDistinct({ productBatchId: productBatches.id, batchNo: productBatches.batchNo, productName: products.name })
    .from(emBatchRooms)
    .innerJoin(productBatches, eq(productBatches.id, emBatchRooms.productBatchId))
    .innerJoin(products, eq(products.id, productBatches.productId))
    .where(and(eq(emBatchRooms.room, room), lte(emBatchRooms.fromDate, day), gte(emBatchRooms.toDate, day)))
    .orderBy(productBatches.batchNo);
}

/**
 * Adds an `affects` link from the deviation to the batch (once). A final deviation is not changed: its impact assessment is closed.
 * Returns true when a link was written.
 */
export async function linkDeviationToBatch(tx: Tx, actorId: string, qmsRecordId: string, batchNo: string, why: string): Promise<boolean> {
  const [rec] = await tx.select({ state: qmsRecords.state }).from(qmsRecords).where(eq(qmsRecords.id, qmsRecordId)).limit(1);
  if (!rec || LIFECYCLES.Deviation.terminal.includes(rec.state)) return false;
  const inserted = await tx.insert(qmsLinks)
    .values({ id: `QL-${randomBytes(6).toString('hex')}`, recordId: qmsRecordId, relation: 'affects', targetType: 'Batch', targetId: batchNo, createdBy: actorId })
    .onConflictDoNothing().returning({ id: qmsLinks.id });
  if (inserted.length === 0) return false;
  await writeAudit(tx, actorId, 'Link', 'QmsRecord', qmsRecordId, 'link', '', `affects Batch ${batchNo}`, why);
  return true;
}

/**
 * Opens the excursion of an action-level result, with its deviation, in the caller's transaction. One per result: a second call
 * returns the one that exists. A correction never closes one (the deviation's lifecycle does).
 */
export async function openExcursion(tx: Tx, actorId: string, result: EmResult, point: Point): Promise<{ excursionId: string; deviationId: string; batches: string[] }> {
  const [existing] = await tx.select().from(emExcursions).where(eq(emExcursions.resultId, result.id)).limit(1);
  if (existing) return { excursionId: existing.id, deviationId: existing.qmsRecordId, batches: [] };

  const what = `${result.count} ${result.unit} against an action limit of ${result.limitAction} (${result.grade}, ${result.method}, ${result.occupancy})`;
  const deviation = await autoOpenQmsRecord(tx, {
    source: 'em-excursion', sourceId: result.id, actorId,
    title: `EM action-level excursion at ${point.code} (${result.room}) on ${result.sampledOn}`,
    description: `Environmental monitoring result ${result.id} at sampling point ${point.code}, ${point.description}: ${what}.`,
  });
  const excursion = {
    id: `EMX-${randomBytes(5).toString('hex')}`, resultId: result.id, pointId: point.id, room: result.room, level: 'Action',
    count: result.count, limitValue: result.limitAction, qmsRecordId: deviation.id, openedBy: actorId,
  };
  await tx.insert(emExcursions).values(excursion);
  await writeAudit(tx, actorId, 'Create', 'EmExcursion', excursion.id, 'all', '', JSON.stringify(excursion), `Action level exceeded: ${what}`);

  const batches = await impactedBatches(tx, result.room, result.sampledOn);
  for (const b of batches) {
    await linkDeviationToBatch(tx, actorId, deviation.id, b.batchNo, `Batch ${b.batchNo} was in room ${result.room} on ${result.sampledOn} (excursion ${excursion.id})`);
  }
  return { excursionId: excursion.id, deviationId: deviation.id, batches: batches.map(b => b.batchNo) };
}

/** When a batch room window is recorded or moved: the open excursions it now covers affect the batch. */
export async function linkWindowToExcursions(tx: Tx, actorId: string, window: { productBatchId: string; room: string; fromDate: string; toDate: string }): Promise<string[]> {
  const [batch] = await tx.select({ batchNo: productBatches.batchNo }).from(productBatches).where(eq(productBatches.id, window.productBatchId)).limit(1);
  if (!batch) return [];
  const covered = await tx.select({ excursionId: emExcursions.id, qmsRecordId: emExcursions.qmsRecordId, sampledOn: emResults.sampledOn })
    .from(emExcursions).innerJoin(emResults, eq(emResults.id, emExcursions.resultId))
    .where(and(eq(emExcursions.room, window.room), gte(emResults.sampledOn, window.fromDate), lte(emResults.sampledOn, window.toDate)))
    .orderBy(asc(emExcursions.openedAt));
  const linked: string[] = [];
  for (const c of covered) {
    if (await linkDeviationToBatch(tx, actorId, c.qmsRecordId, batch.batchNo, `Batch ${batch.batchNo} was in room ${window.room} on ${c.sampledOn} (excursion ${c.excursionId})`)) linked.push(c.qmsRecordId);
  }
  return linked;
}

export interface BatchEmView {
  windows: Array<{ id: string; productBatchId: string; productName: string; room: string; fromDate: string; toDate: string }>;
  results: Array<Record<string, unknown>>;
}

/**
 * The EM section of the batch dossier: the batch's room windows and the results of points in those rooms sampled inside a window.
 * A batch with no window recorded has no EM results (nothing is attached to every batch).
 */
export async function findBatchEmResults(ex: Executor, batchNo: string): Promise<BatchEmView> {
  const windows = await ex.select({
    id: emBatchRooms.id, productBatchId: emBatchRooms.productBatchId, productName: products.name, room: emBatchRooms.room,
    fromDate: emBatchRooms.fromDate, toDate: emBatchRooms.toDate,
  }).from(emBatchRooms)
    .innerJoin(productBatches, eq(productBatches.id, emBatchRooms.productBatchId))
    .innerJoin(products, eq(products.id, productBatches.productId))
    .where(eq(productBatches.batchNo, batchNo))
    .orderBy(asc(emBatchRooms.fromDate), asc(emBatchRooms.room));
  if (windows.length === 0) return { windows, results: [] };

  const inWindow = sql.join(windows.map(w => sql`(${emResults.room} = ${w.room} AND ${emResults.sampledOn} BETWEEN ${w.fromDate} AND ${w.toDate})`), sql` OR `);
  const rows = await ex.select({ r: emResults, pointCode: emSamplingPoints.code, pointDescription: emSamplingPoints.description })
    .from(emResults).innerJoin(emSamplingPoints, eq(emSamplingPoints.id, emResults.pointId))
    .where(sql`(${inWindow})`)
    .orderBy(asc(emResults.sampledOn), asc(emResults.id));
  const ids = rows.map(x => x.r.id);
  const excursions = ids.length === 0 ? [] : await ex.select({ resultId: emExcursions.resultId, id: emExcursions.id, deviationId: emExcursions.qmsRecordId })
    .from(emExcursions).where(inArray(emExcursions.resultId, ids));
  const byResult = new Map(excursions.map(e => [e.resultId, e]));
  return {
    windows,
    results: rows.map(({ r, pointCode, pointDescription }) => ({
      id: r.id, pointId: r.pointId, pointCode, location: pointDescription, room: r.room, grade: r.grade, method: r.method, occupancy: r.occupancy,
      sampledOn: r.sampledOn, date: r.sampledOn, count: r.count, unit: r.unit, status: r.status, limitAlert: r.limitAlert, limitAction: r.limitAction,
      organism: r.organism, excursionId: byResult.get(r.id)?.id ?? null, deviationId: byResult.get(r.id)?.deviationId ?? null,
    })),
  };
}
