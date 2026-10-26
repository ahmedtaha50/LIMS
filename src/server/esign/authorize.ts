/**
 * Everything that must be true before a signature is made, in one place and in one order (21 CFR 11.200, 11.300):
 *
 *   1. the signer exists and is active                          401 USER_INACTIVE
 *   2. the role may use the meaning                              403 ROLE_NOT_ALLOWED      (not a credential failure: nothing is counted)
 *   3. a reason is given where the meaning requires one          400 REASON_REQUIRED
 *   4. signing is not locked                                     401 SIGNING_LOCKED
 *   5. the software training is complete, unless the meaning is  403 TRAINING_REQUIRED     (the exemption belongs to the meaning in the
 *      one of the training meanings                                                         catalog, never to a flag the caller passes)
 *   6. the password is right (local hash, or the directory for  401 INVALID_PASSWORD      (counted; directory down: 503 DIRECTORY_UNAVAILABLE, not counted)
 *      a directory account)
 *   7. if the signer has an authenticator: a current code that    401 MFA_CODE_REQUIRED    (missing code: not counted)
 *      has not been used before                                  401 INVALID_CODE          (wrong or replayed: counted)
 *
 * A counted failure is committed in its own transaction with its SignatureFailed audit entry before the error is thrown
 * (recordSigningFailure, r1-identity), so it survives whatever the caller's transaction does next. This runs before the
 * transaction of the change is opened: nothing the caller does can roll the count back, and no connection waits for another.
 */
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import { verifyPassword } from '../../db/utils';
import type { Db } from '../core/context';
import { AppError } from '../http/errors';
import { clearSigningFailures, recordSigningFailure, secondsUntil, signingLockedUntil } from '../auth/lockout';
import type { EventContext } from '../auth/events';
import type { UserRow } from '../auth/sessions';
import { loadSecuritySettings } from '../auth/settings';
import { verifyDirectoryPassword } from '../auth/ldap';
import { acceptTotpStep, checkTotp, KeystoreError, openTotpSecret } from '../auth/totp';
import { MIN_REASON_LENGTH, type Meaning } from './meanings';

export interface SigningCredentials {
  password: string;
  /** The 6-digit authenticator code; required when the signer has an authenticator. */
  totpCode?: string;
}

export type AuthMethod = 'password' | 'password+totp';

export interface AuthorizeInput {
  db: Db;
  userId: string;
  meaning: Meaning;
  credentials: SigningCredentials;
  reason?: string;
  entityType: string;
  entityId: string;
  context?: Partial<EventContext>;
}

export async function authorizeSigner(input: AuthorizeInput): Promise<{ signer: UserRow; authMethod: AuthMethod }> {
  const { db, meaning, credentials } = input;
  const [signer] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!signer || !signer.active) throw new AppError(401, 'USER_INACTIVE', 'User inactive or missing from the identity store.');

  if (!meaning.allowedRoles.includes(signer.role)) {
    throw new AppError(403, 'ROLE_NOT_ALLOWED', `The role ${signer.role} may not sign with this meaning (${meaning.code}).`);
  }
  if (meaning.requiresReason && (input.reason ?? '').trim().length < MIN_REASON_LENGTH) {
    throw new AppError(400, 'REASON_REQUIRED', `A reason of at least ${MIN_REASON_LENGTH} characters is required for this signature.`);
  }
  const locked = signingLockedUntil(signer);
  if (locked) {
    const minutes = Math.ceil(secondsUntil(locked) / 60);
    throw new AppError(401, 'SIGNING_LOCKED', `Signing is locked after repeated wrong passwords. It unlocks by itself in about ${minutes} minute(s), or an Administrator can unlock it.`);
  }
  if (!meaning.trainingExempt && !signer.hasCompletedSoftwareTraining) {
    throw new AppError(403, 'TRAINING_REQUIRED', 'GxP Guardrail: Electronic signatures are disabled because you have not completed the required Software Training. Please contact QA.');
  }

  const fail = async (code: 'INVALID_PASSWORD' | 'INVALID_CODE', what: string, text: string): Promise<never> => {
    const settings = await loadSecuritySettings(db);
    const failure = await recordSigningFailure(db, signer.id, settings, { entity: input.entityType, entityId: input.entityId, what: `${meaning.code} on ${input.entityType} (${what})` }, input.context ?? {});
    throw new AppError(401, code, failure.locked
      ? `${text} Signing is locked for ${settings.lockoutMinutes} minutes.`
      : `${text} ${failure.remaining} attempt(s) remaining.`);
  };

  // A directory account's password is checked in the directory, again at each signature: a person disabled since sign-in cannot sign.
  // An unreachable directory is not a wrong password and counts nothing. The authenticator code below applies to every account.
  const viaDirectory = typeof credentials.password === 'string' ? await verifyDirectoryPassword(db, signer, credentials.password) : null;
  if (viaDirectory === 'unavailable') throw new AppError(503, 'DIRECTORY_UNAVAILABLE', 'Directory sign-on is not available right now, so the signature cannot be made. Try again later.');
  if (typeof credentials.password !== 'string' || (viaDirectory === null ? !verifyPassword(credentials.password, signer.passwordHash) : viaDirectory !== 'ok')) {
    return fail('INVALID_PASSWORD', 'password', 'Invalid password for electronic signature.');
  }

  let authMethod: AuthMethod = 'password';
  if (signer.totpEnabled) {
    if (!credentials.totpCode) throw new AppError(401, 'MFA_CODE_REQUIRED', 'Enter the 6-digit code from your authenticator app to sign.');
    if (!signer.totpSecret) throw new AppError(401, 'MFA_SECRET_UNREADABLE', 'Your authenticator secret could not be read. Ask an Administrator to reset your authenticator.');
    let secret: string;
    try { secret = openTotpSecret(signer.totpSecret, signer.id).secret; } catch (e) {
      if (e instanceof KeystoreError) throw new AppError(401, 'MFA_SECRET_UNREADABLE', 'Your authenticator secret could not be read. Ask an Administrator to reset your authenticator.');
      throw e;
    }
    const check = checkTotp(secret, credentials.totpCode);
    if (!check.ok) return fail('INVALID_CODE', 'authenticator code', 'Invalid authenticator code.');
    // One conditional UPDATE: two simultaneous signings with one code cannot both pass.
    if (!(await acceptTotpStep(db, signer.id, check.step))) {
      return fail('INVALID_CODE', 'authenticator code', 'That authenticator code was already used. Wait for the next code.');
    }
    authMethod = 'password+totp';
  }

  if (signer.failedAttempts > 0 || signer.lockedAt) await clearSigningFailures(db, signer.id);
  return { signer, authMethod };
}
