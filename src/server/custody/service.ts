/**
 * Sample receipt, containers and aliquots, transfers, retains, storage locations and labels (roadmap M29). Owned by
 * r2-custody-labels; the routes are src/server/routes/custody.ts.
 *
 * Every write is one transaction: the change, its ledger row(s) and its audit entry (AGENTS.md s.2). Every update of a versioned row
 * carries the version predicate; the container is locked first (SELECT ... FOR UPDATE), then the counters, then the audit chain, in
 * that order everywhere, so concurrent writers queue and cannot deadlock. The actor is always req.user.
 *
 *   receipt        once per sample: condition, seal, temperature against the required storage, dates, the first quantity. It makes
 *                  the primary container (held by the receiver) and the first ledger row. A deviation (./status.ts) blocks
 *                  Logged -> Testing until QA acknowledges it with a signature (CUSTODY_DEVIATION_ACK); never the receiver.
 *   aliquot        takes a quantity out of a container into a new child container: two ledger rows, out and in.
 *   consume        takes a quantity out for testing. The balance never goes below zero (409, and the database refuses it).
 *   transfer       a new place and/or a new holder; the place must keep the sample's required temperature.
 *   retain         the container is kept until a date (retain register); a retained container is not used up or aliquoted.
 *   dispose        a retain past its date is disposed of with a signature (RETAIN_DISPOSAL), never by whoever registered it.
 *   labels         every print is logged in the label log; a reprint needs a reason.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { samples, users } from '../../db/schema';
import { labelPrints, sampleContainers, sampleCustody, sampleRetains, storageLocations } from '../../db/schema/custody';
import { writeAudit } from '../../db/utils';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import type { Db } from '../core/context';
import { lockRow, nextSequence, updateVersioned, withTransaction, type Executor } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import './entities';
import { appendEvent, appendPrint, eventsOfSample, quantityNumber, toUnits, unitsText, verifyChains, type CustodyEventRow } from './ledger';
import { activeRetainOf, custodyStatus, readReceipt, receiptDeviations, todayIso, type Receipt } from './status';

export interface Actor { id: string; role: string }

type Container = typeof sampleContainers.$inferSelect;
type Location = typeof storageLocations.$inferSelect;
type Retain = typeof sampleRetains.$inferSelect;

const pad = (n: number, width: number) => String(n).padStart(width, '0');

// ---- views (quantities as numbers for the client; the database keeps exact numeric text) -------------------------------------------

export const containerView = (c: Container) => ({ ...c, quantity: quantityNumber(c.quantity) });
export const eventView = (e: CustodyEventRow) => ({ ...e, qtyDelta: quantityNumber(e.qtyDelta), balanceAfter: quantityNumber(e.balanceAfter) });
const isDue = (r: Retain, today = todayIso()) => r.status === 'Retained' && r.retainUntil <= today;
export const retainView = (r: Retain) => ({ ...r, due: isDue(r) });

// ---- checks shared by the writes ------------------------------------------------------------------------------------------------

async function assertActiveUser(ex: Executor, userId: string, field: string) {
  const [u] = await ex.select({ active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.active) throw new BadRequestError(`${field}: ${userId} is not an active user.`);
}

async function activeLocation(ex: Executor, id: string): Promise<Location> {
  const [loc] = await ex.select().from(storageLocations).where(eq(storageLocations.id, id)).limit(1);
  if (!loc) throw new NotFoundError(`Storage location ${id} was not found.`);
  if (loc.status !== 'Active') throw new AppError(409, 'LOCATION_INACTIVE', `Storage location ${loc.code} is inactive.`);
  return loc;
}

/** The temperature range a location keeps: its own, or the nearest enclosing location's (a box in a fridge keeps the fridge's). */
async function effectiveRange(ex: Executor, loc: Location): Promise<{ min: number | null; max: number | null; from: Location | null }> {
  let cur: Location | undefined = loc;
  for (let depth = 0; cur && depth < 20; depth++) {
    if (cur.tempMin != null || cur.tempMax != null) return { min: cur.tempMin, max: cur.tempMax, from: cur };
    if (!cur.parentId) break;
    [cur] = await ex.select().from(storageLocations).where(eq(storageLocations.id, cur.parentId)).limit(1);
  }
  return { min: null, max: null, from: null };
}

