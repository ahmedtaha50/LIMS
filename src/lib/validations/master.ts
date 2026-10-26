// Request schemas of the master data routes (roadmap M17). Strict. Owned by r2-master-data.
// Server-controlled fields (id, status, version, origin, created_by, created_at) are not accepted anywhere: a status moves only
// through its own route, and an e-signature for a product or a batch (meaning MASTER_DATA_STATUS, chosen by the server).
import { z } from 'zod';
import { signatureFields } from './signatures';

const text = (label: string, max = 200) => z.string(`${label} is required.`).trim().min(1, `${label} is required.`).max(max, `${label} is too long (at most ${max} characters).`);
const optionalText = (label: string, max = 1000) => z.string(`${label} must be text.`).trim().max(max, `${label} is too long (at most ${max} characters).`).optional();
/** Runs of spaces are one space: the name is the text samples.material will hold. */
const name = (label: string) => text(label).transform(v => v.replace(/\s+/g, ' '));
const expectedVersion = z.number('expectedVersion is required.').int().positive('Record version mismatch. Refresh required.');
const id = (label: string) => z.string(`${label} is required.`).trim().min(1, `${label} is required.`).max(100);

/** A calendar day, YYYY-MM-DD, that exists (2026-02-30 does not). */
export function isCalendarDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const day = (label: string) => z.string(`${label} must be a date.`).refine(isCalendarDay, `${label} must be a calendar day written YYYY-MM-DD.`);
const expiryAfterManufacture = (v: { manufacturedOn?: string | null; expiresOn?: string | null }) =>
  !v.manufacturedOn || !v.expiresOn || v.expiresOn >= v.manufacturedOn;
const EXPIRY_MESSAGE = { message: 'The expiry date cannot be before the manufacturing date.', path: ['expiresOn'] };

const signing = {
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: z.string('A reason is required for a status change.').trim().min(5, 'Give the reason for the status change (at least 5 characters).').max(1000),
  expectedVersion,
};

// ---- products ----------------------------------------------------------------------------------------------------------------

/** POST /products. `name` is the material the specifications are written for; it and `code` never change afterwards. */
export const productCreateSchema = z.object({
  code: text('Product code', 50),
  name: name('Product name'),
  description: optionalText('Description'),
}).strict();

/** PUT /products/:id. Only the description is editable. */
export const productUpdateSchema = z.object({
  description: z.string('Description must be text.').trim().max(1000),
  expectedVersion,
}).strict();

export const PRODUCT_STATUS_VALUES = ['Active', 'Inactive'] as const;
/** POST /products/:id/status: an e-signature. */
export const productStatusSchema = z.object({
  status: z.enum(PRODUCT_STATUS_VALUES, { error: `status must be one of ${PRODUCT_STATUS_VALUES.join(', ')}.` }),
  ...signing,
}).strict();

// ---- batches -----------------------------------------------------------------------------------------------------------------

/** POST /batches. A batch starts in Quarantine. */
export const batchCreateSchema = z.object({
  productId: id('Product'),
  batchNo: name('Batch number').pipe(z.string().max(100, 'Batch number is too long (at most 100 characters).')),
  manufacturedOn: day('Manufacturing date').optional(),
  expiresOn: day('Expiry date').optional(),
  batchSize: optionalText('Batch size', 100),
}).strict().refine(expiryAfterManufacture, EXPIRY_MESSAGE);

/** PUT /batches/:id, while the batch is in Quarantine. null clears a value. */
export const batchUpdateSchema = z.object({
  manufacturedOn: day('Manufacturing date').nullable().optional(),
  expiresOn: day('Expiry date').nullable().optional(),
  batchSize: z.string('Batch size must be text.').trim().max(100).nullable().optional(),
  expectedVersion,
}).strict().refine(expiryAfterManufacture, EXPIRY_MESSAGE);

export const BATCH_STATUS_VALUES = ['Quarantine', 'Released', 'Rejected', 'Recalled'] as const;
/** POST /batches/:id/status: an e-signature. */
export const batchStatusSchema = z.object({
  status: z.enum(BATCH_STATUS_VALUES, { error: `status must be one of ${BATCH_STATUS_VALUES.join(', ')}.` }),
  ...signing,
}).strict();

/** GET /batches query. */
export const batchListQuerySchema = z.object({
  productId: z.string().max(100).optional(),
  status: z.enum(BATCH_STATUS_VALUES).optional(),
}).strict();

/** POST /batches/:id/samples: register a sample of this batch. Material and batch text come from the master rows. */
export const batchSampleSchema = z.object({
  customerId: id('Customer').optional(),
}).strict();

// ---- customers ---------------------------------------------------------------------------------------------------------------

/** POST /customers. */
export const customerCreateSchema = z.object({
  code: text('Customer code', 50),
  name: name('Customer name'),
  contact: optionalText('Contact', 300),
}).strict();

/** PUT /customers/:id. */
export const customerUpdateSchema = z.object({
  name: name('Customer name').optional(),
  contact: z.string('Contact must be text.').trim().max(300).nullable().optional(),
  expectedVersion,
}).strict();

export const CUSTOMER_STATUS_VALUES = ['Active', 'Inactive'] as const;
/** POST /customers/:id/status: audited with its reason (not an e-signature). */
export const customerStatusSchema = z.object({
  status: z.enum(CUSTOMER_STATUS_VALUES, { error: `status must be one of ${CUSTOMER_STATUS_VALUES.join(', ')}.` }),
  reason: signing.reason,
  expectedVersion,
}).strict();
