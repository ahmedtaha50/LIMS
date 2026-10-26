// Request bodies of the authentication routes (roadmap M05). Strict: an unknown key is a 400. Owned by r1-identity.
import { z } from 'zod';

const password = z.string().min(1, 'Password is required.').max(1024, 'Password is too long.');
export const totpCode = z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.');
const recoveryCode = z.string().trim().min(8, 'Recovery code is too short.').max(32, 'Recovery code is too long.');
const challengeToken = z.string().min(10).max(4096);

export const loginSchema = z.object({
  email: z.string().trim().min(3, 'Email is required.').max(254),
  password,
}).strict();

export const totpVerifySchema = z.object({
  tempToken: challengeToken,
  code: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
}).strict().refine(v => (v.code === undefined) !== (v.recoveryCode === undefined), 'Send either the authenticator code or a recovery code.');

export const totpSetupSchema = z.object({ tempToken: challengeToken, code: totpCode }).strict();

export const reauthSchema = z.object({
  password,
  code: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
}).strict().refine(v => v.code === undefined || v.recoveryCode === undefined, 'Send either the authenticator code or a recovery code, not both.');

export const changePasswordSchema = z.object({ currentPassword: password, newPassword: password }).strict();

/** Enrolment start and recovery-code regeneration: the user re-enters their password. */
export const passwordOnlySchema = z.object({ password }).strict();

export const totpConfirmSchema = z.object({ code: totpCode }).strict();