/** 409 STORAGE_CONDITION_MISMATCH when the location cannot be shown to keep the sample's required temperature range. */
async function assertStorageFits(ex: Executor, loc: Location, receipt: Pick<Receipt, 'requiredTempMin' | 'requiredTempMax' | 'requiredStorage'> | null) {
  if (!receipt || (receipt.requiredTempMin == null && receipt.requiredTempMax == null)) return;
  const range = await effectiveRange(ex, loc);
  const fits = (receipt.requiredTempMin == null || (range.min != null && range.min >= receipt.requiredTempMin))
    && (receipt.requiredTempMax == null || (range.max != null && range.max <= receipt.requiredTempMax));
  if (fits) return;
  const kept = range.from ? `${range.min ?? '-∞'} to ${range.max ?? '+∞'} °C` : 'no controlled temperature';
  throw new AppError(409, 'STORAGE_CONDITION_MISMATCH',
    `Storage location ${loc.code} keeps ${kept}; the sample must be stored at ${receipt.requiredStorage} (${receipt.requiredTempMin ?? '-∞'} to ${receipt.requiredTempMax ?? '+∞'} °C).`);
}

/** Locks the container and checks the version the client saw. */
async function lockContainer(tx: Executor, id: string, expectedVersion: number): Promise<Container> {
  const c = await lockRow(tx, sampleContainers, id);
  if (c.version !== expectedVersion) throw new ConflictError();
  if (c.status === 'Disposed') throw new AppError(409, 'CONTAINER_DISPOSED', `Container ${id} has been disposed of.`);
  return c;
}

async function newContainerId(tx: Executor) {
  return `CTN-${pad(await nextSequence(tx, 'custody_container'), 6)}`;
}

const ledgerRef = (e: CustodyEventRow) => ({ ledgerId: e.id, ledgerHash: e.hash });

// ---- receipt ------------------------------------------------------------------------------------------------------------------

export interface ReceiptInput {
  receivedAt?: string; condition: string; sealIntact: boolean; temperatureC?: number | null; requiredStorage: string;
  requiredTempMin?: number | null; requiredTempMax?: number | null; mfgDate?: string | null; expDate?: string | null;
  quantity: number; unit: string; locationId?: string | null; notes?: string | null;
}

export async function recordReceipt(db: Db, actor: Actor, sampleId: string, body: ReceiptInput) {
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
  if (receivedAt.getTime() > Date.now() + 60_000) throw new BadRequestError('receivedAt: a receipt cannot be in the future.');
  if (body.mfgDate && body.expDate && body.mfgDate > body.expDate) throw new BadRequestError('mfgDate must not be after expDate.');
  return withTransaction(db, async (tx) => {
    const sample = await lockRow(tx, samples, sampleId);
    if (await readReceipt(tx, sampleId)) throw new AppError(409, 'ALREADY_RECEIVED', `Sample ${sampleId} has already been received; a receipt is recorded once.`);
    const required = { requiredTempMin: body.requiredTempMin ?? null, requiredTempMax: body.requiredTempMax ?? null, requiredStorage: body.requiredStorage };
    const location = body.locationId ? await activeLocation(tx, body.locationId) : null;
    if (location) await assertStorageFits(tx, location, required);

    const deviations = receiptDeviations({ ...body, temperatureC: body.temperatureC ?? null, receivedAt });
    const [receipt] = await tx.insert(sampleCustody).values({
      sampleId, receivedAt, receivedBy: actor.id, condition: body.condition, sealIntact: body.sealIntact, temperatureC: body.temperatureC ?? null,
      ...required, mfgDate: body.mfgDate ?? null, expDate: body.expDate ?? null, notes: body.notes ?? null,
      deviation: deviations.length > 0, deviationReasons: deviations.length ? deviations.join('; ') : null, version: 1,
    }).returning();

    const q = toUnits(body.quantity);
    const [container] = await tx.insert(sampleContainers).values({
      id: await newContainerId(tx), sampleId, parentId: null, kind: 'Primary', quantity: unitsText(q), unit: body.unit,
      locationId: location?.id ?? null, holderId: actor.id, status: 'Active', createdBy: actor.id, version: 1,
    }).returning();
    const event = await appendEvent(tx, {
      containerId: container.id, sampleId, eventType: 'Receipt', delta: q, balanceBefore: 0n, unit: body.unit,
      toLocationId: location?.id ?? null, toHolderId: actor.id, reason: `Received (sample state ${sample.state})`, actorId: actor.id,
    });

    await writeAudit(tx, actor.id, 'Receive', 'SampleReceipt', sampleId, 'receipt', '', JSON.stringify({
      receivedAt: receivedAt.toISOString(), condition: body.condition, sealIntact: body.sealIntact, temperatureC: body.temperatureC ?? null,
      ...required, mfgDate: body.mfgDate ?? null, expDate: body.expDate ?? null, deviation: receipt.deviation, deviationReasons: receipt.deviationReasons,
    }), deviations.length ? `Received with a deviation: ${deviations.join('; ')}` : 'Sample received in the required condition');
    await writeAudit(tx, actor.id, 'Create', 'SampleContainer', container.id, 'quantity', '',
      JSON.stringify({ sampleId, kind: 'Primary', quantity: quantityNumber(container.quantity), unit: body.unit, locationId: container.locationId, ...ledgerRef(event) }),
      `Primary container made at the receipt of ${sampleId}`);
    return { receipt, container: containerView(container), event: eventView(event), status: custodyStatus(receipt) };
  });
}

