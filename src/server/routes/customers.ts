// Domain: customers (roadmap M17). Owned by r2-master-data.
//
//   GET  /customers               every customer, by name.
//   POST /customers               create (code, name, contact). The code is unique whatever its case (409).
//   PUT  /customers/:id           name and contact, with the version predicate; one audit entry per changed field.
//   POST /customers/:id/status    Active <-> Inactive with a reason (audited). An Inactive customer takes no new registration.
import { asc, eq, sql } from 'drizzle-orm';
import { customers } from '../../db/schema/master';
import { writeAudit } from '../../db/utils';
import { customerCreateSchema, customerStatusSchema, customerUpdateSchema } from '../../lib/validations/master';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { AppError, ConflictError } from '../http/errors';
import { validate } from '../http/validate';
import { auditValue, isUniqueViolation, newId } from './products';

type Customer = typeof customers.$inferSelect;

export const customersRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/customers', requireAuth, async (_req, res) => {
    res.json(await db.select().from(customers).orderBy(asc(customers.name)));
  });

  router.post('/customers', requireAuth, validate(customerCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const { code, name, contact } = req.body as { code: string; name: string; contact?: string };
    const created = await withTransaction(db, async (tx) => {
      const [same] = await tx.select({ id: customers.id }).from(customers).where(sql`lower(${customers.code}) = ${code.toLowerCase()}`).limit(1);
      if (same) throw new AppError(409, 'DUPLICATE', `The customer code '${code}' is already used (${same.id}).`);
      let row: Customer;
      try {
        [row] = await tx.insert(customers).values({ id: newId('CUS'), code, name, contact: contact || null, status: 'Active', createdBy: user.id, version: 1 }).returning();
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `The customer code '${code}' is already used.`);
        throw e;
      }
      await writeAudit(tx, user.id, 'Create', 'Customer', row.id, 'all', '', JSON.stringify({ code, name, contact: row.contact, status: 'Active' }), 'Customer created');
      return row;
    });
    res.json(created);
  });

  router.put('/customers/:id', requireAuth, validate(customerUpdateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { expectedVersion, ...changes } = req.body as { expectedVersion: number; name?: string; contact?: string | null };
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, customers, id);
      if (current.version !== expectedVersion) throw new ConflictError();
      const set: Partial<Customer> = {};
      if (changes.name !== undefined && changes.name !== current.name) set.name = changes.name;
      if (changes.contact !== undefined && (changes.contact || null) !== current.contact) set.contact = changes.contact || null;
      if (Object.keys(set).length === 0) return current;
      const row = await updateVersioned(tx, customers, id, expectedVersion, set);
      for (const k of Object.keys(set) as Array<keyof typeof set>) {
        await writeAudit(tx, user.id, 'Update', 'Customer', id, k, auditValue(current[k]), auditValue(row[k]), 'Customer record edited');
      }
      return row;
    });
    res.json(updated);
  });

  router.post('/customers/:id/status', requireAuth, validate(customerStatusSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { status, reason, expectedVersion } = req.body as { status: string; reason: string; expectedVersion: number };
    const updated = await withTransaction(db, async (tx) => {
      const current = await lockRow(tx, customers, id);
      if (current.version !== expectedVersion) throw new ConflictError();
      if (current.status === status) throw new AppError(409, 'ILLEGAL_TRANSITION', `Customer ${current.name} is already ${status}.`);
      const row = await updateVersioned(tx, customers, id, expectedVersion, { status });
      await writeAudit(tx, user.id, 'StatusChange', 'Customer', id, 'status', current.status, status, reason);
      return row;
    });
    res.json(updated);
  });

  return router;
};
