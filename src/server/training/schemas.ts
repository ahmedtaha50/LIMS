/**
 * Strict request schemas of the document and training routes (roadmap M28). Server-controlled fields (ids, status, version counters,
 * signatures, authors, `isSoftware`, origins) are never accepted: an unknown key is a 400 (AGENTS.md section 3). The route table
 * (src/server/authz/routeTable.ts) names the same schemas as the routes' bodies.
 */
import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../db/schema/documents';
import { TRAINING_METHODS } from '../../db/schema/training';
import { ROLE_NAMES } from '../../lib/permissions';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const code = z.string().trim().min(2, 'The code needs at least 2 characters.').max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'The code may contain letters, digits, ".", "_" and "-".');
const title = z.string().trim().min(3, 'The title needs at least 3 characters.').max(200);
const expectedVersion = z.number().int().min(1);
const reason = z.string().trim().min(5, 'A reason of at least 5 characters is required.').max(1000);
const credentials = { password: z.string().min(1, 'Password required').max(1024), totpCode: z.string().regex(/^\d{6}$/).optional() };
const day = z.string().regex(DAY, 'Use a calendar date (YYYY-MM-DD).');

// ---- documents ----------------------------------------------------------------------------------------------------------------

export const documentCreateSchema = z.object({
  code, title, docType: z.enum(DOCUMENT_TYPES),
  reviewPeriodMonths: z.number().int().min(1).max(120).optional(),
  changeSummary: z.string().trim().max(2000).optional(),
}).strict();

export const documentReviseSchema = z.object({}).strict();

export const versionUpdateSchema = z.object({
  title: title.optional(),
  changeSummary: z.string().trim().max(2000).optional(),
  expectedVersion,
}).strict();

export const versionFileQuerySchema = z.object({
  fileName: z.string().trim().min(1, 'fileName is required.').max(255)
    .refine(n => !/[\\/\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..', 'fileName must be a plain file name (no folder, no control character).'),
  expectedVersion: z.coerce.number().int().min(1),
}).strict();

/** A signed step: submit (authorship), review, approve, effective. A reason is optional unless the meaning requires one. */
export const versionSignSchema = z.object({ ...credentials, reason: z.string().trim().max(1000).optional(), expectedVersion }).strict();
/** Obsolete: the meaning requires a reason. */
export const versionObsoleteSchema = z.object({ ...credentials, reason, expectedVersion }).strict();
export const versionReturnSchema = z.object({ reason, expectedVersion }).strict();
export const versionPrintSchema = z.object({
  purpose: z.string().trim().min(3, 'Say what the copy is for (at least 3 characters).').max(300),
  recipient: z.string().trim().max(200).optional(),
}).strict();

// ---- training -----------------------------------------------------------------------------------------------------------------

const roles = z.array(z.enum(ROLE_NAMES)).max(ROLE_NAMES.length).refine(r => new Set(r).size === r.length, 'A role is listed twice.');
const documentIds = z.array(z.string().trim().min(1).max(100)).max(200).refine(d => new Set(d).size === d.length, 'A document is listed twice.');

export const curriculumCreateSchema = z.object({
  code, title,
  description: z.string().trim().max(2000).optional(),
  methodCode: z.string().trim().min(1).max(100).nullable().optional(),
  roles: roles.optional(),
  mandatory: z.boolean().optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  trainingMethod: z.enum(TRAINING_METHODS),
  documentIds: documentIds.optional(),
}).strict();

export const curriculumUpdateSchema = z.object({
  title: title.optional(),
  description: z.string().trim().max(2000).optional(),
  methodCode: z.string().trim().min(1).max(100).nullable().optional(),
  roles: roles.optional(),
  mandatory: z.boolean().optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  trainingMethod: z.enum(TRAINING_METHODS).optional(),
  documentIds: documentIds.optional(),
  expectedVersion,
}).strict();

export const assignmentCreateSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  curriculumId: z.string().trim().min(1).max(100),
  documentId: z.string().trim().min(1).max(100).optional(),
  dueDate: day,
}).strict();

/** Read and understood (the trainee) and on-the-job certification (the trainer). */
export const assignmentSignSchema = z.object({ ...credentials, reason: z.string().trim().max(1000).optional(), expectedVersion }).strict();

export const OVERRIDE_MAX_DAYS = 30;
export const overrideSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  methodCode: z.string().trim().min(1).max(100),
  validUntil: day,
  reason,
  ...credentials,
}).strict();
export const overrideRevokeSchema = z.object({ reason, expectedVersion }).strict();

/** POST /training/:userId/certify: the module certified, signed TRAINING_CERTIFICATION. */
export const certifySchema = z.object({
  moduleName: z.string().trim().min(2, 'Module name is required.').max(120),
  ...credentials,
}).strict();
