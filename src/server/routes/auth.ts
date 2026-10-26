// Domain: auth (roadmap M05). Sign-in with password, TOTP and recovery codes; enrolment; sessions; re-authentication; password change.
// Three routes are public (login-local, totp-setup, totp-verify); every other route here runs behind the session check of src/server/auth/requireAuth.ts.
import { randomUUID } from 'crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { authChallenges, passwordHistory, users } from '../../db/schema';
import { generatePasswordHash, verifyPassword, writeAudit } from '../../db/utils';
import { changePasswordSchema, loginSchema, passwordOnlySchema, reauthSchema, totpConfirmSchema, totpSetupSchema, totpVerifySchema } from '../../lib/validations/auth';
import { authenticatePrincipal } from '../auth/directory';
import { isDirectoryAccount, verifyDirectoryPassword } from '../auth/ldap';
import { assertActorPassword } from '../auth/credentials';
import { recordSecurityEvent, SecurityEventType, securityEventContext, writeSecurityEvent, type EventContext } from '../auth/events';
import { loginLockedUntil, recordLoginFailure, resetLoginFailures, secondsUntil } from '../auth/lockout';
import { checkPasswordPolicy } from '../auth/passwordPolicy';
import { selfUser } from '../auth/publicUser';
import { consumeRecoveryCode, generateRecoveryCodes, storeRecoveryCodes } from '../auth/recovery';
import { createRequireAuth } from '../auth/requireAuth';
import { createSession, restartIdleClock, revokeSession, revokeUserSessions, type AuthMethod, type SessionRow, type UserRow } from '../auth/sessions';
import { loadSecuritySettings, type SecuritySettings } from '../auth/settings';
import { CHALLENGE_TTL_SECONDS, signAccessToken, signChallengeToken, TokenError, verifyChallengeToken } from '../auth/tokens';
import { acceptTotpStep, checkTotp, KeystoreError, newTotpSecret, openTotpSecret, otpauthUri, qrDataUrl, sealTotpSecret } from '../auth/totp';
import { addPasswordHistory } from '../auth/users';
import { type RouteContext } from '../core/context';
import { log, serializeError } from '../core/logger';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, type Executor, type Tx } from '../core/tx';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';

/** Thrown inside a sign-in transaction to roll it back when the second step is refused. */
class StepRefused extends Error {
  constructor(readonly kind: 'totp' | 'recovery') { super('second step refused'); }
}

const iso = (d: Date) => d.toISOString();

