// Request fields of every signing route and the parameters of the signature read routes (roadmap M07). Strict. Owned by r1-esign.
import { z } from 'zod';

/**
 * The fields a client sends to sign. A route that signs spreads these into its own strict schema:
 *
 *   z.object({ ...signatureFields, expectedVersion: z.number().int().min(1) }).strict()
 *
 * The client names a meaning by its catalog code and nothing else about it: a `meaning` text in the body is an unknown key and
 * the request is refused. The signer is req.user, never a field.
 */
export const signatureFields = {
  meaningCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'meaningCode must be a code from the signature meaning catalog.'),
  password: z.string().min(1, 'Your password is required to sign.').max(1024),
  totpCode: z.string().regex(/^\d{6}$/, 'The authenticator code has 6 digits.').optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
};

/** GET /signatures/entity/:type/:id */
export const entityParamsSchema = z.object({
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,63}$/, 'Record type is not valid.'),
  id: z.string().min(1, 'Record id is required.').max(200),
}).strict();

/** GET /signatures/verify/:id */
export const signatureIdParamsSchema = z.object({ id: z.string().min(1).max(200) }).strict();