/** QA's signed acknowledgement of a receipt deviation (CUSTODY_DEVIATION_ACK). The receiver may not acknowledge their own receipt. */
export async function acknowledgeDeviation(db: Db, req: Request, actor: Actor, sampleId: string,
  body: { password: string; totpCode?: string; reason: string; expectedVersion: number }) {
  const receipt = await readReceipt(db, sampleId);
  if (!receipt) throw new NotFoundError(`Sample ${sampleId} has not been received.`);
  if (!receipt.deviation) throw new AppError(409, 'NO_DEVIATION', `The receipt of ${sampleId} has no deviation to acknowledge.`);
  if (receipt.deviationAckAt) throw new AppError(409, 'ALREADY_ACKNOWLEDGED', `The receipt deviation of ${sampleId} has already been acknowledged.`);
  if (receipt.receivedBy === actor.id) {
    await recordDenied(db, req, actor, { rule: 'custody.receipt-ack', entity: 'SampleReceipt', entityId: sampleId });
    throw new AppError(403, 'SOD_VIOLATION', `You received ${sampleId}: another member of the quality unit must acknowledge its receipt deviation.`);
  }
  if (receipt.version !== body.expectedVersion) throw new ConflictError();
  return signRecord({
    db, user: actor, meaningCode: 'CUSTODY_DEVIATION_ACK', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'SampleReceipt', entityId: sampleId, sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const [row] = await tx.update(sampleCustody)
        .set({ deviationAckBy: actor.id, deviationAckAt: new Date(), version: sql`${sampleCustody.version} + 1` })
        .where(and(eq(sampleCustody.sampleId, sampleId), eq(sampleCustody.version, body.expectedVersion), isNull(sampleCustody.deviationAckAt)))
        .returning();
      if (!row) throw new ConflictError();
      return {
        recordVersion: row.version, result: row,
        audit: { action: 'AcknowledgeDeviation', field: 'deviation', oldValue: 'Awaiting QA', newValue: 'Acknowledged', reason: body.reason },
      };
    },
  });
}

// ---- containers ---------------------------------------------------------------------------------------------------------------

function insufficient(c: Container, wanted: bigint): AppError {
  return new AppError(409, 'INSUFFICIENT_QUANTITY',
    `Only ${quantityNumber(c.quantity)} ${c.unit} are left in ${c.id}; ${quantityNumber(unitsText(wanted))} ${c.unit} cannot be taken. The balance never goes below zero.`);
}

