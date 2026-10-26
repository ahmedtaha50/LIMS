/**
 * /api/v1: the machine integration API (roadmap M22). Wired into the application by ONE call in src/server/app.ts, right after the
 * security middleware and before the session API's body parser and authorisation layer:
 *
 *   mountApiV1(app, { db });
 *
 * which mounts
 *   /api/v1   its own JSON parser (2 MB, for batches of 500), the dispatcher over the route registry (./registry.ts) and a problem+json
 *             error handler. Every request to /api/v1 ends here: unknown routes are a 404 problem, so nothing reaches the session API.
 *   /api      refuseApiTokensOutsideV1: an API token anywhere else in the API is a 403 (and never reaches a signing route).
 *
 * For each request the dispatcher: finds the operation (404, or 405 with Allow); for a protected one, authenticates the API token
 * (401: missing, unknown, revoked, expired, inactive service account) and checks the scope (403 INSUFFICIENT_SCOPE, recorded as
 * AUTHZ_DENIED); validates path parameters, query and body with the operation's strict schemas (400 with a JSON pointer per error);
 * reads the Idempotency-Key of a write (400 when missing); and runs the handler. The actor of every write is the client's own service
 * account (req.user is never consulted and no client-supplied identity is read).
 *
 * The session API's route table (src/server/authz/routeTable.ts) does not govern /api/v1: its rules are permissions of people's roles.
 * The deny-by-default table of /api/v1 is its route registry, in which every operation names its scope.
 */
import express, { type Express, type Request, type Response } from 'express';
import type { Db, IoLike } from '../core/context';
import { asyncHandler } from '../core/asyncHandler';
import { authenticateApiToken, bearerOf, looksLikeApiToken, refuseApiTokensOutsideV1 } from '../auth/principals/apiToken';
import { recordSecurityEvent, securityEventContext } from '../auth/events';
import { DOCS_CONTENT_TYPES, docsFiles } from './docsSite';
import { readIdempotencyKey } from './idempotency';
import { buildOpenApiDocument } from './openapi';
import { ProblemError, problemErrorHandler, zodProblem } from './problem';
import { v1Routes, type CompiledRoute, type V1Answer } from './registry';
import type { ZodType } from 'zod';

export { buildOpenApiDocument } from './openapi';

const JSON_LIMIT = '2mb';

function parse<T>(schema: ZodType | undefined, value: unknown, root: string): T {
  if (!schema) return {} as T;
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw zodProblem(parsed.error, root);
  return parsed.data as T;
}

function send(res: Response, answer: V1Answer) {
  for (const [k, v] of Object.entries(answer.headers ?? {})) res.setHeader(k, v);
  res.status(answer.status).type('application/json').send(answer.text ?? JSON.stringify(answer.body ?? null));
}

let docsCache: Record<string, string> | null = null;
const docs = () => (docsCache ??= docsFiles(buildOpenApiDocument()));

function serveDocs(req: Request, res: Response): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.path === '/docs') { res.redirect(301, '/api/v1/docs/'); return true; }
  const m = /^\/docs\/(index\.html|docs\.js|docs\.css|openapi\.js)?$/.exec(req.path);
  if (!m) return false;
  const name = m[1] ?? 'index.html';
  res.status(200).type(DOCS_CONTENT_TYPES[name]).send(docs()[name]);
  return true;
}

function match(req: Request): { hit: CompiledRoute; params: Record<string, string> } | { allow: string[] } | null {
  const allow: string[] = [];
  for (const c of v1Routes()) {
    const m = c.regex.exec(req.path);
    if (!m) continue;
    if (c.route.method !== req.method) { allow.push(c.route.method); continue; }
    let params: Record<string, string>;
    try { params = Object.fromEntries(c.paramNames.map((n, i) => [n, decodeURIComponent(m[i + 1])])); } catch {
      throw new ProblemError(400, 'VALIDATION_FAILED', 'A path parameter is not valid URL encoding.');
    }
    return { hit: c, params };
  }
  return allow.length ? { allow } : null;
}

export function createApiV1Router({ db }: { db: Db }) {
  const router = express.Router();
  router.use(express.json({ limit: JSON_LIMIT }));
  router.use(asyncHandler(async function dispatchV1(req, res) {
    if (serveDocs(req, res)) return;
    const found = match(req);
    if (!found) throw new ProblemError(404, 'NOT_FOUND', `No such operation: ${req.method} /api/v1${req.path}. The operations are listed at /api/v1/docs/.`);
    if ('allow' in found) {
      throw new ProblemError(405, 'METHOD_NOT_ALLOWED', `${req.path} does not accept ${req.method}; it accepts ${found.allow.join(', ')}.`, undefined, { Allow: found.allow.join(', ') });
    }
    const { route } = found.hit;
    const io = (req as any).io as IoLike | undefined;
    const base = { db, io, req, res, idempotencyKey: '' };

    if (route.public) {
      const params = parse(route.params, found.params, '');
      const query = parse(route.query, req.query, '');
      return send(res, await route.handler({ ...base, params, query, body: undefined }));
    }

    const token = bearerOf(req.headers.authorization);
    if (!token) throw new ProblemError(401, 'UNAUTHORIZED', 'An API token is required: Authorization: Bearer <token>.', undefined, { 'WWW-Authenticate': 'Bearer realm="lims-api-v1"' });
    if (!looksLikeApiToken(token)) {
      throw new ProblemError(401, 'INVALID_TOKEN', '/api/v1 accepts API tokens only (issued on the API clients screen), not a sign-in session.', undefined,
        { 'WWW-Authenticate': 'Bearer realm="lims-api-v1", error="invalid_token"' });
    }
    const context = securityEventContext(req);
    let principal;
    try { principal = await authenticateApiToken(db, token, context); } catch (err: any) {
      throw new ProblemError(err.status ?? 401, err.code ?? 'INVALID_TOKEN', err.message, undefined, { 'WWW-Authenticate': 'Bearer realm="lims-api-v1", error="invalid_token"' });
    }
    const { client, user } = principal;
    if (!client.scopes.includes(route.scope)) {
      await recordSecurityEvent(db, {
        type: 'AUTHZ_DENIED', outcome: 'denied', actorId: user.id, actorRole: user.role, ...context,
        detail: { method: req.method, path: req.path, clientId: client.id, scope: route.scope, reason: 'the API token does not hold the scope' },
      });
      throw new ProblemError(403, 'INSUFFICIENT_SCOPE', `Forbidden: ${route.operationId} needs the scope "${route.scope}"; this token holds ${client.scopes.join(', ') || 'none'}.`,
        undefined, { 'WWW-Authenticate': `Bearer realm="lims-api-v1", error="insufficient_scope", scope="${route.scope}"` });
    }

    const params = parse(route.params, found.params, '');
    const query = parse(route.query, req.query, '');
    let body: unknown;
    if (route.body) {
      if (!req.is('application/json')) throw new ProblemError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The body must be application/json.');
      body = parse(route.body, req.body, '');
    }
    const idempotencyKey = route.idempotent ? readIdempotencyKey(req.get('idempotency-key')) : '';
    send(res, await route.handler({ ...base, client, user, params, query, body, idempotencyKey }));
  }));
  router.use(problemErrorHandler);
  return router;
}

/** The one line src/server/app.ts needs (see the header). */
export function mountApiV1(app: Express, { db }: { db: Db }) {
  app.use('/api/v1', createApiV1Router({ db }));
  app.use('/api', refuseApiTokensOutsideV1(db));
}
