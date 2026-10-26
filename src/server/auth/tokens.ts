/**
 * Purpose-typed tokens (roadmap M05). Three kinds, each signed with its own HKDF-derived key and carrying a `typ` claim, so a token
 * made for one purpose is rejected by the verifier of every other (the old pre-MFA token was accepted as a session):
 *   access  proves a session: { typ, sub: user id, sid: session id, exp = the session's absolute limit }. Whether the session is still
 *           usable (not revoked, not idle, user still active) is decided from the database on every request, not from the token.
 *           It also carries id, name, email and role for DISPLAY ONLY: the current App.tsx reads the signed-in user from the token
 *           payload. The server never reads them (requireAuth loads the user row), so a role change takes effect at once whatever
 *           the token says. Remove them when the client takes the user from GET /api/auth/me (r1-client-shell).
 *   mfa     password accepted, second factor pending: { typ, sub, jti }, 5 minutes, redeemable once (auth_challenges row)
 *   enrol   password accepted, TOTP enrolment pending: same shape
 * The header names the key generation (`kid`), so tokens signed before a key rotation stay valid until they expire.
 */
import jwt from 'jsonwebtoken';
import { getKeystore } from '../crypto/keystore';

export type TokenType = 'access' | 'mfa' | 'enrol';
export const CHALLENGE_TTL_SECONDS = 5 * 60;

export class TokenError extends Error {
  constructor(message = 'Invalid token.') { super(message); this.name = 'TokenError'; }
}

function sign(type: TokenType, payload: Record<string, unknown>, subject: string, expiresAtSeconds: number): string {
  const ks = getKeystore();
  return jwt.sign({ ...payload, typ: type, exp: expiresAtSeconds }, ks.deriveKey('jwt', type), {
    algorithm: 'HS256', subject, keyid: String(ks.current),
  });
}

function verify(type: TokenType, token: string): jwt.JwtPayload {
  const decoded = jwt.decode(token, { complete: true });
  const kid = Number((decoded?.header as jwt.JwtHeader | undefined)?.kid);
  if (!decoded || !Number.isInteger(kid)) throw new TokenError();
  const ks = getKeystore();
  if (!ks.generations.includes(kid)) throw new TokenError();
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, ks.deriveKey('jwt', type, kid), { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch {
    throw new TokenError();
  }
  if (payload.typ !== type || typeof payload.sub !== 'string' || !payload.sub) throw new TokenError();
  return payload;
}

export function signAccessToken(input: { userId: string; sessionId: string; expiresAt: Date; display?: { name: string; email: string | null; role: string } }): string {
  const { name, email, role } = input.display ?? {};
  return sign('access', { sid: input.sessionId, ...(input.display ? { id: input.userId, name, email, role } : {}) }, input.userId, Math.floor(input.expiresAt.getTime() / 1000));
}

export function verifyAccessToken(token: string): { userId: string; sessionId: string } {
  const p = verify('access', token);
  if (typeof p.sid !== 'string' || !p.sid) throw new TokenError();
  return { userId: p.sub!, sessionId: p.sid };
}

export function signChallengeToken(type: 'mfa' | 'enrol', input: { userId: string; jti: string; expiresAt: Date }): string {
  return sign(type, { jti: input.jti }, input.userId, Math.floor(input.expiresAt.getTime() / 1000));
}

export function verifyChallengeToken(type: 'mfa' | 'enrol', token: string): { userId: string; jti: string } {
  const p = verify(type, token);
  if (typeof p.jti !== 'string' || !p.jti) throw new TokenError();
  return { userId: p.sub!, jti: p.jti };
}