async function assertNotRetained(ex: Executor, c: Container, what: string) {
  const r = await activeRetainOf(ex, c.id);
  if (r) throw new AppError(409, 'RETAINED', `Container ${c.id} is a retained sample (${r.id}, until ${r.retainUntil}): it may not be ${what}.`);
}

export async function makeAliquot(db: Db, actor: Actor, containerId: string, body: { quantity: number; reason: string; expectedVersion: number; locationId?: string | null }) {
  return withTransaction(db, async (tx) => {
    const c = await lockContainer(tx, containerId, body.expectedVersion);
    await assertNotRetained(tx, c, 'aliquoted');
    const q = toUnits(body.quantity);
    const balance = toUnits(c.quantity);
    if (q > balance) throw insufficient(c, q);
    let locationId = c.locationId;
    if (body.locationId !== undefined && body.locationId !== c.locationId) {
      locationId = body.locationId;
      if (locationId) await assertStorageFits(tx, await activeLocation(tx, locationId), await readReceipt(tx, c.sampleId));
    }
    const [child] = await tx.insert(sampleContainers).values({
      id: await newContainerId(tx), sampleId: c.sampleId, parentId: c.id, kind: 'Aliquot', quantity: unitsText(q), unit: c.unit,
      locationId, holderId: actor.id, status: 'Active', createdBy: actor.id, version: 1,
    }).returning();
    const left = balance - q;
    const parent = await updateVersioned(tx, sampleContainers, c.id, c.version, { quantity: unitsText(left), status: left === 0n ? 'Empty' : c.status });
    const out = await appendEvent(tx, {
      containerId: c.id, sampleId: c.sampleId, eventType: 'Aliquot out', delta: -q, balanceBefore: balance, unit: c.unit,
      fromLocationId: c.locationId, toLocationId: locationId, fromHolderId: c.holderId, toHolderId: actor.id, relatedContainerId: child.id, reason: body.reason, actorId: actor.id,
    });
    const into = await appendEvent(tx, {
      containerId: child.id, sampleId: c.sampleId, eventType: 'Aliquot in', delta: q, balanceBefore: 0n, unit: c.unit,
      fromLocationId: c.locationId, toLocationId: locationId, fromHolderId: c.holderId, toHolderId: actor.id, relatedContainerId: c.id, reason: body.reason, actorId: actor.id,
    });
    await writeAudit(tx, actor.id, 'Aliquot', 'SampleContainer', c.id, 'quantity', unitsText(balance), unitsText(left),
      `${body.reason} (aliquot ${child.id}, ${out.id} ${out.hash})`);
    await writeAudit(tx, actor.id, 'Create', 'SampleContainer', child.id, 'quantity', '',
      JSON.stringify({ sampleId: c.sampleId, kind: 'Aliquot', parentId: c.id, quantity: quantityNumber(child.quantity), unit: c.unit, locationId, ...ledgerRef(into) }),
      body.reason);
    return { parent: containerView(parent), child: containerView(child), events: [eventView(out), eventView(into)] };
  });
}

export async function consume(db: Db, actor: Actor, containerId: string, body: { quantity: number; reason: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const c = await lockContainer(tx, containerId, body.expectedVersion);
    await assertNotRetained(tx, c, 'used up');
    const q = toUnits(body.quantity);
    const balance = toUnits(c.quantity);
    if (q > balance) throw insufficient(c, q);
    const left = balance - q;
    const container = await updateVersioned(tx, sampleContainers, c.id, c.version, { quantity: unitsText(left), status: left === 0n ? 'Empty' : c.status });
    const event = await appendEvent(tx, {
      containerId: c.id, sampleId: c.sampleId, eventType: 'Consume', delta: -q, balanceBefore: balance, unit: c.unit,
      fromHolderId: c.holderId, reason: body.reason, actorId: actor.id,
    });
    await writeAudit(tx, actor.id, 'Consume', 'SampleContainer', c.id, 'quantity', unitsText(balance), unitsText(left), `${body.reason} (${event.id} ${event.hash})`);
    return { container: containerView(container), event: eventView(event) };
  });
}

