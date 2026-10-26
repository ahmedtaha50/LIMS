import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import { getConfig, type RateLimitSettings } from '../config';
import { healthRouter, type PoolLike } from '../obs/health';
import { createLimiters } from './rateLimit';

export interface SecurityOptions {
  /** false only in tests that make hundreds of requests from one address. */
  rateLimit?: boolean;
  /** Overrides the configured limits (tests). */
  limits?: Partial<RateLimitSettings>;
  /** The database pool /api/ready probes. Default: the application's own pool. */
  getPool?: () => PoolLike | Promise<PoolLike>;
}

/**
 * Content-Security-Policy for the built single-page app: everything comes from this origin, no inline script,
 * no eval, no external host (fonts are bundled), no framing. Inline style ATTRIBUTES are allowed (charting and
 * scanner libraries set them); inline <style> elements and external stylesheets are not.
 */
export const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  styleSrcAttr: ["'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  mediaSrc: ["'self'", 'blob:'],
  workerSrc: ["'self'", 'blob:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  // The desktop app is plain http on 127.0.0.1; asking the browser to upgrade sub-resources to https would break it.
  upgradeInsecureRequests: null,
};

const isLoopback = (a: string) => a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');

/** LAN mode only: another computer may not speak plain http to this server. Fails closed if the listener is not TLS. */
export const requireTlsFromRemote: RequestHandler = (req, res, next) => {
  if (isLoopback(req.socket.remoteAddress ?? '') || (req.socket as { encrypted?: boolean }).encrypted) return next();
  res.status(403).json({ error: 'This server accepts only encrypted (https) connections from other computers.', code: 'TLS_REQUIRED' });
};

export function applySecurity(app: Express, opts: SecurityOptions = {}) {
  const config = getConfig();

  // Socket.IO answers /socket.io/ on the http server itself, and the Express app is registered as a second 'request'
  // listener on the same server (server.ts), so it is handed those requests too. If both write a response, the second
  // one fails with ERR_HTTP_HEADERS_SENT, from inside Express's own first middleware, and the error handling that
  // follows can take the process down. The app therefore ignores these requests altogether.
  const handle = app.handle.bind(app);
  (app as any).handle = (req: Request, res: Response, next: NextFunction) => {
    if (/^\/socket\.io(?:[/?]|$)/.test(req.url)) return;
    return handle(req, res, next);
  };

  // req.ip is the socket address unless TRUST_PROXY says a reverse proxy is in front (older code trusted one hop
  // unconditionally, which let any client choose its own address with X-Forwarded-For).
  app.set('trust proxy', config.trustProxy > 0 ? config.trustProxy : false);

  if (config.bindLan) app.use(requireTlsFromRemote);

  app.use(helmet({
    contentSecurityPolicy: config.isDevelopment ? false : { useDefaults: false, directives: cspDirectives },
  }) as unknown as RequestHandler);

  // Probes come before the limiters: a supervisor polling them must never be throttled.
  app.use('/api', healthRouter({
    getPool: opts.getPool ?? (async () => (await import('../../db/index')).createPool() as unknown as PoolLike),
  }));

  if (opts.rateLimit !== false) {
    const limiters = createLimiters({ ...config.rateLimit, ...opts.limits });
    // Credentials are checked at /api/auth/*; the e-mail limiter needs the parsed body, so the (small) JSON body
    // of these routes is parsed here. express.json() later in app.ts skips a body that is already parsed.
    app.use('/api/auth', express.json({ limit: '16kb' }), limiters.authIp, limiters.authEmail);
    app.use('/api', limiters.ip, limiters.user);
  }
}
