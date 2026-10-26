// Request bodies of the administration routes (roadmap M05, M16). Strict; the administrator's own password is re-entered for every change. Owned by r1-identity.
import { z } from 'zod';

export const USER_ROLES = ['Admin', 'QA', 'Reviewer', 'Analyst'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const password = z.string().min(1, 'Your password is required to authorise this change.').max(1024);
const reason = z.string().trim().min(3, 'A reason is required (minimum 3 characters).').max(500, 'The reason is too long (maximum 500 characters).');
const expectedVersion = z.number({ error: 'expectedVersion is required.' }).int().min(1);

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Name is required.').max(120),
  email: z.string().trim().toLowerCase().pipe(z.email('A valid e-mail address is required.').max(254)),
  role: z.enum(USER_ROLES),
  reason,
  password,
}).strict();

export const updateUserSchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  active: z.boolean().optional(),
  reason,
  expectedVersion,
  password,
}).strict().refine(v => v.role !== undefined || v.active !== undefined, 'Nothing to change: send a role or an active flag.');

/** Reset password, unlock, reset MFA. */
export const userActionSchema = z.object({ reason, expectedVersion, password }).strict();

export const settingsUpdateSchema = z.object({
  sessionTimeoutMinutes: z.number().int().min(5).max(120),
  maxFailedLogins: z.number().int().min(1).max(10),
  passwordExpiryDays: z.number().int().min(14).max(365),
  minPasswordLength: z.number().int().min(8).max(64),
  requireUppercase: z.boolean(),
  requireNumbers: z.boolean(),
  requireSymbols: z.boolean(),
  passwordHistoryCount: z.number().int().min(0).max(24),
  lockoutMinutes: z.number().int().min(1).max(1440),
  mfaRequired: z.boolean(),
  sessionAbsoluteHours: z.number().int().min(1).max(12),
  reason,
  expectedVersion,
  password,
}).strict();

export const broadcastSchema = z.object({ message: z.string().trim().min(1, 'Message is required.').max(500) }).strict();

export const aiIntegrationSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().min(20, 'The API key looks too short.').max(512).optional(),
  model: z.string().trim().min(3).max(100).optional(),
  redactIdentifiers: z.boolean().optional(),
  reason,
  expectedVersion,
  password,
}).strict();