export async function transfer(db: Db, actor: Actor, containerId: string, body: { toLocationId?: string | null; toHolderId?: string; reason: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const c = await lockContainer(tx, containerId, body.expectedVersion);
    const toLocationId = body.toLocationId === undefined ? c.locationId : body.toLocationId;
    const toHolderId = body.toHolderId ?? c.holderId;
    if (toLocationId === c.locationId && toHolderId === c.holderId) throw new BadRequestError(`Container ${c.id} is already there and with that holder: nothing to transfer.`);
    if (toLocationId && toLocationId !== c.locationId) await assertStorageFits(tx, await activeLocation(tx, toLocationId), await readReceipt(tx, c.sampleId));
    if (toHolderId && toHolderId !== c.holderId) await assertActiveUser(tx, toHolderId, 'toHolderId');
    const container = await updateVersioned(tx, sampleContainers, c.id, c.version, { locationId: toLocationId, holderId: toHolderId });
    const balance = toUnits(c.quantity);
    const event = await appendEvent(tx, {
      containerId: c.id, sampleId: c.sampleId, eventType: 'Transfer', delta: 0n, balanceBefore: balance, unit: c.unit,
      fromLocationId: c.locationId, toLocationId, fromHolderId: c.holderId, toHolderId, reason: body.reason, actorId: actor.id,
    });
    await writeAudit(tx, actor.id, 'Transfer', 'SampleContainer', c.id, 'custody',
      JSON.stringify({ locationId: c.locationId, holderId: c.holderId }), JSON.stringify({ locationId: toLocationId, holderId: toHolderId }),
      `${body.reason} (${event.id} ${event.hash})`);
    return { container: containerView(container), event: eventView(event) };
  });
}

// ---- retain register ----------------------------------------------------------------------------------------------------------

export async function registerRetain(db: Db, actor: Actor, containerId: string, body: { retainUntil: string; reason: string; expectedVersion: number }) {
  if (body.retainUntil < todayIso()) throw new BadRequestError('retainUntil: the retention period cannot end in the past.');
  return withTransaction(db, async (tx) => {
    const c = await lockContainer(tx, containerId, body.expectedVersion);
    const [existing] = await tx.select().from(sampleRetains).where(eq(sampleRetains.containerId, c.id)).limit(1);
    if (existing) throw new AppError(409, 'ALREADY_RETAINED', `Container ${c.id} is already in the retain register (${existing.id}).`);
    if (toUnits(c.quantity) === 0n) throw new AppError(409, 'CONTAINER_EMPTY', `Container ${c.id} is empty: there is nothing to retain.`);
    const [retain] = await tx.insert(sampleRetains).values({
      id: `RET-${pad(await nextSequence(tx, 'custody_retain'), 6)}`, sampleId: c.sampleId, containerId: c.id, retainUntil: body.retainUntil,
      status: 'Retained', createdBy: actor.id, version: 1,
    }).returning();
    const container = await updateVersioned(tx, sampleContainers, c.id, c.version, { status: c.status });
    const event = await appendEvent(tx, {
      containerId: c.id, sampleId: c.sampleId, eventType: 'Retain', delta: 0n, balanceBefore: toUnits(c.quantity), unit: c.unit,
      fromHolderId: c.holderId, toHolderId: c.holderId, fromLocationId: c.locationId, toLocationId: c.locationId, reason: body.reason, actorId: actor.id,
    });
    await writeAudit(tx, actor.id, 'Create', 'SampleRetain', retain.id, 'retainUntil', '',
      JSON.stringify({ sampleId: c.sampleId, containerId: c.id, retainUntil: body.retainUntil, quantity: quantityNumber(c.quantity), unit: c.unit, ...ledgerRef(event) }), body.reason);
    return { retain: retainView(retain), container: containerView(container), event: eventView(event) };
  });
}

