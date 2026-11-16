import { z } from 'zod';
import { writeAudit } from '../audit/index.js';
import { withTx } from '../core/db.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';

// E26#1: the interface language is chosen by each user and kept with the account (every device shows it).
export const routes = [
  route({
    method: 'GET', path: '/api/me/preferences', permission: 'session', summary: 'The preferences of the signed-in user (interface language)',
    handler: async ({ pool, actor }) => ({ language: (await pool.query<{ language: string }>('SELECT language FROM users WHERE id = $1', [actor!.userId])).rows[0]?.language ?? 'en' }),
  }),
  route({
    method: 'PUT', path: '/api/me/preferences', permission: 'session', summary: 'Choose the interface language (English or Arabic)',
    input: strict({ language: z.enum(['en', 'ar']) }),
    handler: ({ pool, actor, res, input }) => withTx(pool, async (c) => {
      const old = (await c.query<{ language: string }>('SELECT language FROM users WHERE id = $1 FOR UPDATE', [actor!.userId])).rows[0]!.language;
      if (old !== input.language) {
        await c.query('UPDATE users SET language = $2, updated_at = now() WHERE id = $1', [actor!.userId, input.language]);
        await writeAudit(c, { actorId: actor!.userId, actorName: actor!.username, action: 'user.language_changed', entity: 'user', entityId: actor!.userId, oldValue: old, newValue: input.language, requestId: String(res.locals.requestId) });
      }
      return { language: input.language };
    }),
  }),
];
