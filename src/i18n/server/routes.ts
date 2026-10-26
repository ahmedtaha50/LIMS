// Domain: display preferences of the signed-in user (roadmap M38, r3-i18n). Registered in src/server/routes/index.ts and given its rules
// (SELF: every signed-in user, only their own row) in src/server/authz/routeTable.ts by the wave gate.
//
//   GET /me/preferences   { language, digits, version }   the defaults (en, latin, version 0) when the user never chose
//   PUT /me/preferences   { language, digits, expectedVersion }   saves the choice; 409 when it moved since the screen read it
//
// Display only: no GxP record, signature, audit entry, CSV or PDF depends on these values. The actor is always req.user; the user id is
// never taken from the body. A change is audited (entity UserPreference) in the same transaction as the write.
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../../db/utils';
import type { RouteContext } from '../../server/core/context';
import { createRouter } from '../../server/core/router';
import { withTransaction } from '../../server/core/tx';
import { ConflictError } from '../../server/http/errors';
import { validate } from '../../server/http/validate';
import { DIGIT_MODES, LANGUAGES } from '../languages';
import { userPreferences } from './schema';

/** PUT /me/preferences. The user, version and timestamps are the server's. */
export const preferencesSchema = z.object({
  language: z.enum(LANGUAGES, { error: `The language is one of: ${LANGUAGES.join(', ')}.` }),
  digits: z.enum(DIGIT_MODES, { error: `The digit style is one of: ${DIGIT_MODES.join(', ')}.` }),
  expectedVersion: z.number().int().min(0),
}).strict();

export const DEFAULT_PREFERENCES = { language: 'en', digits: 'latin', version: 0 } as const;

export const i18nRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/me/preferences', requireAuth, async (req, res) => {
    const user = (req as any).user;
    const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).limit(1);
    res.json(row ? { language: row.language, digits: row.digits, version: row.version } : DEFAULT_PREFERENCES);
  });

  router.put('/me/preferences', requireAuth, validate(preferencesSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as z.infer<typeof preferencesSchema>;
    const saved = await withTransaction(db, async (tx) => {
      const [before] = await tx.select().from(userPreferences).where(eq(userPreferences.userId, user.id)).for('update').limit(1);
      const current = before?.version ?? 0;
      if (current !== body.expectedVersion) throw new ConflictError('Your display settings were changed in another window. Reload and choose again.');
      if (before && before.language === body.language && before.digits === body.digits) return before; // nothing to record
      let row;
      if (!before) {
        [row] = await tx.insert(userPreferences).values({ userId: user.id, language: body.language, digits: body.digits }).returning();
      } else {
        [row] = await tx.update(userPreferences)
          .set({ language: body.language, digits: body.digits, version: sql`${userPreferences.version} + 1`, updatedAt: new Date() })
          .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.version, body.expectedVersion)))
          .returning();
        if (!row) throw new ConflictError();
      }
      const from = before ?? DEFAULT_PREFERENCES;
      const reason = 'Display preference chosen by the user (no GxP data is affected).';
      if (from.language !== body.language) await writeAudit(tx, user.id, before ? 'Update' : 'Create', 'UserPreference', user.id, 'language', from.language, body.language, reason);
      if (from.digits !== body.digits) await writeAudit(tx, user.id, before ? 'Update' : 'Create', 'UserPreference', user.id, 'digits', from.digits, body.digits, reason);
      // The first choice creates the row even when it equals the defaults: the creation is still an audited event.
      if (!before && from.language === body.language && from.digits === body.digits) await writeAudit(tx, user.id, 'Create', 'UserPreference', user.id, 'language', '', body.language, reason);
      return row;
    });
    res.json({ language: saved.language, digits: saved.digits, version: saved.version });
  });

  return router;
};