export async function listRetains(db: Db, q: { due?: 'true' | 'false'; status?: 'Retained' | 'Disposed' }) {
  const rows = await db.select({ r: sampleRetains, c: sampleContainers }).from(sampleRetains)
    .innerJoin(sampleContainers, eq(sampleContainers.id, sampleRetains.containerId))
    .where(q.status ? eq(sampleRetains.status, q.status) : undefined)
    .orderBy(asc(sampleRetains.retainUntil), asc(sampleRetains.id));
  const today = todayIso();
  return rows
    .map(({ r, c }) => ({ ...r, due: isDue(r, today), quantity: quantityNumber(c.quantity), unit: c.unit, locationId: c.locationId, holderId: c.holderId }))
    .filter(r => q.due === undefined || r.due === (q.due === 'true'));
}

/** The signed disposal of a retained sample (RETAIN_DISPOSAL): only once its retention period has ended, never by its registrant. */
export async function disposeRetain(db: Db, req: Request, actor: Actor, retainId: string,
  body: { password: string; totpCode?: string; method: string; reason: string; expectedVersion: number }) {
  const [retain] = await db.select().from(sampleRetains).where(eq(sampleRetains.id, retainId)).limit(1);
  if (!retain) throw new NotFoundError(`Retain ${retainId} was not found.`);
  if (retain.status === 'Disposed') throw new AppError(409, 'ALREADY_DISPOSED', `Retain ${retainId} was disposed of on ${retain.disposedAt?.toISOString().slice(0, 10)}.`);
  if (retain.version !== body.expectedVersion) throw new ConflictError();
  if (retain.retainUntil > todayIso()) throw new AppError(409, 'RETAIN_NOT_DUE', `Retain ${retainId} must be kept until ${retain.retainUntil}; it may not be disposed of before.`);
  if (retain.createdBy === actor.id) {
    await recordDenied(db, req, actor, { rule: 'custody.retain-disposal', entity: 'SampleRetain', entityId: retainId });
    throw new AppError(403, 'SOD_VIOLATION', `You registered retain ${retainId}: another member of the quality unit must authorise its disposal.`);
  }
  return signRecord({
    db, user: actor, meaningCode: 'RETAIN_DISPOSAL', credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
    entityType: 'SampleRetain', entityId: retainId, sampleId: retain.sampleId, context: securityEventContext(req),
    execute: async (tx) => {
      const c = await lockRow(tx, sampleContainers, retain.containerId);
      const row = await updateVersioned(tx, sampleRetains, retainId, body.expectedVersion, {
        status: 'Disposed', disposedBy: actor.id, disposedAt: new Date(), disposalMethod: body.method,
      });
      const balance = toUnits(c.quantity);
      const container = await updateVersioned(tx, sampleContainers, c.id, c.version, { quantity: unitsText(0n), status: 'Disposed' });
      const event = await appendEvent(tx, {
        containerId: c.id, sampleId: c.sampleId, eventType: 'Dispose', delta: -balance, balanceBefore: balance, unit: c.unit,
        fromLocationId: c.locationId, fromHolderId: c.holderId, reason: `${body.reason} (${body.method})`, actorId: actor.id,
      });
      await writeAudit(tx, actor.id, 'Dispose', 'SampleContainer', c.id, 'status', c.status, 'Disposed', `${body.reason} (retain ${retainId}, ${event.id} ${event.hash})`);
      return {
        recordVersion: row.version, result: { retain: retainView(row), container: containerView(container), event: eventView(event) },
        audit: { action: 'Dispose', field: 'status', oldValue: 'Retained', newValue: 'Disposed', reason: body.reason },
      };
    },
  });
}

// ---- storage locations --------------------------------------------------------------------------------------------------------

export const listLocations = (db: Db) => db.select().from(storageLocations).orderBy(asc(storageLocations.code));

export async function createLocation(db: Db, actor: Actor, body: { code: string; name: string; kind: string; parentId?: string | null; tempMin?: number | null; tempMax?: number | null }) {
  return withTransaction(db, async (tx) => {
    const [dup] = await tx.select({ id: storageLocations.id }).from(storageLocations).where(sql`lower(${storageLocations.code}) = lower(${body.code})`).limit(1);
    if (dup) throw new AppError(409, 'DUPLICATE_CODE', `A storage location with code ${body.code} exists already (${dup.id}).`);
    if (body.parentId) await activeLocation(tx, body.parentId);
    const [loc] = await tx.insert(storageLocations).values({
      id: `LOC-${pad(await nextSequence(tx, 'custody_location'), 6)}`, code: body.code, name: body.name, kind: body.kind,
      parentId: body.parentId ?? null, tempMin: body.tempMin ?? null, tempMax: body.tempMax ?? null, status: 'Active', createdBy: actor.id, version: 1,
    }).returning();
    await writeAudit(tx, actor.id, 'Create', 'StorageLocation', loc.id, 'location', '',
      JSON.stringify({ code: loc.code, name: loc.name, kind: loc.kind, parentId: loc.parentId, tempMin: loc.tempMin, tempMax: loc.tempMax }), 'Storage location defined');
    return loc;
  });
}

