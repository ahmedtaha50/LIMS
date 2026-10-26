/**
 * The API-token principal (roadmap M22): how a machine authenticates to /api/v1.
 *
 * A token is `lims_<8 characters>_<43 characters>`: the first part is public (token_prefix, shown on the API clients screen so an
 * Administrator can tell tokens apart), the second is 32 random bytes. Only SHA-256 of the whole token is stored; a token of 256
 * random bits needs no salt or slow hash, and the lookup is by that hash. The token is shown once, when the client is created.
 *
 * A token resolves to its client and the client's service account (users row, role 'Instrument'). It is refused (401) when it is
 * unknown, revoked, expired, or when the service account is inactive or is no longer an 'Instrument' account. API tokens are accepted
 * on /api/v1 only: anywhere else in the API (and so on every route that makes an e-signature) a valid token is a 403 recorded as
 * AUTHZ_DENIED, because an e-signature is made by a person in their own session (21 CFR 11.100, 11.200).
 */
import { createHash, randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { apiClients } from '../../../db/schema/api-clients';
import { users } from '../../../db/schema';
import type { Db } from '../../core/context';
import { AppError } from '../../http/errors';
import { recordSecurityEvent, securityEventContext } from '../events';
import type { UserRow } from '../sessions';

export const SERVICE_ACCOUNT_ROLE = 'Instrument';
const PREFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = /^lims_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;
/** last_used_at is written at most this often per client (a busy instrument should not write a row per call). */
const TOUCH_INTERVAL_SECONDS = 60;

export type ApiClientRow = typeof apiClients.$inferSelect;

export const hashApiToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** True for anything shaped like an API token (whether or not it exists). Session tokens are JWTs and never match. */
export const looksLikeApiToken = (value: string | null | undefined): value is string => typeof value === 'string' && value.startsWith('lims_');

export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const bytes = randomBytes(8);
  const id = Array.from(bytes, b => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join('');
  const prefix = `lims_${id}`;
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: hashApiToken(token) };
}

export const bearerOf = (header: string | undefined): string | null =>
  typeof header === 'string' && header.startsWith('Bearer ') && header.length > 7 ? header.slice(7).trim() : null;

export interface ApiPrincipal { client: ApiClientRow; user: UserRow }

/** Resolves a token to its client and service account, or throws 401 with the reason. Failures are recorded as security events. */
export async function authenticateApiToken(db: Db, token: string, context: ReturnType<typeof securityEventContext>): Promise<ApiPrincipal> {
  const refuse = async (code: string, message: string, client?: ApiClientRow) => {
    await recordSecurityEvent(db, {
      type: 'API_TOKEN_REJECTED', outcome: 'failure', actorId: client?.userId ?? null, actorRole: client ? SERVICE_ACCOUNT_ROLE : null,
      actorLabel: client ? null : token.slice(0, 13), ...context, detail: { reason: code, clientId: client?.id ?? null, prefix: token.slice(0, 13) },
    });
    return new AppError(401, code, message);
  };
  if (!TOKEN.test(token)) throw await refuse('INVALID_TOKEN', 'The API token is not valid.');
  const [client] = await db.select().from(apiClients).where(eq(apiClients.tokenHash, hashApiToken(token))).limit(1);
  if (!client) throw await refuse('INVALID_TOKEN', 'The API token is not valid.');
  if (client.status === 'Revoked') throw await refuse('TOKEN_REVOKED', 'The API token was revoked.', client);
  const now = new Date();
  if (client.expiresAt <= now) throw await refuse('TOKEN_EXPIRED', 'The API token has expired. An Administrator issues a new one.', client);
  const [user] = await db.select().from(users).where(eq(users.id, client.userId)).limit(1);
  if (!user || !user.active || user.role !== SERVICE_ACCOUNT_ROLE) {
    throw await refuse('SERVICE_ACCOUNT_INACTIVE', 'The service account of this API client is not active.', client);
  }
  if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > TOUCH_INTERVAL_SECONDS * 1000) {
    // Bookkeeping, not a record: not audited and not versioned (like sessions.last_seen_at).
    await db.update(apiClients).set({ lastUsedAt: now })
      .where(sql`${apiClients.id} = ${client.id} AND (${apiClients.lastUsedAt} IS NULL OR ${apiClients.lastUsedAt} < ${new Date(now.getTime() - TOUCH_INTERVAL_SECONDS * 1000)})`);
  }
  return { client, user };
}

/**
 * Mounted on /api after /api/v1 and before the session layer: a request to the interactive API that carries an API token is refused
 * (401 if the token is not valid, 403 API_TOKEN_NOT_ALLOWED if it is), so a machine can never reach a signing route or act as a person.
 */
export function refuseApiTokensOutsideV1(db: Db): RequestHandler {
  return async function refuseApiTokens(req, _res, next) {
    try {
      const token = bearerOf(req.headers.authorization);
      if (!looksLikeApiToken(token)) return next();
      const context = securityEventContext(req);
      const { client, user } = await authenticateApiToken(db, token, context);
      await recordSecurityEvent(db, {
        type: 'AUTHZ_DENIED', outcome: 'denied', actorId: user.id, actorRole: user.role, ...context,
        detail: { method: req.method, path: req.path, clientId: client.id, reason: 'API tokens are accepted on /api/v1 only' },
      });
      throw new AppError(403, 'API_TOKEN_NOT_ALLOWED',
        'Forbidden: an API token is accepted on /api/v1 only. E-signatures and the interactive API need a person signed in with their own account.');
    } catch (err) {
      next(err);
    }
  };
}
