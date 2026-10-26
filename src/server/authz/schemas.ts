// Request bodies of the /permissions routes (roadmap M09). Strict: an unknown key is a 400. The signer re-enters their password,
// which is the e-signature; the meaning of each signature is fixed by the server (roleChange.ts), not chosen by the client.
import { z } from 'zod';
import { ROLE_NAMES } from '../../lib/permissions';

const password = z.string().min(1, 'Your password is required to sign.').max(1024);
const reason = z.string().trim().min(3, 'A reason is required (minimum 3 characters).').max(500, 'The reason is too long (maximum 500 characters).');
const version = (what: string) => z.number({ error: `${what} is required.` }).int().min(1);

export const requestRoleChangeSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required.').max(100),
  role: z.enum(ROLE_NAMES),
  reason,
  expectedVersion: version('expectedVersion (the user version you saw)'),
  password,
}).strict();

/** Approve (reason optional) and reject (reason required, checked by the service). expectedVersion is the version of the request. */
export const decideRoleChangeSchema = z.object({
  password,
  reason: reason.optional(),
  expectedVersion: version('expectedVersion (the request version you saw)'),
}).strict();

export const withdrawRoleChangeSchema = z.object({
  reason,
  expectedVersion: version('expectedVersion (the request version you saw)'),
}).strict();
