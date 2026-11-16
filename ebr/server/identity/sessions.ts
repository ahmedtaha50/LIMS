import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Client, Pool } from '../core/db.js';
import type { Actor, Authorizer } from '../core/route.js';
import { isPrivileged, permissionsOf } from './roles.js';

export const COOKIE = 'ebr_session';
/** Sign-off after inactivity (Annex 11 security) and an absolute limit per session; both can be set per site. */
const idleMinutes = () => Number(process.env.EBR_SESSION_IDLE_MINUTES ?? 15);
const maxHours = () => Number(process.env.EBR_SESSION_MAX_HOURS ?? 12);
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function openSession(c: Client, userId: string, mfa: boolean, userAgent: string | undefined): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString('base64url');
  const r = await c.query<{ id: string }>('INSERT INTO sessions (token_hash, user_id, mfa, user_agent) VALUES ($1, $2, $3, $4) RETURNING id', [hash(token), userId, mfa, userAgent?.slice(0, 200) ?? null]);
  return { token, id: r.rows[0]!.id };
}

export function setCookie(res: Response, token: string) {
  const secure = process.env.EBR_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
}
export const clearCookie = (res: Response) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);

export function tokenOf(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

export type SessionActor = Actor & { sessionId: string; displayName: string; restricted: 'none' | 'mfa' | 'password' };
type Row = { session_id: string; mfa: boolean; created_at: Date; last_seen: Date; user_id: string; username: string; display_name: string; roles: string[]; must_change_password: boolean; idle_ok: boolean; age_ok: boolean; touch: boolean };

/** The session behind a request, checked against the database on every request (so a revocation holds on every instance). */
export async function sessionOf(pool: Pool, req: Request): Promise<SessionActor | null> {
  const token = tokenOf(req);
  if (!token) return null;
  const r = await pool.query<Row>(
    `SELECT s.id AS session_id, s.mfa, s.created_at, s.last_seen, u.id AS user_id, u.username, u.display_name, u.roles, u.must_change_password,
            s.last_seen > now() - make_interval(mins => $2) AS idle_ok, s.created_at > now() - make_interval(hours => $3) AS age_ok,
            s.last_seen < now() - interval '60 seconds' AS touch
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.status = 'active'`, [hash(token), idleMinutes(), maxHours()]);
  const row = r.rows[0];
  if (!row || !row.idle_ok || !row.age_ok) return null;
  if (row.touch) await pool.query('UPDATE sessions SET last_seen = now() WHERE id = $1', [row.session_id]);
  const restricted = row.must_change_password ? 'password' : isPrivileged(row.roles) && !row.mfa ? 'mfa' : 'none';
  return {
    sessionId: row.session_id, userId: row.user_id, username: row.username, displayName: row.display_name, restricted,
    // until the password is changed or the second factor is set up, the session reaches only 'session' routes
    permissions: restricted === 'none' ? permissionsOf(row.roles) : new Set(['session']),
  };
}

export const authorizer = (pool: Pool): Authorizer => (req) => sessionOf(pool, req);
