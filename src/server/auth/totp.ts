/**
 * TOTP (RFC 6238): secrets are stored as keystore ciphertext bound to the user id; codes are accepted within one step either way
 * of the clock, and each 30 s step is accepted once per user (the replay guard is one conditional UPDATE, so two simultaneous
 * requests with the same code cannot both pass). A secret that is still bare base32, from before the keystore, is read as it is and
 * rewritten as ciphertext the first time it is used.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { users } from '../../db/schema';
import { getKeystore, KeystoreError } from '../crypto/keystore';
import type { Executor } from '../core/tx';

export const TOTP_ISSUER = 'B-Pharma LIMS';
const TOLERANCE_SECONDS = 30;

/** Authenticated-data string for users.totp_secret and users.totp_pending_secret: a value cannot be moved to another user. */
export const totpContext = (userId: string) => `users.totp_secret:${userId}`;

export const newTotpSecret = (): string => generateSecret();

export function otpauthUri(label: string, secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label, secret });
}

export const qrDataUrl = (uri: string): Promise<string> => QRCode.toDataURL(uri, { margin: 1, width: 240 });

export const sealTotpSecret = (secret: string, userId: string): string => getKeystore().encrypt(secret, totpContext(userId));

/** The base32 secret, and whether the stored value was a legacy plaintext one. Throws KeystoreError if it cannot be decrypted. */
export function openTotpSecret(stored: string, userId: string): { secret: string; legacy: boolean } {
  const ks = getKeystore();
  return ks.isEncrypted(stored) ? { secret: ks.decrypt(stored, totpContext(userId)), legacy: false } : { secret: stored, legacy: true };
}

export type TotpCheck = { ok: true; step: number } | { ok: false };

export function checkTotp(secret: string, code: string): TotpCheck {
  try {
    const r = verifySync({ secret, token: code, epochTolerance: TOLERANCE_SECONDS } as any) as { valid: boolean; timeStep?: number };
    return r.valid && typeof r.timeStep === 'number' ? { ok: true, step: r.timeStep } : { ok: false };
  } catch {
    return { ok: false }; // a malformed stored secret is "not valid", not a crash
  }
}

/** Marks `step` as used. False when this step, or a later one, was already accepted for the user: a replay. */
export async function acceptTotpStep(ex: Executor, userId: string, step: number): Promise<boolean> {
  const rows = await ex.update(users).set({ totpLastStep: step })
    .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step)))).returning({ id: users.id });
  return rows.length === 1;
}

export { KeystoreError };
