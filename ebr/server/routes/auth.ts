import { z } from 'zod';
import { writeAudit } from '../audit/index.js';
import { withTx } from '../core/db.js';
import { HttpError } from '../core/errors.js';
import { route } from '../core/route.js';
import { strict } from '../core/validate.js';
import { hashPassword, passwordProblem, verifyPassword } from '../identity/password.js';
import { isPrivileged } from '../identity/roles.js';
import { directoryConfig, directorySignIn } from '../directory/index.js';
import { clearCookie, openSession, sessionOf, setCookie, type SessionActor } from '../identity/sessions.js';
import { newSecret, otpauthUrl, verifyTotp } from '../identity/totp.js';
import { settingsOf } from '../settings/index.js';

const wrong = () => new HttpError(401, 'bad_credentials', 'The user name or the password is not correct.');
type U = { id: string; username: string; display_name: string; password_hash: string; roles: string[]; status: string; totp_secret: string | null; totp_enabled: boolean; locked_until: Date | null; must_change_password: boolean; auth_source: string; break_glass: boolean };
const me = (a: SessionActor) => ({ userId: a.userId, username: a.username, displayName: a.displayName, permissions: [...a.permissions].sort(), mustChangePassword: a.restricted === 'password', mustSetUpSecondFactor: a.restricted === 'mfa' });

