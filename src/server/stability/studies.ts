/**
 * Stability studies, their timepoints and the pull (roadmap M31).
 *
 *   create   a study of one master batch under an Approved protocol revision. The product, batch text, condition codes and month points
 *            come from the protocol and the batch, never from free text. One timepoint per (condition, month point) is written with its
 *            due date and pull window (./calendar.ts), in the same transaction, each with its audit entry.
 *   close    Completed (every timepoint Complete or Missed) or Aborted, with a reason. A finished study is final (423).
 *   pull     inside the pull window only. One transaction: the sample is registered through insertSamples (the function POST /samples
 *            and registration from a batch use) with the result rows of the protocol's Effective test plan, bound to the specification
 *            in force; the sample_context row names the product and batch; the timepoint becomes Pulled and keeps the sample id.
 *
 * Scheduled, Due and Missed are set by the scheduled sweep (./sweep.ts), never by a person.
 */
import { randomBytes } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { productBatches, products, sampleContext, samples, stabilityStudies } from '../../db/schema';
import { stabilityChambers, stabilityProtocols, stabilityStudyLinks, stabilityTimepoints } from '../../db/schema/stability';
import { writeAudit } from '../../db/utils';
import { STABILITY_FINAL_STATUSES } from '../../lib/validations/stability';
import type { Db } from '../core/context';
import { lockRow, updateVersioned, withTransaction, type Executor } from '../core/tx';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { resolveActiveSpec, todayIso } from '../lib/specs';
import { insertSamples } from '../routes/samples';
import { RecordLockedError } from '../workflow/entityStates';
import { buildTimepoints, scheduledStatus } from './calendar';
import { effectivePlanFor, findProtocol, newId } from './protocols';

type Actor = { id: string };
type TimepointRow = typeof stabilityTimepoints.$inferSelect;
const REGISTRABLE = new Set(['Quarantine', 'Released']);

/** The overdue flag of a timepoint that is Due (or Scheduled with its window open before the sweep ran). */
export const withOverdue = <T extends { status: string; windowStart: string; dueDate: string; windowEnd: string }>(tp: T, today: string) => ({
  ...tp, overdue: (tp.status === 'Due' || tp.status === 'Scheduled') && scheduledStatus(today, tp).overdue,
});

// ---- create and close ----------------------------------------------------------------------------------------------------------

