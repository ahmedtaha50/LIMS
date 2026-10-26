/**
 * The two lockouts (roadmap M05), kept apart because they answer different questions:
 *   sign-in lock   users.login_failed_attempts / login_locked_until   wrong password or wrong second factor at sign-in
 *   signing lock   users.failed_attempts / locked_at                   wrong password when signing or authorising a change
 * Both end by themselves after `lockoutMinutes`; neither touches users.active (an administrator's decision). A wrong e-signature
 * password used to set locked_at, and sign-in refused any non-null locked_at for ever.
 * The failure bookkeeping runs in its own transaction, with its audit entry, and is committed before the caller answers with an
 * error: a transaction that is about to throw would roll the counter back.
 */
import { eq, sql } from 'drizzle-orm';
import { users } from '../../db/schema';
import type { Db } from '../core/context';
import { lockRow, type Executor } from '../core/tx';
import { writeAudit } from '../../db/utils';
import { SecurityEventType, writeSecurityEvent, type EventContext } from './events';
import type { SecuritySettings } from './settings';

/** E-signature password failures allowed before signing is locked. */
export const SIGNING_MAX_ATTEMPTS = 3;

type LockFields = Pick<typeof users.$inferSelect, 'loginLockedUntil' | 'lockedAt'>;

export function loginLockedUntil(user: Pick<LockFields, 'loginLockedUntil'>, now = new Date()): Date | null {
  return user.loginLockedUntil && user.loginLockedUntil > now ? user.loginLockedUntil : null;
}

export function signingLockedUntil(user: Pick<LockFields, 'lockedAt'>, now = new Date()): Date | null {
  return user.lockedAt && user.lockedAt > now ? user.lockedAt : null;
}

export const secondsUntil = (when: Date, now = new Date()) => Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 1000));

export interface LoginFailure { attempts: number; locked: boolean; lockedUntil: Date | null }

/** Counts one failed sign-in (`kind`: password, second-factor code or recovery code) for an existing account. */
export async function recordLoginFailure(db: Db, userId: string, settings: SecuritySettings, kind: 'password' | 'totp' | 'recovery', context: Partial<EventContext> = {}): Promise<LoginFailure> {
  return db.transaction(async tx => {
    const u = await lockRow(tx, users, userId); // serialises parallel failures: the count is exact
    const now = new Date();
    const alreadyLocked = loginLockedUntil(u, now) !== null;
    const attempts = u.loginLockedUntil && !alreadyLocked ? 1 : u.loginFailedAttempts + 1; // a lock that has ended starts a new count
    const lockNow = !alreadyLocked && attempts >= settings.maxFailedLogins;
    const lockedUntil = alreadyLocked ? u.loginLockedUntil : lockNow ? new Date(now.getTime() + settings.lockoutMinutes * 60_000) : null;
    await tx.update(users).set({ loginFailedAttempts: attempts, loginLockedUntil: lockedUntil }).where(eq(users.id, userId));
    await writeSecurityEvent(tx, {
      type: kind === 'password' ? SecurityEventType.LOGIN_FAILED : SecurityEventType.MFA_FAILED, outcome: 'failure',
      actorId: userId, actorRole: u.role, ...context, detail: { kind, attempts },
    });
    if (lockNow) {
      await writeSecurityEvent(tx, {
        type: SecurityEventType.LOCKOUT, outcome: 'info', actorId: userId, actorRole: u.role, ...context,
        detail: { scope: 'sign-in', attempts, until: lockedUntil!.toISOString(), minutes: settings.lockoutMinutes },
      });
    }
    return { attempts, locked: lockedUntil !== null, lockedUntil };
  });
}

export async function resetLoginFailures(ex: Executor, userId: string): Promise<void> {
  await ex.update(users).set({ loginFailedAttempts: 0, loginLockedUntil: null })
    .where(sql`${users.id} = ${userId} and (${users.loginFailedAttempts} <> 0 or ${users.loginLockedUntil} is not null)`);
}

export interface SigningFailure { attempts: number; locked: boolean; remaining: number }

/** Counts one wrong e-signature (or re-entered) password. `entity` / `entityId` / `what` say what was being signed, for the audit entry. */
export async function recordSigningFailure(
  db: Db, userId: string, settings: SecuritySettings, ctx: { entity: string; entityId: string; what: string }, context: Partial<EventContext> = {},
): Promise<SigningFailure> {
  return db.transaction(async tx => {
    const u = await lockRow(tx, users, userId);
    const now = new Date();
    const alreadyLocked = signingLockedUntil(u, now) !== null;
    const attempts = u.lockedAt && !alreadyLocked ? 1 : u.failedAttempts + 1;
    const lockNow = !alreadyLocked && attempts >= SIGNING_MAX_ATTEMPTS;
    const lockedAt = alreadyLocked ? u.lockedAt : lockNow ? new Date(now.getTime() + settings.lockoutMinutes * 60_000) : null;
    await tx.update(users).set({ failedAttempts: attempts, lockedAt }).where(eq(users.id, userId));
    await writeAudit(tx, userId, 'SignatureFailed', ctx.entity, ctx.entityId, 'signature', '', '',
      `Failed password verification for ${ctx.what} (Attempt ${Math.min(attempts, SIGNING_MAX_ATTEMPTS)}/${SIGNING_MAX_ATTEMPTS})`);
    if (lockNow) {
      await writeSecurityEvent(tx, {
        type: SecurityEventType.LOCKOUT, outcome: 'info', actorId: userId, actorRole: u.role, ...context,
        detail: { scope: 'signing', attempts, until: lockedAt!.toISOString(), minutes: settings.lockoutMinutes },
      });
    }
    return { attempts, locked: lockedAt !== null, remaining: Math.max(0, SIGNING_MAX_ATTEMPTS - attempts) };
  });
}

export async function clearSigningFailures(ex: Executor, userId: string): Promise<void> {
  await ex.update(users).set({ failedAttempts: 0, lockedAt: null }).where(eq(users.id, userId));
}
