// Domain: the signed-in user's own notifications (roadmap M23). Owned by r2-events.
//
//   GET  /notifications             the newest notifications of req.user (default 50, at most 200) and the number unread
//   POST /notifications/:id/read    marks one of the user's own notifications read (another user's is 404)
//   POST /notifications/read-all    marks all of them read
//
// A notification is the persistent copy of an event (src/server/events): a user who was away sees it at the next sign-in. It is not a
// GxP record and never replaces a review or a signature; it says what happened and links to the record, where the permissions of
// the record apply. read_at is written once (the first time it is read) and never cleared, so it records when the user first marked it.
// Route rules (src/server/authz/routeTable.ts): `self`, no permission: a user only ever reaches their own rows.
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { notifications } from '../../db/schema/events';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { notificationView } from '../events/dispatcher';
import { NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

export const notificationListQuerySchema = z.object({
  unread: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();
export const notificationReadSchema = z.object({}).strict();

export const notificationsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  const unreadOf = async (userId: string) =>
    (await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt))))[0]?.n ?? 0;

  router.get('/notifications', requireAuth, validate(notificationListQuerySchema, 'query'), async (req, res) => {
    const user = (req as any).user;
    const q = req.query as z.infer<typeof notificationListQuerySchema>;
    const rows = await db.select().from(notifications)
      .where(and(eq(notifications.userId, user.id), q.unread ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(q.limit ?? 50);
    res.json({ items: rows.map(notificationView), unread: Number(await unreadOf(user.id)) });
  });

  router.post('/notifications/read-all', requireAuth, validate(notificationReadSchema), async (req, res) => {
    const user = (req as any).user;
    const rows = await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))).returning({ id: notifications.id });
    res.json({ updated: rows.length, unread: 0 });
  });

  router.post('/notifications/:id/read', requireAuth, validate(notificationReadSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    // Only the owner's row matches; the first read time is kept.
    await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id), isNull(notifications.readAt)));
    const [row] = await db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, user.id))).limit(1);
    if (!row) throw new NotFoundError(`Notification ${id} was not found.`);
    res.json(notificationView(row));
  });

  return router;
};
