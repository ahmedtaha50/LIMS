import type { NextFunction, Request, RequestHandler, Response } from 'express';

const WRAPPED = Symbol('asyncHandler');

/** True for functions returned by asyncHandler (used by the route-table test to catch routes built on a bare express.Router). */
export const isAsyncWrapped = (fn: unknown): boolean => typeof fn === 'function' && (fn as any)[WRAPPED] === true;

/**
 * Express 4 does not forward a rejected promise from an async handler to the error middleware: the rejection
 * goes unhandled and Node exits. This wrapper forwards both rejections and synchronous throws to next(err).
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  if ((fn as any)[WRAPPED]) return fn;
  const wrapped = function (req: Request, res: Response, next: NextFunction) {
    try {
      const out: unknown = fn(req, res, next);
      if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).then(undefined, next);
    } catch (err) {
      next(err);
    }
  };
  // The route table recognises requireAuth by function name, so the wrapper keeps it.
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  (wrapped as any)[WRAPPED] = true;
  return wrapped;
}
