/**
 * Errors of /api/v1 as RFC 9457 problem details (application/problem+json):
 *
 *   { type, title, status, detail, instance, code, requestId, errors? }
 *
 * `code` is the same stable machine code the rest of the API uses (VALIDATION_FAILED, CONFLICT, ...); `type` points at the code's entry
 * on the local docs page; `errors` lists what was wrong, each with a JSON pointer into the request (`/items/3/value`) and, for a batch,
 * the index of the refused item. Unexpected errors are logged with the request id and answered with a generic text: no SQL, no stack.
 */
import type { ErrorRequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { log, serializeError } from '../core/logger';
import { AppError } from '../http/errors';

export interface ProblemItem { pointer: string; detail: string; index?: number; code?: string }

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  413: 'Content Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 423: 'Locked', 429: 'Too Many Requests', 500: 'Internal Server Error',
};

export const problemType = (code: string) => `/api/v1/docs/#problem-${code.toLowerCase().replace(/_/g, '-')}`;

/** The problem codes the API answers, for the docs page and the OpenAPI document. */
export const PROBLEM_CODES: Record<string, string> = {
  UNAUTHORIZED: 'No bearer token was sent.',
  INVALID_TOKEN: 'The bearer token is not an API token of this system.',
  TOKEN_REVOKED: 'The API client was revoked.',
  TOKEN_EXPIRED: 'The API token has passed its expiry date.',
  SERVICE_ACCOUNT_INACTIVE: 'The service account of the client was deactivated.',
  INSUFFICIENT_SCOPE: 'The token does not hold the scope the operation needs.',
  VALIDATION_FAILED: 'The request does not match the schema (unknown keys are refused).',
  INVALID_JSON: 'The body is not valid JSON.',
  IDEMPOTENCY_KEY_REQUIRED: 'A write needs an Idempotency-Key header.',
  IDEMPOTENCY_KEY_REUSED: 'The Idempotency-Key was already used for a different request.',
  ITEM_REFUSED: 'An item of a batch was refused; nothing of the batch was written.',
  RESULT_ALREADY_ENTERED: 'The result already has a value; a correction is made by a person.',
  CONFLICT: 'The record was changed since it was read (expectedVersion).',
  NOT_FOUND: 'No such route or record.',
  METHOD_NOT_ALLOWED: 'The route exists but not with this method.',
  PAYLOAD_TOO_LARGE: 'The body is larger than the API accepts (2 MB).',
  UNSUPPORTED_MEDIA_TYPE: 'A write must send application/json.',
  INTERNAL_ERROR: 'Unexpected error; quote the requestId to the administrator.',
};

export class ProblemError extends AppError {
  constructor(status: number, code: string, detail: string, readonly errors?: ProblemItem[], readonly headers?: Record<string, string>) {
    super(status, code, detail, errors);
  }
}

interface Problem {
  type: string; title: string; status: number; detail: string; instance: string; code: string; requestId: string; errors?: ProblemItem[];
}

/** Pointer of a Zod issue path: ['items', 3, 'value'] -> /items/3/value. */
export const pointerOf = (path: ReadonlyArray<PropertyKey>, root = ''): string =>
  root + path.map(p => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

export function zodProblem(err: ZodError, root = ''): ProblemError {
  const errors = err.issues.map(i => ({ pointer: pointerOf(i.path, root), detail: i.message }));
  return new ProblemError(400, 'VALIDATION_FAILED', errors.map(e => `${e.pointer || '/'}: ${e.detail}`).join('; '), errors);
}

function toProblem(err: any, instance: string, requestId: string): { problem: Problem; headers?: Record<string, string>; expose: boolean } {
  let status = 500, code = 'INTERNAL_ERROR', detail = 'Internal server error. Quote the request id to your administrator.';
  let errors: ProblemItem[] | undefined;
  let headers: Record<string, string> | undefined;
  let expose = false;
  if (err instanceof ZodError) err = zodProblem(err);
  if (err instanceof ProblemError) { ({ status, code } = err); detail = err.message; errors = err.errors; headers = err.headers; expose = true; }
  else if (err instanceof AppError) {
    ({ status, code } = err); detail = err.message; expose = status < 500;
    if (Array.isArray(err.details)) {
      errors = err.details.map((d: any) => (typeof d === 'string' ? { pointer: '', detail: d } : { pointer: d.path ? pointerOf(String(d.path).split('.')) : '', detail: String(d.message ?? d) }));
    }
  } else if (err?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; detail = 'The request body is not valid JSON.'; expose = true; }
  else if (err?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; detail = 'The request body is too large.'; expose = true; }
  else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) { status = err.status; code = 'BAD_REQUEST'; detail = err.message; expose = true; }
  if (!expose) { status = status >= 500 ? status : 500; detail = 'Internal server error. Quote the request id to your administrator.'; errors = undefined; }
  return {
    problem: { type: problemType(code), title: TITLES[status] ?? 'Error', status, detail, instance, code, requestId, ...(errors?.length ? { errors } : {}) },
    headers, expose,
  };
}

export function sendProblem(res: Response, problem: Problem, headers?: Record<string, string>) {
  for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
  res.status(problem.status).type('application/problem+json').send(JSON.stringify(problem));
}

/** The last middleware of /api/v1. */
export const problemErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const { problem, headers, expose } = toProblem(err, req.originalUrl.split('?')[0], req.id);
  if (!expose) log.error({ requestId: req.id, method: req.method, path: req.path, err: serializeError(err) }, 'unhandled error in /api/v1');
  sendProblem(res, problem, headers);
};
