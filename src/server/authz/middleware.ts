/**
 * The authorisation layer (roadmap M09). Mounted once, in front of every route module (src/server/app.ts), so the route files
 * need no edits and cannot forget a check. For each request to /api:
 *
 *   1. find the rule of "METHOD /path" in the route table (./routeTable.ts); no rule, no route: 404, the handler is never reached;
 *   2. `public` and `self` rules: check the body keys and pass on (a self-service route authenticates itself);
 *   3. `perm` rules: authenticate (the same check as every route: session, idle, password change), then
 *        the role must hold the permission                     403 PERMISSION_DENIED, recorded as AUTHZ_DENIED
 *        the body may carry only the keys the route accepts    400
 *        the record's state must allow the action              423 / 409
 *        the signer must be independent of the record          403 SOD_VIOLATION, recorded as AUTHZ_DENIED
 *        the rule's own guard                                   whatever it throws
 *
 * The handler then runs with req.user set, and keeps its own checks (defence in depth; their messages are unchanged).
 * The permission lookup is one indexed query per request.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { Db } from '../core/context';
import { asyncHandler } from '../core/asyncHandler';
import { createRequireAuth } from '../auth/requireAuth';
import type { UserRow } from '../auth/sessions';
import { AppError, NotFoundError, ValidationError } from '../http/errors';
import { permissionsRoutes } from '../routes/permissions';
import { recordDenied } from './denied';
import { permissionsOfRole } from './grants';
import { matchRule } from './match';
import { assertIndependentOfRecord, SodViolationError } from './sod';
import { applyStateGuard } from './stateGuard';
import type { BodySpec } from './types';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const keysOfSpec = new WeakMap<object, ReadonlySet<string>>();
function allowedKeys(spec: BodySpec): ReadonlySet<string> {
  const cached = keysOfSpec.get(spec as object);
  if (cached) return cached;
  const keys = new Set(Array.isArray(spec) ? (spec as readonly string[]) : Object.keys((spec as { shape: object }).shape));
  keysOfSpec.set(spec as object, keys);
  return keys;
}

/** 400 for a body that is not an object or carries a key the route does not accept. Types and values are the route's own validation. */
export function checkBodyKeys(req: Request, spec: BodySpec | undefined): void {
  if (!spec || !MUTATING.has(req.method)) return;
  const body = req.body;
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('The request body must be a JSON object.', [{ path: '', message: 'The request body must be a JSON object.' }]);
  }
  const allowed = allowedKeys(spec);
  const unknown = Object.keys(body).filter(k => !allowed.has(k));
  if (unknown.length === 0) return;
  const message = unknown.length === 1 ? `Unrecognized key: "${unknown[0]}"` : `Unrecognized keys: ${unknown.map(k => `"${k}"`).join(', ')}`;
  throw new ValidationError(message, unknown.map(k => ({ path: k, message: `Unrecognized key: "${k}"` })));
}

export function authorize({ db }: { db: Db }): Router {
  const router = Router();
  const authenticate = createRequireAuth(db);

  const authenticateRequest = (req: Request, res: any) => new Promise<void>((resolve, reject) => {
    authenticate(req, res, err => (err ? reject(err) : resolve()));
  });

  router.use(asyncHandler(async function authorizeRequest(req, res, next) {
    const hit = matchRule(req.method, req.path);
    if (!hit) throw new NotFoundError(`No such API route: ${req.method} ${req.originalUrl.split('?')[0]}`);
    const { rule, route, params } = hit;

    if (rule.kind !== 'perm') {
      checkBodyKeys(req, rule.body);
      return next();
    }

    await authenticateRequest(req, res);
    const user: UserRow = (req as any).user;

    const granted = await permissionsOfRole(db, user.role);
    if (!granted.includes(rule.permission)) {
      await recordDenied(db, req, user, { permission: rule.permission, route, reason: 'the role does not hold the permission' });
      throw new AppError(403, 'PERMISSION_DENIED',
        `Forbidden: the ${user.role} role does not hold the permission "${rule.permission}" that this action needs.`, { permission: rule.permission });
    }

    checkBodyKeys(req, rule.body);
    if (rule.state) await applyStateGuard(db, rule.state, params);
    if (rule.sod) {
      try {
        await assertIndependentOfRecord(db, rule.sod.rule, params[rule.sod.param], user.id);
      } catch (e) {
        if (e instanceof SodViolationError) await recordDenied(db, req, user, { route, ...(e.details as object) });
        throw e;
      }
    }
    if (rule.guard) await rule.guard({ db, req, user, params, body: (req.body ?? {}) as Record<string, unknown> });
    next();
  }));

  router.use(permissionsRoutes({ db, requireAuth: authenticate }));
  return router;
}
