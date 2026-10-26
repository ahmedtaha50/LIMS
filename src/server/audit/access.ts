import type { RequestHandler } from 'express';
import { ForbiddenError } from '../http/errors';

/** Role gate for a route that already ran requireAuth. The actor is req.user, set from the bearer token, never from the request. */
export const requireRoles = (...roles: string[]): RequestHandler => (req, _res, next) => {
  const user = (req as any).user;
  if (!user || !roles.includes(user.role)) return next(new ForbiddenError(`Forbidden: restricted to ${roles.join(', ')}.`));
  next();
};

/**
 * Records whose history a Reviewer may not read: user accounts, system settings, backups, migrations and the audit trail itself.
 * A Reviewer reviews GxP data records; the administration of the system is for Admin and QA. (Conservative default, to be
 * replaced by a permission code when the permission matrix lands.)
 */
export const REVIEWER_BLOCKED_ENTITIES: ReadonlySet<string> = new Set(['User', 'SystemSettings', 'System', 'SYSTEM_MIGRATION', 'AuditTrail']);
