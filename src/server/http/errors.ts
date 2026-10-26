/**
 * One error vocabulary and one JSON error shape for the whole API:
 *   { error: <human message>, code: <stable machine code>, requestId, details? }
 * `error` stays a plain string because the existing UI shows it as is.
 * Unexpected errors are logged with the request id and answered with a generic message: no SQL text,
 * no stack, no parameters ever reach the client (21 CFR 11.10(d), OWASP error handling).
 */
import { randomUUID } from 'crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { log as defaultLog, serializeError, type Logger } from '../core/logger';

declare module 'express-serve-static-core' {
  interface Request { id: string }
}

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request.', details?: unknown) { super(400, 'BAD_REQUEST', message, details); }
}
export class ValidationError extends AppError {
  constructor(message: string, details?: Array<{ path: string; message: string }>) { super(400, 'VALIDATION_FAILED', message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.') { super(401, 'UNAUTHORIZED', message); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden: insufficient privileges.') { super(403, 'FORBIDDEN', message); }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found.') { super(404, 'NOT_FOUND', message); }
}
/** The word "Conflict" is kept in the default text because legacy handlers pick 409 by looking for it. */
export class ConflictError extends AppError {
  constructor(message = 'Conflict: the record was modified by another user. Refresh and review the current state.') { super(409, 'CONFLICT', message); }
}

/** Drizzle prefixes every failed query message with the SQL and its parameters. */
const SQL_TEXT = /Failed query:/;

/**
 * First middleware of the app: gives every request an id (header X-Request-Id, req.id) and, for every
 * error body that leaves through res.json, adds that id and withholds SQL text some legacy handler copied in.
 */
export function requestContext(log: Logger = defaultLog): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Request-Id', req.id);

    const json = res.json.bind(res);
    res.json = (body?: any) => {
      if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string' && res.statusCode >= 400) {
        if (SQL_TEXT.test(body.error)) {
          log.error({ requestId: req.id, status: res.statusCode, detail: body.error }, 'database error withheld from response');
          body = { error: 'The database rejected the operation. Quote the request id to your administrator.', code: 'DATABASE_ERROR' };
        }
        body = { ...body, requestId: req.id };
      }
      return json(body);
    };
    next();
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No such API route: ${req.method} ${req.originalUrl.split('?')[0]}`));
};

function toAppError(err: any): { app: AppError; expose: boolean } {
  if (err instanceof AppError) return { app: err, expose: err.status < 500 };
  if (err instanceof ZodError) {
    const details = err.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    return { app: new ValidationError(details.map(d => d.message).join(', '), details), expose: true };
  }
  if (err?.type === 'entity.parse.failed') return { app: new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.'), expose: true };
  if (err?.type === 'entity.too.large') return { app: new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'), expose: true };
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) {
    return { app: new AppError(err.status, 'BAD_REQUEST', err.message), expose: true };
  }
  return { app: new AppError(500, 'INTERNAL_ERROR', 'Internal server error'), expose: false };
}

/** Last middleware of the app. */
export function errorHandler(log: Logger = defaultLog): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      log.error({ requestId: req.id, method: req.method, path: req.path, err: serializeError(err) }, 'error after the response had started');
      return next(err);
    }
    const { app, expose } = toAppError(err);
    if (app.status >= 500) {
      log.error({ requestId: req.id, method: req.method, path: req.path, err: serializeError(err) }, 'unhandled error');
    }
    res.status(app.status).json({
      error: expose ? app.message : 'Internal server error',
      code: app.code,
      requestId: req.id,
      ...(expose && app.details ? { details: app.details } : {}),
    });
  };
}