export const authRoutes = ({ db }: RouteContext) => {
  const router = createRouter();
  const sessionAuth = createRequireAuth(db);
  const selfServiceAuth = createRequireAuth(db, { allowPasswordChangePending: true });
  const lenientAuth = createRequireAuth(db, { allowIdle: true, allowPasswordChangePending: true });

  // --- helpers -------------------------------------------------------------------------------------------------------

  const sessionInfo = (s: Pick<SessionRow, 'id' | 'expiresAt' | 'lastSeenAt'>, settings: SecuritySettings) => ({
    id: s.id,
    idleTimeoutMinutes: settings.sessionTimeoutMinutes,
    idleExpiresAt: iso(new Date(s.lastSeenAt.getTime() + settings.sessionTimeoutMinutes * 60_000)),
    expiresAt: iso(s.expiresAt),
  });

  /** Creates the session and its audit entry in `tx` and builds the sign-in response. */
  async function startSession(tx: Tx, user: UserRow, settings: SecuritySettings, method: AuthMethod, context: EventContext) {
    const created = await createSession(tx, { userId: user.id, authMethod: method, absoluteHours: settings.sessionAbsoluteHours });
    await writeSecurityEvent(tx, { type: SecurityEventType.LOGIN, outcome: 'success', actorId: user.id, actorRole: user.role, ...context, sessionId: created.id, detail: { method } });
    const self = selfUser(user, settings);
    return {
      token: signAccessToken({ userId: user.id, sessionId: created.id, expiresAt: created.expiresAt, display: user }),
      user: self,
      mustChangePassword: self.mustChangePassword,
      session: sessionInfo({ id: created.id, expiresAt: created.expiresAt, lastSeenAt: new Date() }, settings),
    };
  }

  /** A pending second step: a single-use row plus a token that names it. */
  async function issueChallenge(ex: Executor, userId: string, purpose: 'mfa' | 'enrol') {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    await ex.delete(authChallenges).where(sql`${authChallenges.expiresAt} < now() - interval '1 day'`);
    await ex.insert(authChallenges).values({ jti, userId, purpose, expiresAt });
    return signChallengeToken(purpose, { userId, jti, expiresAt });
  }

  function challengeClaims(purpose: 'mfa' | 'enrol', token: string) {
    try { return verifyChallengeToken(purpose, token); } catch (e) {
      if (e instanceof TokenError) throw new AppError(401, 'INVALID_TOKEN', 'This sign-in step is not valid. Sign in again.');
      throw e;
    }
  }

  /** The single-use gate: true for exactly one caller. */
  async function consumeChallenge(tx: Tx, jti: string, userId: string, purpose: 'mfa' | 'enrol') {
    const rows = await tx.update(authChallenges).set({ consumedAt: sql`now()` })
      .where(and(eq(authChallenges.jti, jti), eq(authChallenges.userId, userId), eq(authChallenges.purpose, purpose), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, sql`now()`)))
      .returning({ jti: authChallenges.jti });
    if (rows.length !== 1) throw new AppError(401, 'INVALID_TOKEN', 'This sign-in step has expired or was already used. Sign in again.');
  }

  const accountLocked = (res: Response, until: Date) => res.status(401).json({
    error: `This account is locked after repeated failed sign-in attempts. It unlocks by itself in about ${Math.ceil(secondsUntil(until) / 60)} minute(s), or an Administrator can unlock it.`,
    code: 'ACCOUNT_LOCKED',
    retryAfterSeconds: secondsUntil(until),
  });

  async function failedSignIn(req: Request, res: Response, userId: string, settings: SecuritySettings, kind: 'password' | 'totp' | 'recovery', code: string, message: string) {
    const failure = await recordLoginFailure(db, userId, settings, kind, securityEventContext(req));
    return res.status(401).json({
      error: failure.locked ? `${message} The account is now locked for ${settings.lockoutMinutes} minutes.` : message,
      code,
      ...(failure.locked && failure.lockedUntil ? { retryAfterSeconds: secondsUntil(failure.lockedUntil) } : {}),
    });
  }

  async function findUser(id: string): Promise<UserRow | undefined> {
    return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  }

  /** The secret of a user with TOTP on. A value that cannot be decrypted (the key changed) is an operator problem, not a wrong code. */
  function openSecretOrFail(stored: string, userId: string) {
    try { return openTotpSecret(stored, userId); } catch (e) {
      if (e instanceof KeystoreError) {
        log.error({ userId, err: serializeError(e) }, 'stored TOTP secret could not be decrypted');
        throw new AppError(401, 'MFA_SECRET_UNREADABLE', 'The authenticator secret of this account cannot be read. An Administrator must reset its multi-factor authentication.');
      }
      throw e;
    }
  }

  // --- sign-in -------------------------------------------------------------------------------------------------------

  router.post('/auth/login-local', validate(loginSchema), async (req, res) => {
    const { email, password } = req.body;
    const settings = await loadSecuritySettings(db);
    const found = await authenticatePrincipal(db, email, password, securityEventContext(req));
    if (found.kind === 'refused') return res.status(found.status).json({ error: found.message, code: found.code });
    if (found.kind === 'unknown') {
      // Nobody to attribute it to: the typed address is the actor label. (The rate limiter in front bounds how many of these one address can cause.)
      await recordSecurityEvent(db, { type: SecurityEventType.LOGIN_FAILED, outcome: 'failure', actorLabel: email, ...securityEventContext(req), detail: { reason: 'unknown account' } });
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    const user = found.user;
    const lock = loginLockedUntil(user);
    if (lock) return accountLocked(res, lock); // a locked account is refused without looking at the password, and nothing more is counted
    if (found.kind === 'bad-password') return failedSignIn(req, res, user.id, settings, 'password', 'INVALID_CREDENTIALS', 'Invalid credentials.');
    if (!user.active) return res.status(401).json({ error: 'This account is deactivated. Contact an Administrator.', code: 'ACCOUNT_DISABLED' });

    // The password is right. With a second factor pending, the failure count is not reset yet: only a complete sign-in clears it.
    if (user.totpEnabled) return res.json({ requiresTotp: true, tempToken: await issueChallenge(db, user.id, 'mfa') });

    if (settings.mfaRequired) {
      const secret = newTotpSecret();
      await db.update(users).set({ totpPendingSecret: sealTotpSecret(secret, user.id) }).where(eq(users.id, user.id));
      const uri = otpauthUri(user.email ?? user.id, secret);
      return res.json({ requireTotpSetup: true, tempToken: await issueChallenge(db, user.id, 'enrol'), qrCode: await qrDataUrl(uri), secret, otpauthUri: uri });
    }

    const body = await db.transaction(async tx => {
      await resetLoginFailures(tx, user.id);
      return startSession(tx, user, settings, 'password', securityEventContext(req));
    });
    res.json(body);
  });

  router.post('/auth/totp-verify', validate(totpVerifySchema), async (req, res) => {
    const { tempToken, code, recoveryCode } = req.body as { tempToken: string; code?: string; recoveryCode?: string };
    const claims = challengeClaims('mfa', tempToken);
    const user = await findUser(claims.userId);
    if (!user || !user.active || !user.totpEnabled || !user.totpSecret) throw new AppError(401, 'INVALID_TOKEN', 'This sign-in step is not valid. Sign in again.');
    const lock = loginLockedUntil(user);
    if (lock) return accountLocked(res, lock);
    const settings = await loadSecuritySettings(db);

    const opened = openSecretOrFail(user.totpSecret, user.id);
    let step: number | undefined;
    if (code !== undefined) {
      const check = checkTotp(opened.secret, code);
      if (!check.ok) return failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'Invalid authenticator code.');
      step = check.step;
    }

    try {
      const body = await db.transaction(async tx => {
        await consumeChallenge(tx, claims.jti, user.id, 'mfa'); // first: the gate that makes the challenge single-use
        if (code !== undefined) {
          if (!(await acceptTotpStep(tx, user.id, step!))) throw new StepRefused('totp'); // the code (or a later one) was already used: replay
        } else if (!(await consumeRecoveryCode(tx, user.id, recoveryCode!))) {
          throw new StepRefused('recovery');
        }
        if (opened.legacy) await tx.update(users).set({ totpSecret: sealTotpSecret(opened.secret, user.id) }).where(eq(users.id, user.id));
        if (recoveryCode !== undefined) {
          await writeSecurityEvent(tx, { type: SecurityEventType.RECOVERY_CODE_USED, outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req) });
        }
        await resetLoginFailures(tx, user.id);
        return startSession(tx, user, settings, code !== undefined ? 'password+totp' : 'password+recovery', securityEventContext(req));
      });
      res.json(body);
    } catch (e) {
      if (e instanceof StepRefused) {
        return e.kind === 'totp'
          ? failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'This authenticator code was already used. Wait for the next code.')
          : failedSignIn(req, res, user.id, settings, 'recovery', 'INVALID_CODE', 'Invalid recovery code.');
      }
      throw e;
    }
  });

  /** Completes a forced enrolment (the administrator requires MFA and this user has none): confirms the first code, then signs in. */
  router.post('/auth/totp-setup', validate(totpSetupSchema), async (req, res) => {
    const { tempToken, code } = req.body as { tempToken: string; code: string };
    const claims = challengeClaims('enrol', tempToken);
    const user = await findUser(claims.userId);
    if (!user || !user.active || user.totpEnabled || !user.totpPendingSecret) throw new AppError(401, 'INVALID_TOKEN', 'This enrolment step is not valid. Sign in again.');
    const lock = loginLockedUntil(user);
    if (lock) return accountLocked(res, lock);
    const settings = await loadSecuritySettings(db);

    const opened = openSecretOrFail(user.totpPendingSecret, user.id);
    const check = checkTotp(opened.secret, code);
    if (!check.ok) return failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'Invalid authenticator code.');

    const body = await db.transaction(async tx => {
      await consumeChallenge(tx, claims.jti, user.id, 'enrol');
      await tx.update(users).set({
        totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true, totpEnrolledAt: new Date(), totpLastStep: check.step,
      }).where(eq(users.id, user.id));
      const recoveryCodes = generateRecoveryCodes();
      await storeRecoveryCodes(tx, user.id, recoveryCodes);
      await writeAudit(tx, user.id, 'TotpEnrolled', 'User', user.id, 'mfa', JSON.stringify({ enabled: false }), JSON.stringify({ enabled: true }), 'Multi-factor authentication enrolled at sign-in');
      await resetLoginFailures(tx, user.id);
      return { ...(await startSession(tx, { ...user, totpEnabled: true }, settings, 'password+totp', securityEventContext(req))), recoveryCodes };
    });
    res.json(body);
  });

  // --- the signed-in user ----------------------------------------------------------------------------------------------

  router.get('/auth/me', selfServiceAuth, async (req, res) => {
    const settings = await loadSecuritySettings(db);
    const self = selfUser((req as any).user, settings);
    res.json({ user: self, mustChangePassword: self.mustChangePassword, session: sessionInfo(req.authSession!, settings) });
  });

  router.post('/auth/logout', lenientAuth, async (req, res) => {
    const user: UserRow = (req as any).user;
    await db.transaction(async tx => {
      if (await revokeSession(tx, req.authSession!.id, 'logout')) {
        await writeSecurityEvent(tx, { type: SecurityEventType.LOGOUT, outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req), sessionId: req.authSession!.id });
      }
    });
    res.json({ success: true });
  });

  /**
   * Proves the user is still there after an idle lock (password, plus an authenticator code when MFA is on) and keeps the
   * session id: the page stays mounted and unsaved work is not lost. The absolute limit is not extended.
   */
  router.post('/auth/reauth', lenientAuth, validate(reauthSchema), async (req, res) => {
    const user: UserRow = (req as any).user;
    const { password, code, recoveryCode } = req.body as { password: string; code?: string; recoveryCode?: string };
    const lock = loginLockedUntil(user);
    if (lock) return accountLocked(res, lock);
    const settings = await loadSecuritySettings(db);
    const viaDirectory = await verifyDirectoryPassword(db, user, password); // null = a local account
    if (viaDirectory === 'unavailable') return res.status(503).json({ error: 'Directory sign-on is not available right now. Try again later.', code: 'DIRECTORY_UNAVAILABLE' });
    if (viaDirectory === null ? !verifyPassword(password, user.passwordHash) : viaDirectory !== 'ok') return failedSignIn(req, res, user.id, settings, 'password', 'INVALID_CREDENTIALS', 'Invalid credentials.');

    let step: number | undefined;
    let opened: ReturnType<typeof openTotpSecret> | undefined;
    if (user.totpEnabled && user.totpSecret) {
      if (code === undefined && recoveryCode === undefined) return res.status(401).json({ error: 'An authenticator code is required.', code: 'MFA_CODE_REQUIRED' });
      opened = openSecretOrFail(user.totpSecret, user.id);
      if (code !== undefined) {
        const check = checkTotp(opened.secret, code);
        if (!check.ok) return failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'Invalid authenticator code.');
        step = check.step;
      }
    }

    try {
      const session = req.authSession!;
      const body = await db.transaction(async tx => {
        if (step !== undefined) {
          if (!(await acceptTotpStep(tx, user.id, step))) throw new StepRefused('totp');
        } else if (recoveryCode !== undefined && !(await consumeRecoveryCode(tx, user.id, recoveryCode))) {
          throw new StepRefused('recovery');
        }
        if (opened?.legacy) await tx.update(users).set({ totpSecret: sealTotpSecret(opened.secret, user.id) }).where(eq(users.id, user.id));
        await restartIdleClock(tx, session.id);
        await resetLoginFailures(tx, user.id);
        await writeSecurityEvent(tx, { type: SecurityEventType.REAUTH, outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req), sessionId: session.id });
        const self = selfUser(user, settings);
        return {
          token: signAccessToken({ userId: user.id, sessionId: session.id, expiresAt: session.expiresAt, display: user }),
          user: self, mustChangePassword: self.mustChangePassword,
          session: sessionInfo({ id: session.id, expiresAt: session.expiresAt, lastSeenAt: new Date() }, settings),
        };
      });
      res.json(body);
    } catch (e) {
      if (e instanceof StepRefused) {
        return e.kind === 'totp'
          ? failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'This authenticator code was already used. Wait for the next code.')
          : failedSignIn(req, res, user.id, settings, 'recovery', 'INVALID_CODE', 'Invalid recovery code.');
      }
      throw e;
    }
  });

  router.post('/auth/change-password', selfServiceAuth, validate(changePasswordSchema), async (req, res) => {
    const user: UserRow = (req as any).user;
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    if (await isDirectoryAccount(db, user.id)) throw new AppError(409, 'DIRECTORY_MANAGED', 'This account signs in with the directory password: change it in the directory.');
    const lock = loginLockedUntil(user);
    if (lock) return accountLocked(res, lock);
    const settings = await loadSecuritySettings(db);
    if (!verifyPassword(currentPassword, user.passwordHash)) return failedSignIn(req, res, user.id, settings, 'password', 'INVALID_PASSWORD', 'The current password is not correct.');

    const history = await db.select({ passwordHash: passwordHistory.passwordHash }).from(passwordHistory)
      .where(eq(passwordHistory.userId, user.id)).orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id)).limit(Math.max(settings.passwordHistoryCount, 1));
    const recentHashes = [user.passwordHash, ...history.map(h => h.passwordHash)].filter((h, i, all): h is string => !!h && all.indexOf(h) === i);
    const problems = checkPasswordPolicy(newPassword, { settings, email: user.email, name: user.name, recentHashes });
    if (settings.passwordHistoryCount === 0 && verifyPassword(newPassword, user.passwordHash)) problems.push('The new password must differ from the current one.');
    if (problems.length) throw new AppError(400, 'PASSWORD_POLICY', problems.join(' '), problems.map(message => ({ path: 'newPassword', message })));

    await db.transaction(async tx => {
      const row = await lockRow(tx, users, user.id);
      const passwordHash = generatePasswordHash(newPassword);
      await updateVersioned(tx, users, user.id, row.version, {
        passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, loginFailedAttempts: 0, loginLockedUntil: null,
      });
      await addPasswordHistory(tx, user.id, passwordHash);
      const ended = await revokeUserSessions(tx, user.id, 'password changed', req.authSession!.id);
      await writeAudit(tx, user.id, 'PasswordChanged', 'User', user.id, 'password', 'set', JSON.stringify({ otherSessionsEnded: ended }),
        user.mustChangePassword ? 'Password changed at first sign-in' : 'Password changed by the user');
      await writeSecurityEvent(tx, { type: SecurityEventType.PASSWORD_CHANGED, outcome: 'success', actorId: user.id, actorRole: user.role, ...securityEventContext(req), detail: { otherSessionsEnded: ended } });
    });
    res.json({ success: true });
  });

  // --- multi-factor enrolment from inside a session ------------------------------------------------------------------------

  router.post('/auth/totp-enroll', sessionAuth, validate(passwordOnlySchema), async (req, res) => {
    const user: UserRow = (req as any).user;
    await assertActorPassword(db, user, req.body.password, { entity: 'User', entityId: user.id, what: 'multi-factor enrolment' }, securityEventContext(req));
    if (user.totpEnabled) throw new AppError(409, 'MFA_ALREADY_ENROLLED', 'Multi-factor authentication is already set up. Ask an Administrator to reset it first.');
    const secret = newTotpSecret();
    await db.update(users).set({ totpPendingSecret: sealTotpSecret(secret, user.id) }).where(eq(users.id, user.id));
    const uri = otpauthUri(user.email ?? user.id, secret);
    res.json({ secret, otpauthUri: uri, qrCode: await qrDataUrl(uri) });
  });

  router.post('/auth/totp-confirm', sessionAuth, validate(totpConfirmSchema), async (req, res) => {
    const user: UserRow = (req as any).user;
    if (user.totpEnabled || !user.totpPendingSecret) throw new AppError(409, 'NO_ENROLMENT', 'There is no multi-factor enrolment in progress. Start one first.');
    const settings = await loadSecuritySettings(db);
    const opened = openSecretOrFail(user.totpPendingSecret, user.id);
    const check = checkTotp(opened.secret, req.body.code);
    if (!check.ok) return failedSignIn(req, res, user.id, settings, 'totp', 'INVALID_CODE', 'Invalid authenticator code.');

    const recoveryCodes = generateRecoveryCodes();
    await db.transaction(async tx => {
      await tx.update(users).set({
        totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true, totpEnrolledAt: new Date(), totpLastStep: check.step,
      }).where(eq(users.id, user.id));
      await storeRecoveryCodes(tx, user.id, recoveryCodes);
      const ended = await revokeUserSessions(tx, user.id, 'multi-factor enrolled', req.authSession!.id);
      await writeAudit(tx, user.id, 'TotpEnrolled', 'User', user.id, 'mfa', JSON.stringify({ enabled: false }), JSON.stringify({ enabled: true, otherSessionsEnded: ended }), 'Multi-factor authentication enrolled by the user');
    });
    res.json({ success: true, recoveryCodes });
  });

  router.post('/auth/recovery-codes', sessionAuth, validate(passwordOnlySchema), async (req, res) => {
    const user: UserRow = (req as any).user;
    await assertActorPassword(db, user, req.body.password, { entity: 'User', entityId: user.id, what: 'recovery code regeneration' }, securityEventContext(req));
    if (!user.totpEnabled) throw new AppError(409, 'MFA_NOT_ENROLLED', 'Recovery codes belong to multi-factor authentication, which is not set up.');
    const recoveryCodes = generateRecoveryCodes();
    await db.transaction(async tx => {
      await storeRecoveryCodes(tx, user.id, recoveryCodes);
      await writeAudit(tx, user.id, 'RecoveryCodesRegenerated', 'User', user.id, 'mfa', '', '', 'Recovery codes replaced by the user');
    });
    res.json({ recoveryCodes });
  });

  return router;
};