export async function createStudy(db: Db, user: Actor, body: { protocolId: string; batchId: string; startDate: string; chambers?: Record<string, string> }, now = new Date()) {
  const today = todayIso(now);
  return withTransaction(db, async (tx) => {
    const protocol = await findProtocol(tx, body.protocolId);
    if (protocol.status !== 'Approved') {
      throw new AppError(409, 'PROTOCOL_NOT_APPROVED', `Stability protocol ${protocol.code} revision ${protocol.revision} is ${protocol.status}: a study is started only under the Approved revision.`);
    }
    const batch = await lockRow(tx, productBatches, body.batchId);
    if (batch.productId !== protocol.productId) throw new BadRequestError(`Batch ${batch.batchNo} is not a batch of the protocol's product.`);
    if (!REGISTRABLE.has(batch.status)) throw new AppError(409, 'BATCH_NOT_USABLE', `Batch ${batch.batchNo} is ${batch.status}: no stability study can be started on it.`);
    const [product] = await tx.select().from(products).where(eq(products.id, batch.productId)).limit(1);
    if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}.`);

    const chambers = body.chambers ?? {};
    const conditionIds = protocol.conditions.map(c => c.conditionId);
    for (const key of Object.keys(chambers)) {
      if (!conditionIds.includes(key)) throw new BadRequestError(`Condition ${key} is not a condition of protocol ${protocol.code}.`);
    }
    const chamberRows = Object.values(chambers).length
      ? await tx.select().from(stabilityChambers).where(inArray(stabilityChambers.id, Object.values(chambers))) : [];
    for (const [conditionId, chamberId] of Object.entries(chambers)) {
      const ch = chamberRows.find(r => r.id === chamberId);
      if (!ch) throw new BadRequestError(`Chamber ${chamberId} was not found.`);
      if (ch.status !== 'Active') throw new AppError(409, 'CHAMBER_NOT_USABLE', `Chamber ${ch.code} is ${ch.status}.`);
      if (ch.conditionId !== conditionId) throw new BadRequestError(`Chamber ${ch.code} does not hold condition ${protocol.conditions.find(c => c.conditionId === conditionId)!.code}.`);
    }

    const planned = buildTimepoints({ startDate: body.startDate, months: protocol.monthPoints, conditions: protocol.conditions.map(c => ({ id: c.conditionId, code: c.code })), windowDays: protocol.windowDays });
    const closed = planned.filter(p => scheduledStatus(today, p).status === 'Missed');
    if (closed.length) {
      throw new AppError(409, 'START_DATE_TOO_EARLY', `With the start date ${body.startDate}, ${closed.length} pull window(s) have already closed (the first: month ${closed[0].month}, until ${closed[0].windowEnd}). A study is registered before its first pull is due.`);
    }

    const study = {
      id: `STB-${randomBytes(4).toString('hex')}`, product: product.name, batch: batch.batchNo, condition: protocol.conditions.map(c => c.code).join(', '),
      pullPoints: protocol.monthPoints, startDate: body.startDate, status: 'Ongoing', version: 1,
    };
    await tx.insert(stabilityStudies).values(study);
    await writeAudit(tx, user.id, 'Create', 'StabilityStudy', study.id, 'all', '', JSON.stringify(study), `Stability study of batch ${batch.batchNo} started under protocol ${protocol.code} revision ${protocol.revision}`);
    const link = { studyId: study.id, protocolId: protocol.id, productId: product.id, batchId: batch.id, createdBy: user.id };
    await tx.insert(stabilityStudyLinks).values(link);
    await writeAudit(tx, user.id, 'Create', 'StabilityStudyLink', study.id, 'all', '', JSON.stringify(link), 'Study bound to its protocol revision and batch');

    const rows = planned.map(p => ({
      id: newId('STT'), studyId: study.id, conditionId: p.conditionId, conditionCode: p.conditionCode, chamberId: chambers[p.conditionId] ?? null,
      month: p.month, dueDate: p.dueDate, windowStart: p.windowStart, windowEnd: p.windowEnd, status: scheduledStatus(today, p).status, version: 1,
    }));
    await tx.insert(stabilityTimepoints).values(rows);
    for (const r of rows) {
      await writeAudit(tx, user.id, 'Create', 'StabilityTimepoint', r.id, 'all', '', JSON.stringify(r), `Pull ${r.conditionCode} month ${r.month} scheduled for ${r.dueDate}`);
    }
    return { ...study, protocolId: protocol.id, batchId: batch.id, timepoints: rows };
  });
}

export async function closeStudy(db: Db, user: Actor, id: string, body: { status: 'Completed' | 'Aborted'; reason: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const existing = await lockRow(tx, stabilityStudies, id);
    if (existing.version !== body.expectedVersion) throw new ConflictError();
    if (STABILITY_FINAL_STATUSES.includes(existing.status)) {
      throw new RecordLockedError(`The stability study is ${existing.status} and final: it can no longer be changed.`);
    }
    if (body.status === 'Completed') {
      const open = await tx.select({ id: stabilityTimepoints.id, status: stabilityTimepoints.status, month: stabilityTimepoints.month, conditionCode: stabilityTimepoints.conditionCode })
        .from(stabilityTimepoints).where(and(eq(stabilityTimepoints.studyId, id), inArray(stabilityTimepoints.status, ['Scheduled', 'Due', 'Pulled', 'InTesting'])));
      if (open.length) {
        throw new AppError(409, 'TIMEPOINTS_OPEN', `${open.length} timepoint(s) are not finished (for example ${open[0].conditionCode} month ${open[0].month}: ${open[0].status}). Complete them, or abort the study with a reason.`);
      }
    }
    const updated = await updateVersioned(tx, stabilityStudies, id, body.expectedVersion, { status: body.status });
    await writeAudit(tx, user.id, 'StatusChange', 'StabilityStudy', id, 'status', existing.status, body.status, body.reason);
    return updated;
  });
}

// ---- reading -------------------------------------------------------------------------------------------------------------------

/** Every study, newest start first, with its protocol revision (none for a legacy study) and its timepoint counts. */
export async function listStudies(db: Db, now = new Date()) {
  const today = todayIso(now);
  const rows = await db.select({ study: stabilityStudies, link: stabilityStudyLinks, protocolCode: stabilityProtocols.code, protocolRevision: stabilityProtocols.revision })
    .from(stabilityStudies).leftJoin(stabilityStudyLinks, eq(stabilityStudyLinks.studyId, stabilityStudies.id))
    .leftJoin(stabilityProtocols, eq(stabilityProtocols.id, stabilityStudyLinks.protocolId))
    .orderBy(asc(stabilityStudies.startDate), asc(stabilityStudies.id));
  const tps = await db.select().from(stabilityTimepoints);
  return rows.reverse().map(r => {
    const mine = tps.filter(t => t.studyId === r.study.id).map(t => withOverdue(t, today));
    const next = mine.filter(t => t.status === 'Scheduled' || t.status === 'Due').sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return {
      ...r.study, legacy: !r.link, protocolId: r.link?.protocolId ?? null, protocolCode: r.protocolCode, protocolRevision: r.protocolRevision, batchId: r.link?.batchId ?? null,
      counts: {
        total: mine.length, due: mine.filter(t => t.status === 'Due').length, overdue: mine.filter(t => t.overdue).length,
        missed: mine.filter(t => t.status === 'Missed').length, complete: mine.filter(t => t.status === 'Complete').length,
      },
      nextDue: next ? { month: next.month, conditionCode: next.conditionCode, dueDate: next.dueDate } : null,
    };
  });
}

const timepointView = async (ex: Executor, where: ReturnType<typeof eq> | undefined, today: string) => {
  const q = ex.select({ tp: stabilityTimepoints, chamberCode: stabilityChambers.code, sampleState: samples.state, studyStatus: stabilityStudies.status, product: stabilityStudies.product, batch: stabilityStudies.batch })
    .from(stabilityTimepoints).innerJoin(stabilityStudies, eq(stabilityStudies.id, stabilityTimepoints.studyId))
    .leftJoin(stabilityChambers, eq(stabilityChambers.id, stabilityTimepoints.chamberId)).leftJoin(samples, eq(samples.id, stabilityTimepoints.sampleId));
  const rows = await (where ? q.where(where) : q).orderBy(asc(stabilityTimepoints.dueDate), asc(stabilityTimepoints.conditionCode));
  return rows.map(r => ({ ...withOverdue(r.tp, today), chamberCode: r.chamberCode, sampleState: r.sampleState, studyStatus: r.studyStatus, product: r.product, batch: r.batch }));
};

export async function studyDetail(db: Db, id: string, now = new Date()) {
  const [study] = await db.select().from(stabilityStudies).where(eq(stabilityStudies.id, id)).limit(1);
  if (!study) throw new NotFoundError(`Stability study ${id} was not found.`);
  const [link] = await db.select().from(stabilityStudyLinks).where(eq(stabilityStudyLinks.studyId, id)).limit(1);
  const protocol = link ? await findProtocol(db, link.protocolId) : null;
  return { study: { ...study, legacy: !link }, link: link ?? null, protocol, timepoints: await timepointView(db, eq(stabilityTimepoints.studyId, id), todayIso(now)) };
}

/** The pull calendar: the timepoints of Ongoing studies, by due date; ?status narrows it (Due, Missed, ...; 'overdue' for Due past the due day). */
export async function pullCalendar(db: Db, status: string | undefined, now = new Date()) {
  const all = (await timepointView(db, eq(stabilityStudies.status, 'Ongoing'), todayIso(now)));
  if (!status) return all;
  return status === 'overdue' ? all.filter(t => t.overdue) : all.filter(t => t.status === status);
}

// ---- pull ----------------------------------------------------------------------------------------------------------------------

export async function pullTimepoint(db: Db, user: Actor, id: string, expectedVersion: number, now = new Date()) {
  const today = todayIso(now);
  return withTransaction(db, async (tx) => {
    const tp = await lockRow(tx, stabilityTimepoints, id);
    const study = await lockRow(tx, stabilityStudies, tp.studyId);
    if (STABILITY_FINAL_STATUSES.includes(study.status)) throw new RecordLockedError(`The stability study ${study.id} is ${study.status}: nothing more is pulled.`);
    if (tp.version !== expectedVersion) throw new ConflictError();
    if (tp.status !== 'Scheduled' && tp.status !== 'Due') {
      throw new AppError(409, tp.status === 'Missed' ? 'PULL_MISSED' : 'ALREADY_PULLED', tp.status === 'Missed'
        ? `The pull of ${tp.conditionCode} month ${tp.month} was missed (window ${tp.windowStart} to ${tp.windowEnd}); it is handled by its deviation${tp.deviationId ? ` ${tp.deviationId}` : ''}.`
        : `The timepoint ${tp.conditionCode} month ${tp.month} is already ${tp.status} (sample ${tp.sampleId}).`);
    }
    const cal = scheduledStatus(today, tp);
    if (cal.status === 'Scheduled') throw new AppError(409, 'PULL_NOT_DUE', `The pull window of ${tp.conditionCode} month ${tp.month} opens on ${tp.windowStart} (due ${tp.dueDate}).`);
    if (cal.status === 'Missed') throw new AppError(409, 'PULL_WINDOW_CLOSED', `The pull window of ${tp.conditionCode} month ${tp.month} closed on ${tp.windowEnd}: the pull is missed and is recorded as a deviation by the scheduler.`);

    const [link] = await tx.select().from(stabilityStudyLinks).where(eq(stabilityStudyLinks.studyId, study.id)).limit(1);
    if (!link) throw new AppError(409, 'LEGACY_STUDY', `Study ${study.id} has no protocol: it has no pulls.`);
    const protocol = await findProtocol(tx, link.protocolId);
    const batch = await lockRow(tx, productBatches, link.batchId);
    if (!REGISTRABLE.has(batch.status)) throw new AppError(409, 'BATCH_NOT_USABLE', `Batch ${batch.batchNo} is ${batch.status}: no sample can be registered against it.`);
    const [product] = await tx.select().from(products).where(eq(products.id, link.productId)).limit(1);
    if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}: no sample can be registered for it.`);

    const spec = await resolveActiveSpec(tx, product.name, now);
    if (!spec) throw new BadRequestError(`Cannot register the pull sample: no Active specification is in force for '${product.name}'.`);
    const plan = await effectivePlanFor(tx, protocol.testPlanCode, product.name);
    const missing = plan.parameters.filter(name => !spec.parameters.some(p => p.name === name));
    if (missing.length) throw new BadRequestError(`The test plan ${plan.code} revision ${plan.revision} names ${missing.join(', ')}, which the specification ${spec.id} (revision ${spec.revision}) in force does not have.`);
    const planned = { ...spec, parameters: spec.parameters.filter(p => plan.parameters.includes(p.name)) };

    const [sample] = await insertSamples(tx, user, [{ material: product.name, batch: batch.batchNo, spec: planned }],
      `Stability pull: study ${study.id}, ${tp.conditionCode}, month ${tp.month} (timepoint ${tp.id}; test plan ${plan.code} revision ${plan.revision})`, now);
    const context = { sampleId: sample.id, productId: product.id, batchId: batch.id, customerId: null, origin: 'stability', createdBy: user.id };
    await tx.insert(sampleContext).values(context);
    await writeAudit(tx, user.id, 'Create', 'SampleContext', sample.id, 'all', '', JSON.stringify({ productId: product.id, batchId: batch.id, customerId: null, stabilityTimepointId: tp.id }), 'Stability pull sample registered against master data');

    const updated = await updateVersioned(tx, stabilityTimepoints, id, expectedVersion, { status: 'Pulled', sampleId: sample.id, pulledBy: user.id, pulledAt: now });
    await writeAudit(tx, user.id, 'Pull', 'StabilityTimepoint', id, 'status', tp.status, 'Pulled', `Pulled on ${today} as sample ${sample.id} (window ${tp.windowStart} to ${tp.windowEnd}, due ${tp.dueDate})`);
    return { timepoint: withOverdue(updated as TimepointRow, today), sample: { ...sample, version: 1 }, testPlan: { code: plan.code, revision: plan.revision, parameters: plan.parameters } };
  });
}
