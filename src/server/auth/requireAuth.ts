/**
 * Authentication middleware (roadmap M05). Replaces the interim token check of r1-core.
 * Every request: the Bearer token must be an access token (purpose and signature), its session must exist, not be revoked, not
 * be past its absolute limit, and not be idle for longer than the policy allows; the user must still be active; and a user whose
 * password is temporary or expired may call nothing but the routes that let them change it. The user row is read fresh each time
 * and handed to handlers as `req.user` (never from the token or the client), the session as `req.authSession`.
 * The function is named requireAuth on purpose: the route-table test recognises protected routes by that name.
 */
import type { RequestHandler } from 'express';
import type { Db } from '../core/context';
import { setAuditSessionId } from '../audit/context';
import { getKeystore } from '../crypto/keystore';
import { AppError } from '../http/errors';
import { passwordChangeRequired } from './publicUser';
import { loadSession, touchSession, type SessionRow, type UserRow } from './sessions';
import { loadSecuritySettings } from './settings';
import { TokenError, verifyAccessToken } from './tokens';

export interface RequireAuthOptions {
  /** Accept a session that has been idle past the timeout (re-authentication and logout). The absolute limit and revocation still apply. */
  allowIdle?: boolean;
  /** Accept a user who must change the password first (the change-password route itself, /auth/me, logout). */
  allowPasswordChangePending?: boolean;
}

export type AuthSession = SessionRow & { idle: boolean };

declare module 'express-serve-static-core' {
  interface Request { authSession?: AuthSession }
}

export function createRequireAuth(db: Db, options: RequireAuthOptions = {}): RequestHandler {
  getKeystore(); // no key material: fail now, when the application is built, not on the first request
  return async function requireAuth(req, _res, next) {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Authentication token is required.');

      let claims: { userId: string; sessionId: string };
      try { claims = verifyAccessToken(header.slice('Bearer '.length)); } catch (e) {
        if (e instanceof TokenError) throw new AppError(401, 'INVALID_TOKEN', 'Unauthorized: Invalid token.');
        throw e;
      }

      const found = await loadSession(db, claims.sessionId);
      if (!found || found.session.userId !== claims.userId) throw new AppError(401, 'INVALID_TOKEN', 'Unauthorized: Invalid token.');
      const { session, user } = found;
      const now = new Date();
      if (session.revokedAt) throw new AppError(401, 'SESSION_REVOKED', 'Your session has ended. Sign in again.');
      if (session.expiresAt <= now) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has reached its time limit. Sign in again.');
      if (!user.active) throw new AppError(401, 'USER_INACTIVE', 'User inactive or missing from GxP identity store.');

      const settings = await loadSecuritySettings(db);
      const idle = now.getTime() - session.lastSeenAt.getTime() > settings.sessionTimeoutMinutes * 60_000;
      if (idle && !options.allowIdle) throw new AppError(401, 'SESSION_IDLE', 'Your session was locked after a period of inactivity. Re-enter your password to continue.');
      if (!options.allowPasswordChangePending && passwordChangeRequired(user, settings, now)) {
        throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before you can continue.');
      }

      if (!idle) await touchSession(db, session.id);
      (req as any).user = user;
      setAuditSessionId(session.id); // the audit writer stamps this session on every entry the request writes (a no-op where no context is open)
      req.authSession = { ...session, idle };
      next();
    } catch (err) {
      // An unexpected failure (the database is down) is a server error, not a reason to tell the client its session is invalid.
      next(err);
    }
  };
}
