import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from './errors';

/**
 * Strict input validation as middleware. Use a `.strict()` schema without server-controlled fields
 * (id, status, version, signatures, ...): unknown keys then fail with 400 instead of being ignored (AGENTS.md section 3).
 * On success the parsed value replaces req.body / req.query / req.params, so the handler only sees validated data.
 * The message is the issue texts joined with ", " (what the UI already displays); `details` carries path and text.
 */
export function validate(schema: ZodType, source: 'body' | 'query' | 'params' = 'body'): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source] ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
      return next(new ValidationError(details.map(d => d.message).join(', '), details));
    }
    (req as any)[source] = parsed.data;
    next();
  };
}

/**
 * Request fields that carry a secret and are fed to scrypt, bcrypt or jwt. A non-string value (number, object,
 * array, null) made those calls throw outside any try/catch and killed the process. Checked once for every route
 * so no handler, present or future, can forget it; handlers with a schema still validate length and content.
 */
export const CREDENTIAL_FIELDS = ['password', 'newPassword', 'currentPassword', 'passphrase', 'tempToken'] as const;

export const requireStringCredentials: RequestHandler = (req, _res, next) => {
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const field of CREDENTIAL_FIELDS) {
      if (field in body && typeof body[field] !== 'string') {
        return next(new ValidationError(`${field} must be a string.`, [{ path: field, message: `${field} must be a string.` }]));
      }
    }
  }
  next();
};
