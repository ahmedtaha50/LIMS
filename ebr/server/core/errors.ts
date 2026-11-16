import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

/** An error the client may see: status, a stable code, a message, and optional details (never a stack). */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const forbidden = (message = 'You do not have the permission for this action.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
/** Optimistic concurrency: the record changed since the client read it. */
export const conflict = (message = 'The record was changed by someone else. Reload it and try again.') => new HttpError(409, 'conflict', message);

export type Problem = { status: number; code: string; message: string; requestId: string; details?: unknown };

export const notFoundHandler: RequestHandler = (req, _res, next) => next(new HttpError(404, 'not_found', `No route ${req.method} ${req.originalUrl.split("?")[0]}.`));

/** Every failure leaves as JSON with its cause; an unexpected error is logged with the request id and shown without internals. */
export function errorHandler(log: (line: string) => void): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = String(res.locals.requestId ?? '');
    let p: Problem;
    if (err instanceof HttpError) p = { status: err.status, code: err.code, message: err.message, requestId, ...(err.details === undefined ? {} : { details: err.details }) };
    else if (err instanceof z.ZodError) p = { status: 400, code: 'invalid_input', message: 'The input is not valid.', requestId, details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) };
    else if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') p = { status: 400, code: 'invalid_json', message: 'The body is not valid JSON.', requestId };
    else if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') p = { status: 413, code: 'too_large', message: 'The body is too large.', requestId };
    else {
      log(`[${requestId}] ${req.method} ${req.path} failed: ${err instanceof Error ? err.stack : String(err)}`);
      p = { status: 500, code: 'internal', message: 'The server could not complete the request. Nothing was saved. Give this reference to support: ' + requestId, requestId };
    }
    res.status(p.status).json(p);
  };
}
