import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Pool } from './core/db.js';
import { HttpError, errorHandler, notFoundHandler } from './core/errors.js';
import type { Authorizer, RouteDef } from './core/route.js';

export type AppOptions = { pool: Pool; routes: readonly RouteDef[]; authorize?: Authorizer; log?: (line: string) => void };

/** Until r1-identity installs an authorizer, only public routes run: the system fails closed. */
const denyAll: Authorizer = async () => null;

export function createApp({ pool, routes, authorize = denyAll, log = (l) => console.error(l) }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader('X-Request-Id', res.locals.requestId); next(); });
  app.use(express.json({ limit: '1mb', strict: true }));

  for (const r of routes) {
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        let actor = null;
        if (r.permission !== 'public') {
          actor = await authorize(req, r.permission);
          if (!actor) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
          if (!actor.permissions.has(r.permission)) throw new HttpError(403, 'forbidden', 'You do not have the permission for this action.');
        }
        const input = r.input ? r.input.parse(req.method === 'GET' ? req.query : req.body ?? {}) : undefined;
        const out = await r.handler({ input, params: req.params as Record<string, string>, query: req.query as Record<string, unknown>, pool, actor, req, res });
        if (!res.headersSent) res.status(r.status ?? (out === undefined ? 204 : 200)).json(out);
      } catch (e) { next(e); }
    };
    app[r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](r.path, handler);
  }
  app.use('/api', notFoundHandler);
  app.use(errorHandler(log));
  return app;
}
