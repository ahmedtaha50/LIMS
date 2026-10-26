// Strict request schemas of the custody routes (roadmap M29). Owned by r2-custody-labels. Server-controlled fields (ids, receiver,
// deviation, balances, holders of record, status, version, signatures) are not accepted: an unknown key is a 400 (AGENTS.md s.3).
// The route table (src/server/authz/routeTable.ts) names the same schemas as the bodies of the rules, so the two cannot drift.
import { z } from 'zod';
import { signatureFields } from '../../lib/validations/signatures';

export const RECEIPT_CONDITIONS = ['Intact', 'Damaged', 'Leaking', 'Contaminated'] as const;
export const LOCATION_KINDS = ['Site', 'Building', 'Room', 'Storage unit', 'Shelf', 'Box'] as const;
export const LABEL_ENTITY_TYPES = ['Sample', 'Container', 'Location'] as const;
export const LABEL_SYMBOLOGIES = ['code128', 'qr'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.');
const version = z.number('expectedVersion must be a number').int().min(1);
const id = z.string().trim().min(1).max(100);
const reason = z.string().trim().min(5, 'reason: at least 5 characters.').max(1000);
const temperature = z.number().min(-273).max(200);
/** A quantity: positive, at most 4 decimals (the ledger's numeric(14, 4)), below 10^10. */
const quantity = z.number('quantity must be a number').positive('quantity must be greater than 0.').max(9_999_999_999)
  .refine(q => Math.abs(Math.round(q * 10_000) - q * 10_000) < 1e-6, 'quantity: at most 4 decimals.');
const unit = z.string().trim().min(1).max(20);
const credentials = { password: signatureFields.password, totpCode: signatureFields.totpCode };

/** POST /custody/samples/:id/receipt. The receiver is req.user; the deviation is decided by the server. */
export const receiptSchema = z.object({
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  condition: z.enum(RECEIPT_CONDITIONS),
  sealIntact: z.boolean(),
  temperatureC: temperature.nullable().optional(),
  requiredStorage: z.string().trim().min(2, 'requiredStorage: say how the sample must be stored.').max(200),
  requiredTempMin: temperature.nullable().optional(),
  requiredTempMax: temperature.nullable().optional(),
  mfgDate: isoDate.nullable().optional(),
  expDate: isoDate.nullable().optional(),
  quantity,
  unit,
  locationId: id.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict().refine(b => b.requiredTempMin == null || b.requiredTempMax == null || b.requiredTempMin <= b.requiredTempMax,
  { message: 'requiredTempMin must not be above requiredTempMax.', path: ['requiredTempMin'] });

/** POST /custody/samples/:id/receipt/acknowledge: QA's signature (CUSTODY_DEVIATION_ACK) on a receipt deviation. */
export const receiptAckSchema = z.object({ ...credentials, reason, expectedVersion: version }).strict();

/** POST /custody/containers/:id/aliquots */
export const aliquotSchema = z.object({ quantity, reason, expectedVersion: version, locationId: id.nullable().optional() }).strict();

/** POST /custody/containers/:id/consume */
export const consumeSchema = z.object({ quantity, reason, expectedVersion: version }).strict();

/** POST /custody/containers/:id/transfer: a new place, a new holder, or both. */
export const transferSchema = z.object({
  toLocationId: id.nullable().optional(),
  toHolderId: id.optional(),
  reason,
  expectedVersion: version,
}).strict().refine(b => b.toLocationId !== undefined || b.toHolderId !== undefined, { message: 'Name the new location (toLocationId), the new holder (toHolderId) or both.' });

/** POST /custody/containers/:id/retain */
export const retainSchema = z.object({ retainUntil: isoDate, reason, expectedVersion: version }).strict();

/** POST /custody/retains/:id/dispose: QA's signature (RETAIN_DISPOSAL). */
export const disposeSchema = z.object({
  ...credentials,
  method: z.string().trim().min(3, 'method: say how the sample is disposed of.').max(300),
  reason,
  expectedVersion: version,
}).strict();

const locationBase = {
  name: z.string().trim().min(1).max(200),
  tempMin: temperature.nullable().optional(),
  tempMax: temperature.nullable().optional(),
};
const tempOrder = (b: { tempMin?: number | null; tempMax?: number | null }) => b.tempMin == null || b.tempMax == null || b.tempMin <= b.tempMax;

/** POST /custody/locations */
export const locationCreateSchema = z.object({
  code: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'code: letters, digits, dot, dash and underscore.'),
  kind: z.enum(LOCATION_KINDS),
  parentId: id.nullable().optional(),
  ...locationBase,
}).strict().refine(tempOrder, { message: 'tempMin must not be above tempMax.', path: ['tempMin'] });

/** PUT /custody/locations/:id */
export const locationUpdateSchema = z.object({
  name: locationBase.name.optional(),
  tempMin: locationBase.tempMin,
  tempMax: locationBase.tempMax,
  status: z.enum(['Active', 'Inactive']).optional(),
  reason,
  expectedVersion: version,
}).strict().refine(tempOrder, { message: 'tempMin must not be above tempMax.', path: ['tempMin'] });

/** POST /custody/labels. Whether this is a reprint is decided by the server from the label log. */
export const labelPrintSchema = z.object({
  entityType: z.enum(LABEL_ENTITY_TYPES),
  entityId: id,
  symbology: z.enum(LABEL_SYMBOLOGIES),
  copies: z.number().int().min(1).max(50),
  reason: z.string().trim().max(500).optional(),
}).strict();

/** GET /custody/labels */
export const labelQuerySchema = z.object({ entityType: z.enum(LABEL_ENTITY_TYPES).optional(), entityId: id.optional() }).strict();

/** GET /custody/retains */
export const retainQuerySchema = z.object({ due: z.enum(['true', 'false']).optional(), status: z.enum(['Retained', 'Disposed']).optional() }).strict();

/** GET /resolve */
export const resolveQuerySchema = z.object({ code: z.string().trim().min(1, 'code is required.').max(200) }).strict();
