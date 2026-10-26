import express, { type RequestHandler, type Router } from 'express';
import { asyncHandler } from './asyncHandler';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

function wrapAll(handlers: unknown[]): unknown[] {
  return handlers.map(h => {
    if (Array.isArray(h)) return wrapAll(h);
    // length 4 = error-handling middleware; routers passed to use() are not touched here at all.
    return typeof h === 'function' && h.length !== 4 ? asyncHandler(h as RequestHandler) : h;
  });
}

/**
 * express.Router() whose route handlers are all wrapped by asyncHandler. Every route module uses this instead of
 * express.Router(), so an async handler cannot forget its own try/catch and take the server down.
 */
export function createRouter(): Router {
  const router = express.Router();
  for (const verb of VERBS) {
    const original = (router as any)[verb].bind(router);
    (router as any)[verb] = (path: unknown, ...handlers: unknown[]) => original(path, ...wrapAll(handlers));
  }
  return router;
}
