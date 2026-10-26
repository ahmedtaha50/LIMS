/**
 * Re-entry of the acting user's password for an action that needs one (administrator changes, certifying training, enabling AI).
 * A wrong password counts toward the signing lock, committed and audited before the error goes out; a locked user is refused
 * without the password being looked at; a right password clears the count.
 */
import { verifyPassword } from '../../db/utils';
import type { Db } from '../core/context';
import { AppError } from '../http/errors';
import type { EventContext } from './events';
import { verifyDirectoryPassword } from './ldap';
import { clearSigningFailures, recordSigningFailure, secondsUntil, signingLockedUntil } from './lockout';
import type { UserRow } from './sessions';
import { loadSecuritySettings } from './settings';

export async function assertActorPassword(db: Db, user: UserRow, password: string, ctx: { entity: string; entityId: string; what: string }, context: Partial<EventContext> = {}): Promise<void> {
  const locked = signingLockedUntil(user);
  if (locked) {
    const minutes = Math.ceil(secondsUntil(locked) / 60);
    throw new AppError(401, 'SIGNING_LOCKED', `Signing is locked after repeated wrong passwords. It unlocks by itself in about ${minutes} minute(s), or an Administrator can unlock it.`);
  }
  const viaDirectory = await verifyDirectoryPassword(db, user, password); // null = a local account
  if (viaDirectory === 'unavailable') throw new AppError(503, 'DIRECTORY_UNAVAILABLE', 'Directory sign-on is not available right now, so the password cannot be checked. Try again later.');
  if (viaDirectory === null ? !verifyPassword(password, user.passwordHash) : viaDirectory !== 'ok') {
    const settings = await loadSecuritySettings(db);
    const failure = await recordSigningFailure(db, user.id, settings, ctx, context);
    throw new AppError(401, 'INVALID_PASSWORD', failure.locked
      ? `Invalid password. Signing is locked for ${settings.lockoutMinutes} minutes.`
      : `Invalid password. ${failure.remaining} attempt(s) remaining.`);
  }
  if (user.failedAttempts > 0 || user.lockedAt) await clearSigningFailures(db, user.id);
}
