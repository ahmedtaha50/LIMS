/**
 * Account lifecycle shared by the administrator routes and the break-glass CLI: create, reset password, unlock, reset MFA.
 * Each function runs inside the caller's transaction and writes its audit entry there, so the change and its record commit
 * or roll back together. `actor` is a user id, or `cli:<operating-system user>` for the CLI. `expectedVersion` is the optimistic
 * concurrency check; the CLI, which has no version to show an operator, passes none and takes the version it reads under lock.
 */
import { randomBytes } from 'crypto';
import { sql } from 'drizzle-orm';
import { passwordHistory, users } from '../../db/schema';
import { generatePasswordHash } from '../../db/utils';
import { lockRow, updateVersioned, type Tx } from '../core/tx';
import type { UserRole as Role } from '../../lib/validations/admin';
import { AppError } from '../http/errors';
import { writeAudit } from '../../db/utils';
import { checkPasswordPolicy, generateTemporaryPassword } from './passwordPolicy';
import { isDirectoryAccount } from './ldap';
import { clearRecoveryCodes } from './recovery';
import { revokeUserSessions, type UserRow } from './sessions';
import type { SecuritySettings } from './settings';

const versionFor = (row: UserRow, expectedVersion?: number) => expectedVersion ?? row.version;

export async function addPasswordHistory(tx: Tx, userId: string, passwordHash: string) {
  await tx.insert(passwordHistory).values({ id: `pwh-${randomBytes(8).toString('hex')}`, userId, passwordHash });
}

/** Creates an account whose password must be changed at the first sign-in. Returns the generated temporary password (shown once) unless one was supplied. */
export async function createUser(
  tx: Tx, actor: string, settings: SecuritySettings,
  input: { name: string; email: string; role: Role; reason: string; password?: string },
): Promise<{ user: UserRow; temporaryPassword: string | null }> {
  const email = input.email.trim().toLowerCase();
  const taken = await tx.execute(sql`select 1 from users where lower(email) = ${email} limit 1`);
  if ((taken as any).rows.length > 0) throw new AppError(409, 'EMAIL_IN_USE', 'Another account already uses this e-mail address.');

  const generated = input.password === undefined;
  const password = input.password ?? generateTemporaryPassword();
  if (!generated) {
    const problems = checkPasswordPolicy(password, { settings, email, name: input.name });
    if (problems.length) throw new AppError(400, 'PASSWORD_POLICY', problems.join(' '), problems.map(message => ({ path: 'password', message })));
  }

  const id = `usr-${randomBytes(4).toString('hex')}`;
  const passwordHash = generatePasswordHash(password);
  let user: UserRow;
  try {
    [user] = await tx.insert(users).values({
      id, uid: `local-${randomBytes(4).toString('hex')}`, name: input.name, email, role: input.role, passwordHash, mustChangePassword: true, hasCompletedSoftwareTraining: false,
    }).returning();
  } catch (e: any) {
    // Two administrators creating the same address at the same moment: the check above passed for both, the unique index decides.
    if ((e?.cause?.code ?? e?.code) === '23505') throw new AppError(409, 'EMAIL_IN_USE', 'Another account already uses this e-mail address.');
    throw e;
  }
  await addPasswordHistory(tx, id, passwordHash);
  await writeAudit(tx, actor, 'Create', 'User', id, 'account', '',
    JSON.stringify({ name: input.name, email, role: input.role, active: true, mustChangePassword: true }), input.reason);
  return { user, temporaryPassword: generated ? password : null };
}

/** A new temporary password, a forced change, no sessions left, the sign-in lock cleared. */
export async function resetPassword(tx: Tx, actor: string, userId: string, input: { reason: string; expectedVersion?: number }) {
  const row = await lockRow(tx, users, userId);
  if (await isDirectoryAccount(tx, userId)) throw new AppError(409, 'DIRECTORY_MANAGED', 'This account signs in with the directory password: it is reset in the directory.');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = generatePasswordHash(temporaryPassword);
  const user = await updateVersioned(tx, users, userId, versionFor(row, input.expectedVersion), {
    passwordHash, passwordChangedAt: new Date(), mustChangePassword: true, loginFailedAttempts: 0, loginLockedUntil: null,
  });
  await addPasswordHistory(tx, userId, passwordHash);
  const ended = await revokeUserSessions(tx, userId, 'password reset');
  await writeAudit(tx, actor, 'PasswordReset', 'User', userId, 'password', 'set', JSON.stringify({ temporary: true, sessionsEnded: ended }), input.reason);
  return { user, temporaryPassword };
}

/** Clears the sign-in lock and the signing lock. */
export async function unlockUser(tx: Tx, actor: string, userId: string, input: { reason: string; expectedVersion?: number }) {
  const row = await lockRow(tx, users, userId);
  const user = await updateVersioned(tx, users, userId, versionFor(row, input.expectedVersion), {
    loginFailedAttempts: 0, loginLockedUntil: null, failedAttempts: 0, lockedAt: null,
  });
  await writeAudit(tx, actor, 'Unlock', 'User', userId, 'locks',
    JSON.stringify({ signInAttempts: row.loginFailedAttempts, signingAttempts: row.failedAttempts }), JSON.stringify({ signInAttempts: 0, signingAttempts: 0 }), input.reason);
  return user;
}

/** Removes the authenticator and the recovery codes (a lost phone). The user enrols again at the next sign-in or from their profile. */
export async function resetMfa(tx: Tx, actor: string, userId: string, input: { reason: string; expectedVersion?: number }) {
  const row = await lockRow(tx, users, userId);
  const user = await updateVersioned(tx, users, userId, versionFor(row, input.expectedVersion), {
    totpSecret: null, totpPendingSecret: null, totpEnabled: false, totpLastStep: null, totpEnrolledAt: null,
  });
  await clearRecoveryCodes(tx, userId);
  await revokeUserSessions(tx, userId, 'MFA reset');
  await writeAudit(tx, actor, 'MfaReset', 'User', userId, 'mfa', JSON.stringify({ enabled: row.totpEnabled }), JSON.stringify({ enabled: false }), input.reason);
  return user;
}