export async function updateLocation(db: Db, actor: Actor, id: string, body: { name?: string; tempMin?: number | null; tempMax?: number | null; status?: 'Active' | 'Inactive'; reason: string; expectedVersion: number }) {
  return withTransaction(db, async (tx) => {
    const before = await lockRow(tx, storageLocations, id);
    const set: Partial<Location> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.tempMin !== undefined) set.tempMin = body.tempMin;
    if (body.tempMax !== undefined) set.tempMax = body.tempMax;
    if (body.status !== undefined) set.status = body.status;
    const changed = Object.keys(set).filter(k => (set as any)[k] !== (before as any)[k]);
    if (!changed.length) throw new BadRequestError('Nothing to change.');
    const min = set.tempMin !== undefined ? set.tempMin : before.tempMin;
    const max = set.tempMax !== undefined ? set.tempMax : before.tempMax;
    if (min != null && max != null && min > max) throw new BadRequestError('tempMin must not be above tempMax.');
    if (set.status === 'Inactive') {
      const [held] = await tx.select({ id: sampleContainers.id }).from(sampleContainers)
        .where(and(eq(sampleContainers.locationId, id), eq(sampleContainers.status, 'Active'))).limit(1);
      if (held) throw new AppError(409, 'LOCATION_IN_USE', `Storage location ${before.code} still holds container ${held.id}: move it first.`);
    }
    const loc = await updateVersioned(tx, storageLocations, id, body.expectedVersion, set);
    await writeAudit(tx, actor.id, 'Update', 'StorageLocation', id, changed.join(','),
      JSON.stringify(Object.fromEntries(changed.map(k => [k, (before as any)[k]]))), JSON.stringify(Object.fromEntries(changed.map(k => [k, (loc as any)[k]]))), body.reason);
    return loc;
  });
}

// ---- labels -------------------------------------------------------------------------------------------------------------------

export interface LabelContent { code: string; title: string; lines: string[] }

const range = (min: number | null, max: number | null) => (min == null && max == null ? null : `${min ?? '-∞'} to ${max ?? '+∞'} °C`);

/** What a label of the record shows: the code (what the barcode encodes and a scan resolves) and the human-readable lines. */
export async function labelContent(ex: Executor, entityType: string, entityId: string): Promise<LabelContent> {
  if (entityType === 'Sample') {
    const [s] = await ex.select().from(samples).where(eq(samples.id, entityId)).limit(1);
    if (!s) throw new NotFoundError(`Sample ${entityId} was not found.`);
    const r = await readReceipt(ex, s.id);
    return {
      code: s.id, title: s.id,
      lines: [s.material, `Batch ${s.batch}`, ...(r?.expDate ? [`Exp ${r.expDate}`] : []), ...(r ? [`Store: ${r.requiredStorage}`] : [])],
    };
  }
  if (entityType === 'Container') {
    const [c] = await ex.select().from(sampleContainers).where(eq(sampleContainers.id, entityId)).limit(1);
    if (!c) throw new NotFoundError(`Container ${entityId} was not found.`);
    const r = await readReceipt(ex, c.sampleId);
    return {
      code: c.id, title: c.id,
      lines: [`Sample ${c.sampleId}`, `${c.kind}${c.parentId ? ` of ${c.parentId}` : ''}`, ...(r ? [`Store: ${r.requiredStorage}`] : [])],
    };
  }
  const [l] = await ex.select().from(storageLocations).where(eq(storageLocations.id, entityId)).limit(1);
  if (!l) throw new NotFoundError(`Storage location ${entityId} was not found.`);
  const t = range(l.tempMin, l.tempMax);
  return { code: l.id, title: l.code, lines: [l.name, l.kind, ...(t ? [t] : [])] };
}

