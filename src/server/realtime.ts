/**
 * Socket.IO server for push notifications (roadmap M23, SEC-11). r2-events owns this file.
 *
 *   - Every connection is authenticated in io.use() with the same access token as the API (auth: { token }): its signature and
 *     purpose, a live session (not revoked, within its absolute limit, not idle), an active user who need not change the password
 *     first. A connection without that is refused with an error whose message starts with UNAUTHORIZED. Connecting never extends the
 *     session: the socket does not count as activity.
 *   - An accepted socket joins only the room of its own user (user:<id>). The dispatcher (events/dispatcher.ts) pushes each
 *     notification to the room of the user it was created for, and it is created only for users whose role holds the event's
 *     audience permission; nothing is broadcast to every socket.
 *   - Every `revalidateMs` the sessions of the connected sockets are checked again; a socket whose session was revoked, expired,
 *     went idle or whose user was deactivated is disconnected by the server.
 */
import type { Server as HttpServer } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { Server, type Socket } from 'socket.io';
import { sessions, users } from '../db/schema';
import { passwordChangeRequired } from './auth/publicUser';
import { loadSecuritySettings } from './auth/settings';
import { verifyAccessToken } from './auth/tokens';
import type { Db } from './core/context';
import { log, serializeError } from './core/logger';
import { userRoom } from './events/dispatcher';

export interface RealtimeOptions {
  /** Defaults to the application's database (src/db/index), loaded at the first connection. */
  db?: Db;
  /** How often the sessions of connected sockets are checked again. Default 30 s. */
  revalidateMs?: number;
}

interface SocketIdentity { userId: string; sessionId: string }

type SessionRow = typeof sessions.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** Why the session cannot carry a socket, or null when it can. The checks of requireAuth, without touching the session. */
function refusal(session: SessionRow | undefined, user: UserRow | undefined, claims: SocketIdentity, settings: Awaited<ReturnType<typeof loadSecuritySettings>>, now: Date): string | null {
  if (!session || !user || session.userId !== claims.userId) return 'invalid token';
  if (session.revokedAt) return 'session revoked';
  if (session.expiresAt <= now) return 'session expired';
  if (!user.active) return 'user inactive';
  if (now.getTime() - session.lastSeenAt.getTime() > settings.sessionTimeoutMinutes * 60_000) return 'session idle';
  if (passwordChangeRequired(user, settings, now)) return 'password change required';
  return null;
}

async function loadSessions(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { session: SessionRow; user: UserRow }>();
  const rows = await db.select({ session: sessions, user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(inArray(sessions.id, ids));
  return new Map(rows.map(r => [r.session.id, r]));
}

export function createRealtime(httpServer: HttpServer, o: RealtimeOptions = {}) {
  const io = new Server(httpServer, { cors: { origin: false } });
  let dbPromise: Promise<Db> | null = o.db ? Promise.resolve(o.db) : null;
  const getDb = () => (dbPromise ??= import('../db/index').then(m => m.db as Db));

  io.use((socket, next) => {
    void (async () => {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || !token) return next(new Error('UNAUTHORIZED: a session token is required.'));
      let claims: SocketIdentity;
      try { claims = verifyAccessToken(token); } catch { return next(new Error('UNAUTHORIZED: invalid token.')); }
      const db = await getDb();
      const found = (await loadSessions(db, [claims.sessionId])).get(claims.sessionId);
      const why = refusal(found?.session, found?.user, claims, await loadSecuritySettings(db), new Date());
      if (why) return next(new Error(`UNAUTHORIZED: ${why}.`));
      (socket.data as SocketIdentity) = { userId: claims.userId, sessionId: claims.sessionId };
      await socket.join(userRoom(claims.userId));
      next();
    })().catch((err) => {
      log.error({ err: serializeError(err) }, 'socket authentication failed');
      next(new Error('UNAVAILABLE: the server could not check the session.'));
    });
  });

  let checking = false;
  const revalidate = async () => {
    if (checking) return;
    checking = true;
    try {
      const open = [...io.of('/').sockets.values()] as Socket[];
      if (!open.length) return;
      const db = await getDb();
      const found = await loadSessions(db, [...new Set(open.map(s => (s.data as SocketIdentity).sessionId).filter(Boolean))]);
      const settings = await loadSecuritySettings(db);
      const now = new Date();
      for (const s of open) {
        const id = s.data as SocketIdentity;
        const row = found.get(id.sessionId);
        const why = refusal(row?.session, row?.user, id, settings, now);
        if (why) { s.emit('session_ended', { reason: why }); s.disconnect(true); }
      }
    } catch (err) {
      log.error({ err: serializeError(err) }, 'socket session check failed');
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => { void revalidate(); }, o.revalidateMs ?? 30_000);
  timer.unref?.();
  httpServer.on('close', () => clearInterval(timer));
  return io;
}
