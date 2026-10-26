/**
 * What may leave the server about a user. Every route that returns users goes through one of these projections, which name the
 * fields they allow; nothing is "all columns except the hash", so a column added later is private until someone decides otherwise.
 * (The old /training and /admin/users returned the TOTP secret and the lockout counters.)
 */
import { loginLockedUntil, signingLockedUntil } from './lockout';
import type { UserRow } from './sessions';
import type { SecuritySettings } from './settings';

export interface PublicUser { id: string; name: string; email: string | null; role: string; active: boolean; hasCompletedSoftwareTraining: boolean }

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, hasCompletedSoftwareTraining: u.hasCompletedSoftwareTraining,
});

/** The training matrix shows who is certified, nothing else. */
export const trainingUser = (u: UserRow) => ({ id: u.id, name: u.name, role: u.role, hasCompletedSoftwareTraining: u.hasCompletedSoftwareTraining });

export function passwordExpiresAt(u: UserRow, settings: Pick<SecuritySettings, 'passwordExpiryDays'>): Date {
  const changed = new Date(u.passwordChangedAt ?? u.createdAt);
  return new Date(changed.getTime() + settings.passwordExpiryDays * 86_400_000);
}

/** A temporary password or an expired one must be replaced before anything else is allowed. */
export function passwordChangeRequired(u: UserRow, settings: Pick<SecuritySettings, 'passwordExpiryDays'>, now = new Date()): boolean {
  return u.mustChangePassword || passwordExpiresAt(u, settings) < now;
}

/** The signed-in user's own view (/auth/me and the sign-in responses). */
export const selfUser = (u: UserRow, settings: SecuritySettings) => ({
  ...publicUser(u),
  mfaEnabled: u.totpEnabled,
  mustChangePassword: passwordChangeRequired(u, settings),
  passwordExpiresAt: passwordExpiresAt(u, settings).toISOString(),
});

/** Administrators and QA: account state without secrets or counters. */
export function adminUser(u: UserRow) {
  const login = loginLockedUntil(u);
  const signing = signingLockedUntil(u);
  return {
    ...publicUser(u),
    uid: u.uid,
    mfaEnabled: u.totpEnabled,
    mustChangePassword: u.mustChangePassword,
    locked: login !== null || signing !== null,
    lockedUntil: (login ?? signing)?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    passwordChangedAt: u.passwordChangedAt ? u.passwordChangedAt.toISOString() : null,
    version: u.version,
  };
}