export const routes = [
  route({
    method: 'POST', path: '/api/auth/login', permission: 'public', summary: 'Sign in with user name, password and, for QA and administrators, the authenticator code',
    input: strict({ username: z.string().min(1).max(100), password: z.string().min(1).max(200), totp: z.string().max(10).optional() }),
    handler: async ({ pool, input, req, res }) => {
      const rid = String(res.locals.requestId);
      let u = (await pool.query<U>('SELECT * FROM users WHERE lower(username) = lower($1)', [input.username])).rows[0];
      const fail = async (why: string, user: U | undefined) => withTx(pool, async (c) => {
        let locked = false;
        // E27: the numbers are site settings, read at the moment of the failure
        const st = await settingsOf(c, ['signin.maxFailures', 'signin.windowMinutes', 'signin.lockMinutes'] as const);
        const MAX_FAILURES = Number(st['signin.maxFailures']), WINDOW_MINUTES = Number(st['signin.windowMinutes']), LOCK_MINUTES = Number(st['signin.lockMinutes']);
        if (user) {
          await c.query('INSERT INTO login_failures (user_id) VALUES ($1)', [user.id]);
          const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM login_failures WHERE user_id = $1 AND at > now() - make_interval(mins => $2)`, [user.id, WINDOW_MINUTES])).rows[0]!.n;
          if (n >= MAX_FAILURES) {
            await c.query(`UPDATE users SET locked_until = now() + make_interval(mins => $2), version = version + 1, updated_at = now() WHERE id = $1`, [user.id, LOCK_MINUTES]);
            locked = true;
          }
        }
        await writeAudit(c, { actorId: user?.id ?? null, actorName: user?.username ?? input.username, action: 'auth.failed', entity: 'user', entityId: user?.id ?? `unknown:${input.username.toLowerCase()}`, newValue: { why }, requestId: rid });
        if (locked) await writeAudit(c, { actorId: null, actorName: 'system', action: 'auth.locked', entity: 'user', entityId: user!.id, newValue: { minutes: LOCK_MINUTES, after: `${MAX_FAILURES} failed sign-ins within ${WINDOW_MINUTES} minutes` }, requestId: rid });
      });
      // r3-directory (E17): with a directory configured, every account that is not local (or break-glass) signs in there
      const dir = await directoryConfig(pool);   // E31: the site settings, read at each sign-in
      if (dir && (!u || u.auth_source === 'directory')) {
        if (u?.locked_until && u.locked_until > new Date()) throw new HttpError(423, 'locked', `The account is locked until ${u.locked_until.toISOString().slice(11, 16)} UTC, or until an administrator unlocks it.`);
        const id = await directorySignIn(pool, dir, input.username, input.password, rid);
        if (!id) { await fail('wrong directory user name or password', u); throw wrong(); }
        u = (await pool.query<U>('SELECT * FROM users WHERE id = $1', [id])).rows[0];
        if (!u || u.status !== 'active') { await fail('account disabled', u); throw wrong(); }
      } else {
        if (!u || u.status !== 'active') { await fail(!u ? 'unknown user' : 'account disabled', u); throw wrong(); }
        if (u.locked_until && u.locked_until > new Date()) throw new HttpError(423, 'locked', `The account is locked until ${u.locked_until.toISOString().slice(11, 16)} UTC, or until an administrator unlocks it.`);
        if (!(await verifyPassword(input.password, u.password_hash))) { await fail('wrong password', u); throw wrong(); }
      }
      if (!u) throw wrong();
      const user: U = u;
      let mfa = false;
      if (isPrivileged(user.roles) && user.totp_enabled) {
        if (!input.totp) throw new HttpError(401, 'totp_required', 'Enter the code of your authenticator app.');
        if (!verifyTotp(user.totp_secret!, input.totp)) { await fail('wrong authenticator code', user); throw new HttpError(401, 'totp_invalid', 'The authenticator code is not correct.'); }
        mfa = true;
      }
      const s = await withTx(pool, async (c) => {
        await c.query('DELETE FROM login_failures WHERE user_id = $1', [user.id]);
        if (user.locked_until) await c.query('UPDATE users SET locked_until = NULL WHERE id = $1', [user.id]);
        const opened = await openSession(c, user.id, mfa, req.headers['user-agent']);
        await writeAudit(c, { actorId: user.id, actorName: user.username, action: 'auth.signed_in', entity: 'user', entityId: user.id, newValue: { sessionId: opened.id, secondFactor: mfa }, requestId: rid });
        return opened;
      });
      setCookie(res, s.token);
      req.headers.authorization = `Bearer ${s.token}`;
      return me((await sessionOf(pool, req))!);
    },
  }),
  route({
    method: 'GET', path: '/api/auth/me', permission: 'session', summary: 'Who is signed in, with the permissions of this session',
    handler: ({ actor }) => me(actor as SessionActor),
  }),
  route({
    method: 'POST', path: '/api/auth/logout', permission: 'session', summary: 'Sign out: the session is revoked on every server',
    handler: async ({ pool, actor, res }) => {
      const a = actor as SessionActor;
      await withTx(pool, async (c) => {
        await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [a.sessionId]);
        await writeAudit(c, { actorId: a.userId, actorName: a.username, action: 'auth.signed_out', entity: 'user', entityId: a.userId, newValue: { sessionId: a.sessionId }, requestId: String(res.locals.requestId) });
      });
      clearCookie(res);
    },
  }),
  route({
    method: 'POST', path: '/api/auth/password', permission: 'session', summary: 'Change your own password',
    input: strict({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }),
    handler: async ({ pool, actor, input, res }) => {
      const a = actor as SessionActor;
      const u = (await pool.query<U>('SELECT * FROM users WHERE id = $1', [a.userId])).rows[0]!;
      if (!(await verifyPassword(input.current, u.password_hash))) throw new HttpError(401, 'bad_credentials', 'The current password is not correct.');
      const problem = passwordProblem(input.next, u.username) ?? (input.next === input.current ? 'The new password must differ from the current one.' : null);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      const h = await hashPassword(input.next);
      await withTx(pool, async (c) => {
        await c.query('UPDATE users SET password_hash = $2, must_change_password = false, version = version + 1, updated_at = now() WHERE id = $1', [a.userId, h]);
        await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [a.userId, a.sessionId]);
        await writeAudit(c, { actorId: a.userId, actorName: a.username, action: 'auth.password_changed', entity: 'user', entityId: a.userId, requestId: String(res.locals.requestId) });
      });
    },
  }),
  route({
    method: 'POST', path: '/api/auth/totp/enroll', permission: 'session', summary: 'Start setting up the authenticator app (returns the secret once)',
    handler: async ({ pool, actor }) => {
      const a = actor as SessionActor;
      const u = (await pool.query<U>('SELECT * FROM users WHERE id = $1', [a.userId])).rows[0]!;
      if (u.totp_enabled) throw new HttpError(409, 'totp_enabled', 'The authenticator is already set up. An administrator can reset it.');
      const secret = newSecret();
      await pool.query('UPDATE users SET totp_secret = $2 WHERE id = $1', [a.userId, secret]);
      return { secret, otpauthUrl: otpauthUrl(secret, u.username) };
    },
  }),
  route({
    method: 'POST', path: '/api/auth/totp/confirm', permission: 'session', summary: 'Finish setting up the authenticator app with a code from it',
    input: strict({ code: z.string().regex(/^\d{6}$/) }),
    handler: async ({ pool, actor, input, res }) => {
      const a = actor as SessionActor;
      const u = (await pool.query<U>('SELECT * FROM users WHERE id = $1', [a.userId])).rows[0]!;
      if (!u.totp_secret || u.totp_enabled) throw new HttpError(409, 'totp_state', 'Start the set-up first.');
      if (!verifyTotp(u.totp_secret, input.code)) throw new HttpError(400, 'totp_invalid', 'The code is not correct. Check the time on the phone and try again.');
      await withTx(pool, async (c) => {
        await c.query('UPDATE users SET totp_enabled = true, version = version + 1, updated_at = now() WHERE id = $1', [a.userId]);
        await c.query('UPDATE sessions SET mfa = true WHERE id = $1', [a.sessionId]);
        await writeAudit(c, { actorId: a.userId, actorName: a.username, action: 'auth.totp_enabled', entity: 'user', entityId: a.userId, requestId: String(res.locals.requestId) });
      });
    },
  }),
];
