// Domain: products (roadmap M17). Owned by r2-master-data.
//
//   GET  /products               every product, by name.
//   GET  /products/:id           the product, its batches and the specification revision in force for it (resolveActiveSpec).
//   POST /products               create (code, name, description). Unique by code and by the material key of the name (409).
//   PUT  /products/:id           edit the description (version predicate). Name and code never change: they are the text samples
//                                and specifications hold.
//   POST /products/:id/status    Active <-> Inactive, e-signed (MASTER_DATA_STATUS) and bound to the new record version. An Inactive
//                                product takes no new batch and no new registration.
// Every write has its audit entry in the same transaction. Who may call each route: src/server/authz/routeTable.ts (master.*).
import { randomBytes } from 'crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { productBatches, products } from '../../db/schema/master';
import { writeAudit } from '../../db/utils';
import { productCreateSchema, productStatusSchema, productUpdateSchema } from '../../lib/validations/master';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { asSigned, registerSignable, signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import { materialKey, materialKeySql, resolveActiveSpec } from '../lib/specs';

/** The meaning of every product and batch status signature (catalog row of migration 0100). */
export const MASTER_STATUS_MEANING = 'MASTER_DATA_STATUS';

export const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;
export const isUniqueViolation = (e: any) => (e?.cause?.code ?? e?.code) === '23505';
/** An audit value: '' for nothing, the text otherwise. */
export const auditValue = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// A signature on a product covers what never changes (id, code, name) and the status as signed.
registerSignable({
  type: 'Product',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, code: row.code, name: row.name, status: asSigned(change, ['status'], row.status) };
  },
});

export const productsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/products', requireAuth, async (_req, res) => {
    res.json(await db.select().from(products).orderBy(asc(products.name)));
  });

  router.get('/products/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!product) throw new NotFoundError(`Product ${id} was not found.`);
    const batches = await db.select().from(productBatches).where(eq(productBatches.productId, id)).orderBy(desc(productBatches.createdAt), asc(productBatches.batchNo));
    const spec = await resolveActiveSpec(db, product.name);
    res.json({
      product, batches,
      activeSpec: spec ? { id: spec.id, revision: spec.revision, effectiveDate: spec.effectiveDate, parameters: spec.parameters.map(p => p.name) } : null,
    });
  });

  router.post('/products', requireAuth, validate(productCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const { code, name, description } = req.body as { code: string; name: string; description?: string };
    const created = await withTransaction(db, async (tx) => {
      const [sameName] = await tx.select({ id: products.id, name: products.name }).from(products).where(sql`${materialKeySql(products.name)} = ${materialKey(name)}`).limit(1);
      if (sameName) throw new AppError(409, 'DUPLICATE', `A product named '${sameName.name}' already exists (${sameName.id}).`);
      const [sameCode] = await tx.select({ id: products.id }).from(products).where(sql`lower(${products.code}) = ${code.toLowerCase()}`).limit(1);
      if (sameCode) throw new AppError(409, 'DUPLICATE', `The product code '${code}' is already used (${sameCode.id}).`);
      const record = { id: newId('PRD'), code, name, description: description || null, status: 'Active', origin: 'entry', createdBy: user.id, version: 1 };
      let row;
      try {
        [row] = await tx.insert(products).values(record).returning();
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `A product with the code '${code}' or the name '${name}' already exists.`);
        throw e;
      }
      await writeAudit(tx, user.id, 'Create', 'Product', row.id, 'all', '', JSON.stringify({ code, name, description: record.description, status: 'Active' }), 'Product created');
      return row;
    });
    res.json(created);
  });

  router.put('/products/:id', requireAuth, validate(productUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { description, expectedVersion } = req.body as { description: string; expectedVersion: number };
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, products, id);
      if (current.version !== expectedVersion) throw new ConflictError();
      const row = await updateVersioned(tx, products, id, expectedVersion, { description: description || null });
      await writeAudit(tx, user.id, 'Update', 'Product', id, 'description', auditValue(current.description), auditValue(row.description), 'Product description edited');
      return row;
    });
    res.json(updated);
  });

  router.post('/products/:id/status', requireAuth, validate(productStatusSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { status, expectedVersion, password, totpCode, reason } = req.body as { status: string; expectedVersion: number; password: string; totpCode?: string; reason: string };

    // Decided before the signature is asked for: a refused change costs the signer no attempt.
    const check = (row: typeof products.$inferSelect) => {
      if (row.version !== expectedVersion) throw new ConflictError();
      if (row.status === status) throw new AppError(409, 'ILLEGAL_TRANSITION', `Product ${id} is already ${status}.`);
    };
    const [found] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!found) throw new NotFoundError(`Product ${id} was not found.`);
    check(found);

    const { result, signature } = await signRecord({
      db, user, meaningCode: MASTER_STATUS_MEANING, credentials: { password, totpCode }, reason,
      entityType: 'Product', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const current = await lockRow(tx, products, id);
        check(current);
        const row = await updateVersioned(tx, products, id, expectedVersion, { status });
        return { recordVersion: row.version, audit: { action: 'StatusChange', field: 'status', oldValue: current.status, newValue: status, reason }, result: row };
      },
    });
    res.json({ product: result, signature });
  });

  return router;
};
