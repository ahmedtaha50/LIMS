// Domain: admin (roadmap M05, M16). User lifecycle, security policies, external-integration switches, alerts, usage heatmap.
// Every change is made by an Administrator who re-enters their password, states a reason and names the version they saw;
// the change and its audit entry commit together.
import { and, asc, eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { integrationSettings, systemSettings, users } from '../../db/schema';
import { aiIntegrationSchema, broadcastSchema, createUserSchema, settingsUpdateSchema, updateUserSchema, userActionSchema } from '../../lib/validations/admin';
import { activityHeatmap } from '../audit/activity';
import { assertActorPassword } from '../auth/credentials';
import { securityEventContext } from '../auth/events';
import { AI_KEY_CONTEXT, loadIntegrationSettings, publicAiSettings } from '../auth/integrationSettings';
import { adminUser } from '../auth/publicUser';
import { revokeUserSessions, type UserRow } from '../auth/sessions';
import { loadSecuritySettings } from '../auth/settings';
import { createUser, resetMfa, resetPassword, unlockUser } from '../auth/users';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction, type Tx } from '../core/tx';
import { emitEvent } from '../events/emit';
import { getKeystore } from '../crypto/keystore';
import { AppError, ForbiddenError } from '../http/errors';
import { validate } from '../http/validate';
import { writeAudit } from '../../db/utils';

