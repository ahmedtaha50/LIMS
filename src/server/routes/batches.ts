// Domain: product batches and registration from them (roadmap M17). Owned by r2-master-data.
//
//   GET  /batches                 ?productId, ?status. Each batch with its product's name.
//   GET  /batches/:id             the batch, its product and the samples registered against it (sample_context).
//   POST /batches                 create in Quarantine. Unique per product (409; case and spaces do not make another number); the
//                                 same number under another product is another batch.
//   PUT  /batches/:id             dates and size, while in Quarantine (423 afterwards), with the version predicate; one audit entry
//                                 per changed field.
//   POST /batches/:id/status      e-signed (MASTER_DATA_STATUS). Quarantine -> Released (only once the formal batch release,
//                                 POST /traceability/batch/:batch/release, has released that batch number) | Rejected;
//                                 Released -> Recalled. Rejected and Recalled are final (423).
//   POST /batches/:id/samples     registers a sample of the batch: samples.material and samples.batch are filled from the product
//                                 and the batch (the frozen text columns the signed hashes cover), the ids go to sample_context, the
//                                 sample is bound to the specification revision in force, all in one transaction.
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { batchReleases, samples } from '../../db/schema';
import { customers, productBatches, products, sampleContext } from '../../db/schema/master';
import { writeAudit } from '../../db/utils';
import { batchCreateSchema, batchListQuerySchema, batchSampleSchema, batchStatusSchema, batchUpdateSchema } from '../../lib/validations/master';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Executor } from '../core/tx';
import { asSigned, registerSignable, signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { resolveActiveSpec } from '../lib/specs';
import type { BatchSample, ReleaseBlocker } from '../release-blockers';
import { auditValue, isUniqueViolation, MASTER_STATUS_MEANING, newId } from './products';
import { insertSamples } from './samples';

type Batch = typeof productBatches.$inferSelect;

/** The moves a batch status may make. Anything else is 409; from a final status, 423. */
const NEXT: Record<string, readonly string[]> = { Quarantine: ['Released', 'Rejected'], Released: ['Recalled'], Rejected: [], Recalled: [] };
/** Batches a sample may still be registered against (QC testing happens in quarantine; retest and stability after release). */
const REGISTRABLE = new Set(['Quarantine', 'Released']);
const batchKey = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
const batchKeySql = (column: unknown) => sql`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`;

// A signature on a batch covers its identity, dates and size (frozen once it leaves Quarantine) and the status as signed.
registerSignable({
  type: 'ProductBatch',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(productBatches).where(eq(productBatches.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id, productId: row.productId, batchNo: row.batchNo, manufacturedOn: row.manufacturedOn, expiresOn: row.expiresOn,
      batchSize: row.batchSize, status: asSigned(change, ['status'], row.status),
    };
  },
});

/**
 * Release blocker (for src/server/release-blockers): a batch number that a master batch has Rejected or Recalled is not released.
 * Exported for the registry's owner to list; see docs/changes/r2-master-data.md.
 */
export const masterBatchReleaseBlocker: ReleaseBlocker = {
  name: 'master-batch-status',
  async check(ex: Executor, batch: string, _samples: readonly BatchSample[]) {
    const rows = await ex.select({ id: productBatches.id, status: productBatches.status, product: products.name }).from(productBatches)
      .innerJoin(products, eq(products.id, productBatches.productId)).where(eq(productBatches.batchNo, batch)).orderBy(productBatches.id);
    return rows.filter(r => r.status === 'Rejected' || r.status === 'Recalled')
      .map(r => `Batch ${batch} of ${r.product} (${r.id}) is ${r.status} in the master data.`);
  },
};

async function assertMove(ex: Executor, b: Batch, to: string, expectedVersion: number) {
  if (b.version !== expectedVersion) throw new ConflictError();
  if (NEXT[b.status]?.length === 0) throw new AppError(423, 'RECORD_LOCKED', `Batch ${b.batchNo} is ${b.status}: its status is final.`);
  if (!NEXT[b.status]?.includes(to)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Batch ${b.batchNo} cannot move from ${b.status} to ${to}.`);
  if (to === 'Released') {
    const [rel] = await ex.select({ status: batchReleases.status }).from(batchReleases).where(eq(batchReleases.batch, b.batchNo)).limit(1);
    if (rel?.status !== 'Released') {
      throw new AppError(409, 'RELEASE_REQUIRED', `Batch ${b.batchNo} has not been released by the formal batch release (QA disposition, Traceability). Release it there first.`);
    }
  }
}

export const batchesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/batches', requireAuth, validate(batchListQuerySchema, 'query'), async (req, res) => {
    const { productId, status } = req.query as { productId?: string; status?: string };
    const where: SQL[] = [];
    if (productId) where.push(eq(productBatches.productId, productId));
    if (status) where.push(eq(productBatches.status, status));
    const rows = await db.select({ batch: productBatches, productName: products.name, productStatus: products.status }).from(productBatches)
      .innerJoin(products, eq(products.id, productBatches.productId)).where(where.length ? and(...where) : undefined)
      .orderBy(desc(productBatches.createdAt), asc(productBatches.batchNo));
    res.json(rows.map(r => ({ ...r.batch, productName: r.productName, productStatus: r.productStatus })));
  });

  router.get('/batches/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [b] = await db.select().from(productBatches).where(eq(productBatches.id, id)).limit(1);
    if (!b) throw new NotFoundError(`Batch ${id} was not found.`);
    const [product] = await db.select().from(products).where(eq(products.id, b.productId)).limit(1);
    const registered = await db.select({ sample: samples, customerId: sampleContext.customerId }).from(sampleContext)
      .innerJoin(samples, eq(samples.id, sampleContext.sampleId)).where(eq(sampleContext.batchId, id)).orderBy(asc(samples.id));
    res.json({ batch: b, product, samples: registered.map(r => ({ ...r.sample, customerId: r.customerId })) });
  });

  router.post('/batches', requireAuth, validate(batchCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as { productId: string; batchNo: string; manufacturedOn?: string; expiresOn?: string; batchSize?: string };
    const created = await withTransaction(db, async (tx) => {
      const [product] = await tx.select().from(products).where(eq(products.id, body.productId)).limit(1);
      if (!product) throw new NotFoundError(`Product ${body.productId} was not found.`);
      if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}: no new batch can be created.`);
      const [same] = await tx.select({ id: productBatches.id, batchNo: productBatches.batchNo }).from(productBatches)
        .where(and(eq(productBatches.productId, product.id), sql`${batchKeySql(productBatches.batchNo)} = ${batchKey(body.batchNo)}`)).limit(1);
      if (same) throw new AppError(409, 'DUPLICATE', `Batch ${same.batchNo} of ${product.name} already exists (${same.id}).`);
      const record = {
        id: newId('PB'), productId: product.id, batchNo: body.batchNo, status: 'Quarantine', manufacturedOn: body.manufacturedOn ?? null,
        expiresOn: body.expiresOn ?? null, batchSize: body.batchSize || null, origin: 'entry', createdBy: user.id, version: 1,
      };
      let row: Batch;
      try {
        [row] = await tx.insert(productBatches).values(record).returning();
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `Batch ${body.batchNo} of ${product.name} already exists.`);
        throw e;
      }
      const { createdBy: _c, createdAt: _t, ...stated } = row;
      await writeAudit(tx, user.id, 'Create', 'ProductBatch', row.id, 'all', '', JSON.stringify(stated), `Batch ${row.batchNo} of ${product.name} created`);
      return row;
    });
    res.json(created);
  });

  router.put('/batches/:id', requireAuth, validate(batchUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { expectedVersion, ...changes } = req.body as { expectedVersion: number; manufacturedOn?: string | null; expiresOn?: string | null; batchSize?: string | null };
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, productBatches, id);
      if (current.status !== 'Quarantine') throw new AppError(423, 'RECORD_LOCKED', `Batch ${current.batchNo} is ${current.status}: its record can no longer be edited.`);
      if (current.version !== expectedVersion) throw new ConflictError();
      const set: Partial<Batch> = {};
      for (const [k, v] of Object.entries(changes) as Array<[keyof typeof changes, string | null | undefined]>) {
        if (v !== undefined && (v || null) !== current[k]) (set as any)[k] = v || null;
      }
      const next = { manufacturedOn: current.manufacturedOn, expiresOn: current.expiresOn, ...set };
      if (next.manufacturedOn && next.expiresOn && next.expiresOn < next.manufacturedOn) throw new BadRequestError('The expiry date cannot be before the manufacturing date.');
      if (Object.keys(set).length === 0) return current;
      const row = await updateVersioned(tx, productBatches, id, expectedVersion, set);
      for (const k of Object.keys(set) as Array<keyof typeof set>) {
        await writeAudit(tx, user.id, 'Update', 'ProductBatch', id, k, auditValue(current[k]), auditValue(row[k]), `Batch ${row.batchNo} record edited`);
      }
      return row;
    });
    res.json(updated);
  });

  router.post('/batches/:id/status', requireAuth, validate(batchStatusSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { status, expectedVersion, password, totpCode, reason } = req.body as { status: string; expectedVersion: number; password: string; totpCode?: string; reason: string };

    const [found] = await db.select().from(productBatches).where(eq(productBatches.id, id)).limit(1);
    if (!found) throw new NotFoundError(`Batch ${id} was not found.`);
    await assertMove(db, found, status, expectedVersion);

    const { result, signature } = await signRecord({
      db, user, meaningCode: MASTER_STATUS_MEANING, credentials: { password, totpCode }, reason,
      entityType: 'ProductBatch', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, productBatches, id);
        await assertMove(tx, current, status, expectedVersion);
        const row = await updateVersioned(tx, productBatches, id, expectedVersion, { status });
        return { recordVersion: row.version, audit: { action: 'StatusChange', field: 'status', oldValue: current.status, newValue: status, reason }, result: row };
      },
    });
    res.json({ batch: result, signature });
  });

  router.post('/batches/:id/samples', requireAuth, validate(batchSampleSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { customerId } = req.body as { customerId?: string };
    const registered = await withTransaction(db, async (tx) => {
      // The batch is locked: its status cannot change while the sample is registered against it.
      const b = await lockRow(tx, productBatches, id);
      if (!REGISTRABLE.has(b.status)) throw new AppError(409, 'BATCH_NOT_USABLE', `Batch ${b.batchNo} is ${b.status}: no sample can be registered against it.`);
      const [product] = await tx.select().from(products).where(eq(products.id, b.productId)).limit(1);
      if (product.status !== 'Active') throw new AppError(409, 'PRODUCT_INACTIVE', `Product ${product.name} is ${product.status}: no sample can be registered for it.`);
      if (customerId) {
        const [customer] = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
        if (!customer) throw new NotFoundError(`Customer ${customerId} was not found.`);
        if (customer.status !== 'Active') throw new AppError(409, 'CUSTOMER_INACTIVE', `Customer ${customer.name} is ${customer.status}.`);
      }
      const spec = await resolveActiveSpec(tx, product.name);
      if (!spec) throw new BadRequestError(`Cannot register sample: No Active specification is in force for material '${product.name}'. Create and approve a specification first.`);
      if (spec.parameters.length === 0) throw new BadRequestError(`Cannot register sample: The specification ${spec.id} (revision ${spec.revision}) of '${product.name}' has no parameters.`);

      const [sample] = await insertSamples(tx, user, [{ material: product.name, batch: b.batchNo, spec }], `Registration from batch ${b.batchNo} of ${product.name}`);
      const context = { sampleId: sample.id, productId: product.id, batchId: b.id, customerId: customerId ?? null, origin: 'registration', createdBy: user.id };
      await tx.insert(sampleContext).values(context);
      await writeAudit(tx, user.id, 'Create', 'SampleContext', sample.id, 'all', '',
        JSON.stringify({ productId: context.productId, batchId: context.batchId, customerId: context.customerId }), 'Sample registered against master data');
      return { sample: { ...sample, version: 1 }, context };
    });
    res.json(registered);
  });

  return router;
};