const hasPrint = (ex: Executor, entityType: string, entityId: string) =>
  ex.select({ id: labelPrints.id }).from(labelPrints).where(and(eq(labelPrints.entityType, entityType), eq(labelPrints.entityId, entityId))).limit(1).then(r => r.length > 0);

const reprintRefused = () => new AppError(400, 'REPRINT_REASON_REQUIRED',
  'This label has been printed before: a reprint needs a reason of at least 5 characters (for example "label smudged").');

export async function printLabel(db: Db, actor: Actor, body: { entityType: string; entityId: string; symbology: string; copies: number; reason?: string }) {
  const reason = body.reason?.trim() || null;
  // Asked before the transaction for a quick answer, and decided again under the label log's lock.
  if (!reason || reason.length < 5) { if (await hasPrint(db, body.entityType, body.entityId)) throw reprintRefused(); }
  return withTransaction(db, async (tx) => {
    const label = await labelContent(tx, body.entityType, body.entityId);
    const print = await appendPrint(tx, {
      entityType: body.entityType, entityId: body.entityId, code: label.code, symbology: body.symbology, copies: body.copies, reason, printedBy: actor.id,
    }, (t) => hasPrint(t, body.entityType, body.entityId));
    if (print.isReprint && (!reason || reason.length < 5)) throw reprintRefused();
    await writeAudit(tx, actor.id, print.isReprint ? 'Reprint' : 'Print', 'LabelPrint', print.id, 'label', '',
      JSON.stringify({ entityType: print.entityType, entityId: print.entityId, code: print.code, symbology: print.symbology, copies: print.copies, hash: print.hash }),
      reason ?? `First print of the ${body.entityType.toLowerCase()} label`);
    return { print, label: { ...label, symbology: print.symbology, copies: print.copies } };
  });
}

export async function listLabelPrints(db: Db, q: { entityType?: string; entityId?: string }) {
  const where = and(q.entityType ? eq(labelPrints.entityType, q.entityType) : undefined, q.entityId ? eq(labelPrints.entityId, q.entityId) : undefined);
  return db.select().from(labelPrints).where(where).orderBy(asc(labelPrints.seq)).limit(1000);
}

// ---- reading -----------------------------------------------------------------------------------------------------------------

/** Everything custody knows about a sample: status, receipt, containers, ledger, retains and label prints. */
export async function getSampleCustody(db: Db, sampleId: string) {
  const [sample] = await db.select({ id: samples.id, state: samples.state, material: samples.material, batch: samples.batch }).from(samples).where(eq(samples.id, sampleId)).limit(1);
  if (!sample) throw new NotFoundError(`Sample ${sampleId} was not found.`);
  const receipt = await readReceipt(db, sampleId);
  const containers = await db.select().from(sampleContainers).where(eq(sampleContainers.sampleId, sampleId)).orderBy(asc(sampleContainers.id));
  const events = await eventsOfSample(db, sampleId);
  const retains = await db.select().from(sampleRetains).where(eq(sampleRetains.sampleId, sampleId)).orderBy(asc(sampleRetains.id));
  const ids = [sampleId, ...containers.map(c => c.id)];
  const labels = await db.select().from(labelPrints)
    .where(or(and(eq(labelPrints.entityType, 'Sample'), eq(labelPrints.entityId, sampleId)), and(eq(labelPrints.entityType, 'Container'), inArray(labelPrints.entityId, ids))))
    .orderBy(asc(labelPrints.seq));
  const retained = new Set(retains.filter(r => r.status === 'Retained').map(r => r.containerId));
  return {
    sample, status: custodyStatus(receipt), receipt,
    containers: containers.map(c => ({ ...containerView(c), retained: retained.has(c.id) })),
    events: events.map(eventView), retains: retains.map(retainView), labels,
  };
}

export const verifyCustody = (db: Db) => verifyChains(db);
