/**
 * Rate limiters for /api (roadmap M03).
 *
 * The desktop build serves every user from 127.0.0.1, so a per-address limit alone is one shared bucket. Three kinds of
 * key are used instead, and none of them can be changed by the client:
 *  - ip     the socket address (X-Forwarded-For counts only when TRUST_PROXY names a real proxy). A generous backstop.
 *  - user   a fingerprint of the bearer token, so each signed-in session has its own budget. The token is hashed, not
 *           decoded: an unverified claim would let one client spend another user's budget.
 *  - auth   failed credential checks per address and per e-mail address. Successful logins are not counted, so a lab
 *           logging in at shift start is not throttled, but parallel guesses are (counting happens when the request
 *           arrives, and is undone only for a response below 400).
 * A refused request is JSON ({ error, code: 'RATE_LIMITED', retryAfterSeconds, requestId }) with Retry-After.
 */
import { createHash } from 'crypto';
import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { RateLimitSettings } from '../config';

const bearerOf = (req: Request): string | null => {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') && h.length > 7 ? h.slice(7) : null;
};

/** Normalised e-mail from an already-parsed login body, or null (missing, not a string, absurdly long). */
const emailOf = (req: Request): string | null => {
  const e = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).email : undefined;
  return typeof e === 'string' && e.length > 0 && e.length <= 254 ? e.trim().toLowerCase() : null;
};

const addressOf = (req: Request): string => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');

const refuse = (message: string): Options['handler'] => (_req: Request, res: Response) => {
  const retry = Number(res.getHeader('Retry-After'));
  res.status(429).json({ error: message, code: 'RATE_LIMITED', ...(retry > 0 ? { retryAfterSeconds: retry } : {}) });
};

const common = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  // X-Forwarded-For is ignored on purpose (TRUST_PROXY decides); the library's warning about that is noise.
  validate: { xForwardedForHeader: false },
};

export interface Limiters {
  ip: RequestHandler;
  user: RequestHandler;
  authIp: RequestHandler;
  authEmail: RequestHandler;
}

export function createLimiters(s: RateLimitSettings): Limiters {
  const minute = 60_000;
  const authWindow = s.authWindowMinutes * minute;
  const authOnly = (req: Request) => req.method !== 'POST';

  return {
    ip: rateLimit({
      ...common, windowMs: minute, limit: s.ipPerMinute,
      keyGenerator: addressOf,
      handler: refuse('Too many requests from this computer. Please wait a moment and try again.'),
    }),
    user: rateLimit({
      ...common, windowMs: minute, limit: s.userPerMinute,
      skip: (req) => bearerOf(req) === null,
      keyGenerator: (req) => 'u:' + createHash('sha256').update(bearerOf(req) ?? '').digest('hex').slice(0, 32),
      handler: refuse('Too many requests for this user. Please wait a moment and try again.'),
    }),
    authIp: rateLimit({
      ...common, windowMs: authWindow, limit: s.authIpFailures, skipSuccessfulRequests: true,
      skip: authOnly,
      keyGenerator: addressOf,
      handler: refuse('Too many failed sign-in attempts from this computer. Try again later.'),
    }),
    authEmail: rateLimit({
      ...common, windowMs: authWindow, limit: s.authEmailFailures, skipSuccessfulRequests: true,
      skip: (req) => authOnly(req) || emailOf(req) === null,
      keyGenerator: (req) => 'e:' + emailOf(req),
      handler: refuse('Too many failed sign-in attempts for this account. Try again later.'),
    }),
  };
}
