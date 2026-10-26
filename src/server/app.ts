/**
 * The Express application, assembled from parts so a test can build exactly what production runs:
 *   request id -> security headers -> JSON/cookies -> audit context -> credential type guard -> API routes -> API 404 -> error handler.
 * Listening, Socket.IO, the database bootstrap and the frontend are server.ts's business, not this function's.
 */
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { auditContext } from './audit/context';
import { assertRouteContract, authorize } from './authz';
import type { Db, IoLike } from './core/context';
import { createRequireAuth } from './core/auth';
import { errorHandler, notFoundHandler, requestContext } from './http/errors';
import { applySecurity } from './http/security';
import { requireStringCredentials } from './http/validate';
import { archivedRecordGuard } from './archive';
import { moduleQualificationGuard } from './qualified';
import { createApiRouter } from './routes';
import { mountApiV1 } from './v1';

export interface AppDeps {
  db: Db;
  /** Socket.IO server; handlers reach it as req.io. */
  io?: IoLike;
  /** Pass false in tests (see http/security.ts). */
  rateLimit?: boolean;
}

export function createApp({ db, io, rateLimit }: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1); // Trust the first proxy to resolve express-rate-limit X-Forwarded-For warnings

  app.use(requestContext());
  app.use((req, _res, next) => { (req as any).io = io; next(); });
  applySecurity(app, { rateLimit });
  // The machine integration API (r2-api-v1): /api/v1 with API tokens, scopes, its own route registry and problem+json, ahead of the
  // session API's body parser and authorisation layer; and API tokens refused everywhere else in /api (they never reach a signing route).
  mountApiV1(app, { db });
  app.use(express.json());
  app.use(cookieParser());
  // Opens the per-request audit context (r1-audit) that requireAuth (r1-identity) fills with the session id and writeAudit reads.
  // It must come after the body parser: a context opened before the body is read is lost when the parser's stream callbacks run.
  app.use('/api', auditContext);
  app.use('/api', requireStringCredentials);

  // One table says who may call what (src/server/authz/routeTable.ts); it runs in front of every route module.
  app.use('/api', authorize({ db }));
  // The validated-scope register (r2-validation): writes to a module that QA declared NotQualified are refused (403 MODULE_NOT_QUALIFIED).
  app.use('/api', moduleQualificationGuard(db));
  // Archived records (r3-periodic-archive): a write to a record in an accepted archive bundle is refused (423 ARCHIVED_RECORD).
  app.use('/api', archivedRecordGuard(db));
  app.use('/api', createApiRouter({ db, requireAuth: createRequireAuth(db) }));
  app.use('/api', notFoundHandler);

  app.use(errorHandler());
  // Deny by default: a route without a rule in the table stops the application from starting.
  assertRouteContract(app);
  return app;
}
