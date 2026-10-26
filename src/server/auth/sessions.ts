/**
 * Server-side sessions (roadmap M05). A session row is created at sign-in; the access token only names it. Idle timeout, the
 * absolute limit, logout and revocation after a password, role, status or MFA change are all decided from this table.
 */
import { randomBytes } from 'crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { sessions, users } from '../../db/schema';
import type { Executor } from '../core/tx';

export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type AuthMethod = 'password' | 'password+totp' | 'password+recovery';

/** `last_seen_at` is written at most this often per session, so an active user does not cause a write per request. */
export const TOUCH_INTERVAL_SECONDS = 10;

export async function createSession(ex: Executor, input: { userId: string; authMethod: AuthMethod; absoluteHours: number }) {
  const id = `ses-${randomBytes(12).toString('hex')}`;
  const expiresAt = new Date(Date.now() + input.absoluteHours * 3_600_000);
  await ex.insert(sessions).values({ id, userId: input.userId, authMethod: input.authMethod, expiresAt });
  return { id, expiresAt };
}

export async function loadSession(ex: Executor, sessionId: string): Promise<{ session: SessionRow; user: UserRow } | null> {
  const rows = await ex.select({ session: sessions, user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

export async function touchSession(ex: Executor, sessionId: string): Promise<void> {
  await ex.update(sessions).set({ lastSeenAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), sql`${sessions.lastSeenAt} < now() - make_interval(secs => ${TOUCH_INTERVAL_SECONDS})`));
}

/** Unconditional touch: used after a successful re-authentication, which must restart the idle clock now. */
export async function restartIdleClock(ex: Executor, sessionId: string): Promise<void> {
  await ex.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(ex: Executor, sessionId: string, reason: string): Promise<boolean> {
  const rows = await ex.update(sessions).set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
  return rows.length > 0;
}

/** Ends every live session of the user, except `exceptSessionId` (the one that just changed the password). Returns how many ended. */
export async function revokeUserSessions(ex: Executor, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const rows = await ex.update(sessions).set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined))
    .returning({ id: sessions.id });
  return rows.length;
}
