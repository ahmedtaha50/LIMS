import { z } from 'zod';
import { writeAudit } from '../audit/index.js';
import { withTx } from '../core/db.js';
import { HttpError, conflict, notFound } from '../core/errors.js';
import { route } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { hashPassword, passwordProblem } from '../identity/password.js';
import { ROLE_NAMES } from '../identity/roles.js';

const role = z.enum(ROLE_NAMES as [string, ...string[]]);
type Row = { id: string; username: string; display_name: string; roles: string[]; status: string; totp_enabled: boolean; locked_until: Date | null; version: number };
const view = (u: Row) => ({ id: u.id, username: u.username, displayName: u.display_name, roles: u.roles, status: u.status, secondFactor: u.totp_enabled, lockedUntil: u.locked_until?.toISOString() ?? null, version: u.version });
const COLS = 'id, username, display_name, roles, status, totp_enabled, locked_until, version';

export const routes = [
  route({
    method: 'GET', path: '/api/users', permission: 'users.manage', summary: 'List the accounts',
    handler: async ({ pool }) => (await pool.query<Row>(`SELECT ${COLS} FROM users ORDER BY lower(username)`)).rows.map(view),
  }),
  route({
    method: 'POST', path: '/api/users', permission: 'users.manage', summary: 'Create an account (the user changes the first password at sign-in)', status: 201,
    input: strict({ username: z.string().regex(/^[a-zA-Z0-9._-]{3,50}$/), displayName: z.string().min(1).max(100), roles: z.array(role).min(1), password: z.string().min(1).max(200) }),
    handler: async ({ pool, actor, input, res }) => {
      const problem = passwordProblem(input.password, input.username);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      const h = await hashPassword(input.password);
      return withTx(pool, async (c) => {
        const r = await c.query<Row>(`INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING ${COLS}`, [input.username, input.displayName, h, input.roles]);
        if (!r.rows[0]) throw new HttpError(409, 'username_taken', `The user name ${input.username} is already used.`);
        const u = view(r.rows[0]);
        await writeAudit(c, { actorId: actor!.userId, actorName: actor!.username, action: 'user.created', entity: 'user', entityId: u.id, newValue: { username: u.username, displayName: u.displayName, roles: u.roles }, requestId: String(res.locals.requestId) });
        return u;
      });
    },
  }),
  route({
    method: 'PATCH', path: '/api/users/:id', permission: 'users.manage', summary: 'Change name, roles or status of an account (states the version read)',
    input: strict({ version, reason: z.string().min(3).max(500), displayName: z.string().min(1).max(100).optional(), roles: z.array(role).min(1).optional(), status: z.enum(['active', 'disabled']).optional() }),
    handler: async ({ pool, actor, input, params, res }) => withTx(pool, async (c) => {
      const old = (await c.query<Row>(`SELECT ${COLS} FROM users WHERE id = $1 FOR UPDATE`, [params.id])).rows[0];
      if (!old) throw notFound('No such account.');
      if (old.version !== input.version) throw conflict();
      if (params.id === actor!.userId && (input.status === 'disabled' || (input.roles && !input.roles.includes('admin')))) throw new HttpError(400, 'self_lockout', 'You cannot disable your own account or remove your own administrator role.');
      const r = await c.query<Row>(`UPDATE users SET display_name = COALESCE($2, display_name), roles = COALESCE($3, roles), status = COALESCE($4, status), version = version + 1, updated_at = now()
                                    WHERE id = $1 AND version = $5 RETURNING ${COLS}`, [params.id, input.displayName ?? null, input.roles ?? null, input.status ?? null, input.version]);
      if (!r.rows[0]) throw conflict();
      if (input.status === 'disabled') await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
      const before = view(old), after = view(r.rows[0]);
      await writeAudit(c, { actorId: actor!.userId, actorName: actor!.username, action: 'user.changed', entity: 'user', entityId: params.id!, oldValue: { displayName: before.displayName, roles: before.roles, status: before.status }, newValue: { displayName: after.displayName, roles: after.roles, status: after.status }, reason: input.reason, requestId: String(res.locals.requestId) });
      return after;
    }),
  }),
  route({
    method: 'POST', path: '/api/users/:id/unlock', permission: 'users.manage', summary: 'Unlock an account locked after failed sign-ins',
    input: strict({ reason: z.string().min(3).max(500) }),
    handler: async ({ pool, actor, input, params, res }) => withTx(pool, async (c) => {
      const r = await c.query('UPDATE users SET locked_until = NULL, version = version + 1, updated_at = now() WHERE id = $1 RETURNING id', [params.id]);
      if (!r.rowCount) throw notFound('No such account.');
      await c.query('DELETE FROM login_failures WHERE user_id = $1', [params.id]);
      await writeAudit(c, { actorId: actor!.userId, actorName: actor!.username, action: 'user.unlocked', entity: 'user', entityId: params.id!, reason: input.reason, requestId: String(res.locals.requestId) });
    }),
  }),
];