export const adminRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actorOf = (req: any): UserRow => req.user;
  const adminOnly: RequestHandler = (req, _res, next) => next(actorOf(req).role === 'Admin' ? undefined : new ForbiddenError('Unauthorized'));
  const adminOrQa: RequestHandler = (req, _res, next) => next(['Admin', 'QA'].includes(actorOf(req).role) ? undefined : new ForbiddenError('Unauthorized'));

  // --- usage heatmap ---------------------------------------------------------------------------------------------------

  router.get('/admin/activity-heatmap', requireAuth, adminOnly, async (_req, res) => {
    // Counts what the audit trail holds and nothing else (the first version padded a quiet system with random numbers), in the server's own time zone.
    res.json(await activityHeatmap(db, Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  // --- security policies -----------------------------------------------------------------------------------------------

  router.get('/admin/settings', requireAuth, adminOnly, async (_req, res) => {
    await db.insert(systemSettings).values({ id: 'default' }).onConflictDoNothing();
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, 'default'));
    res.json(row);
  });

  router.put('/admin/settings', requireAuth, adminOnly, validate(settingsUpdateSchema), async (req, res) => {
    const actor = actorOf(req);
    const { password, reason, expectedVersion, ...policy } = req.body as typeof settingsUpdateSchema._output;
    await assertActorPassword(db, actor, password, { entity: 'SystemSettings', entityId: 'default', what: 'a security policy change' }, securityEventContext(req));
    await withTransaction(db, async tx => {
      await tx.insert(systemSettings).values({ id: 'default' }).onConflictDoNothing();
      const current = await lockRow(tx, systemSettings, 'default');
      await updateVersioned(tx, systemSettings, 'default', expectedVersion, { ...policy, updatedAt: new Date() });
      const before = Object.fromEntries(Object.keys(policy).map(k => [k, (current as Record<string, unknown>)[k]]));
      await writeAudit(tx, actor.id, 'Update', 'SystemSettings', 'default', 'security_policies', JSON.stringify(before), JSON.stringify(policy), reason);
    });
    res.json({ success: true });
  });

  // --- users ---------------------------------------------------------------------------------------------------------

  router.get('/admin/users', requireAuth, adminOrQa, async (_req, res) => {
    res.json((await db.select().from(users).orderBy(asc(users.name))).map(adminUser));
  });

  router.post('/admin/users', requireAuth, adminOnly, validate(createUserSchema), async (req, res) => {
    const actor = actorOf(req);
    const { name, email, role, reason, password } = req.body as typeof createUserSchema._output;
    await assertActorPassword(db, actor, password, { entity: 'User', entityId: actor.id, what: 'user creation' }, securityEventContext(req));
    const settings = await loadSecuritySettings(db);
    const created = await withTransaction(db, tx => createUser(tx, actor.id, settings, { name, email, role, reason }));
    res.status(201).json({ user: adminUser(created.user), temporaryPassword: created.temporaryPassword });
  });

  router.put('/admin/users/:id', requireAuth, adminOnly, validate(updateUserSchema), async (req, res) => {
    const actor = actorOf(req);
    const targetId = String(req.params.id);
    const body = req.body as typeof updateUserSchema._output;
    if (targetId === actor.id) throw new AppError(403, 'SELF_CHANGE_FORBIDDEN', 'You cannot change your own role or deactivate your own account. Ask another Administrator.');
    await assertActorPassword(db, actor, body.password, { entity: 'User', entityId: targetId, what: 'a user change' }, securityEventContext(req));

    const updated = await withTransaction(db, async tx => {
      // Serialise changes among the active Administrators, and re-check the actor under the lock: two Administrators who deactivate
      // each other at the same moment cannot both succeed and leave the system without one.
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'Admin'), eq(users.active, true))).orderBy(asc(users.id)).for('update');
      if (!admins.some(a => a.id === actor.id)) throw new AppError(409, 'CONFLICT', 'Conflict: your account changed while this request ran. Sign in again.');
      const target = await lockRow(tx, users, targetId);

      const set: Partial<typeof users.$inferInsert> = {};
      if (body.role !== undefined && body.role !== target.role) set.role = body.role;
      if (body.active !== undefined && body.active !== target.active) set.active = body.active;
      if (Object.keys(set).length === 0) throw new AppError(400, 'NO_CHANGE', 'The account already has these values.');
      const remaining = admins.filter(a => a.id !== targetId).length;
      if (target.role === 'Admin' && (set.role || set.active === false) && remaining < 1) throw new AppError(409, 'LAST_ADMIN', 'This is the last active Administrator.');
      if (set.active === true) Object.assign(set, { loginFailedAttempts: 0, loginLockedUntil: null });

      const row = await updateVersioned(tx, users, targetId, body.expectedVersion, set);
      if (set.role !== undefined || set.active === false) await revokeUserSessions(tx, targetId, set.active === false ? 'account deactivated' : 'role changed');
      const changed = Object.fromEntries(Object.entries(set).filter(([k]) => k === 'role' || k === 'active'));
      await writeAudit(tx, actor.id, 'Update', 'User', targetId, 'profile', JSON.stringify({ role: target.role, active: target.active }), JSON.stringify(changed), body.reason);
      return row;
    });
    res.json({ user: adminUser(updated) });
  });

  /** The three administrator actions that take only a reason and a version: same checks, same shape, different service call. */
  const userAction = <R>(path: string, what: string, run: (tx: Tx, actor: string, id: string, input: { reason: string; expectedVersion: number }) => Promise<R>, respond: (result: R) => unknown) =>
    router.post(`/admin/users/:id/${path}`, requireAuth, adminOnly, validate(userActionSchema), async (req, res) => {
      const actor = actorOf(req);
      const targetId = String(req.params.id);
      const body = req.body as typeof userActionSchema._output;
      await assertActorPassword(db, actor, body.password, { entity: 'User', entityId: targetId, what }, securityEventContext(req));
      const result = await withTransaction(db, tx => run(tx, actor.id, targetId, { reason: body.reason, expectedVersion: body.expectedVersion }));
      res.json(respond(result));
    });
  userAction('reset-password', 'a password reset', resetPassword, r => ({ user: adminUser(r.user), temporaryPassword: r.temporaryPassword }));
  userAction('unlock', 'unlocking an account', unlockUser, user => ({ user: adminUser(user) }));
  userAction('reset-mfa', 'a multi-factor reset', resetMfa, user => ({ user: adminUser(user) }));

  // --- alerts ----------------------------------------------------------------------------------------------------------

  router.post('/admin/broadcast', requireAuth, adminOnly, validate(broadcastSchema), async (req, res) => {
    const actor = actorOf(req);
    const { message } = req.body as typeof broadcastSchema._output;
    await withTransaction(db, async (tx, afterCommit) => {
      const alertId = `alert-${Date.now()}`;
      await writeAudit(tx, actor.id, 'Broadcast', 'SystemAlert', alertId, 'message', '', message, 'Administrator sent a system-wide alert');
      // The outbox row commits with the audit entry; every active user gets a persistent notification (r2-events, roadmap M23).
      await emitEvent(tx, { type: 'system.alert', payload: { message }, entity: 'SystemAlert', entityId: alertId, actorId: actor.id }, afterCommit);
    });
    res.json({ success: true });
  });

  // --- external integrations (roadmap M16) ----------------------------------------------------------------------------------

  router.get('/admin/integrations', requireAuth, adminOnly, async (_req, res) => {
    res.json({ ai: publicAiSettings(await loadIntegrationSettings(db)) });
  });

  router.put('/admin/integrations/ai', requireAuth, adminOnly, validate(aiIntegrationSchema), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as typeof aiIntegrationSchema._output;
    await assertActorPassword(db, actor, body.password, { entity: 'Integration', entityId: 'ai', what: 'an external AI change' }, securityEventContext(req));
    const row = await withTransaction(db, async tx => {
      await tx.insert(integrationSettings).values({ id: 'default' }).onConflictDoNothing();
      const current = await lockRow(tx, integrationSettings, 'default');
      const apiKeyEnc = body.apiKey ? getKeystore().encrypt(body.apiKey, AI_KEY_CONTEXT) : current.aiApiKeyEnc;
      if (body.enabled && !apiKeyEnc) throw new AppError(400, 'API_KEY_REQUIRED', 'Enter the API key before switching AI on.');
      const next = await updateVersioned(tx, integrationSettings, 'default', body.expectedVersion, {
        externalAiEnabled: body.enabled, aiApiKeyEnc: apiKeyEnc, aiModel: body.model ?? current.aiModel,
        aiRedactIdentifiers: body.redactIdentifiers ?? current.aiRedactIdentifiers, updatedBy: actor.id, updatedAt: new Date(),
      });
      const view = (r: typeof current) => ({ enabled: r.externalAiEnabled, model: r.aiModel, redactIdentifiers: r.aiRedactIdentifiers, hasApiKey: !!r.aiApiKeyEnc });
      await writeAudit(tx, actor.id, 'Update', 'Integration', 'ai', 'external_ai', JSON.stringify(view(current)), JSON.stringify({ ...view(next), apiKeyChanged: !!body.apiKey }), body.reason);
      return next;
    });
    res.json({ ai: publicAiSettings(row) });
  });

  return router;
};

