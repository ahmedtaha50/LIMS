/**
 * MFA recovery codes: ten one-time codes shown once at enrolment, stored only as salted scrypt hashes (like passwords).
 * A code is 10 characters of an alphabet without look-alike letters, shown as XXXXX-XXXXX.
 */
import { randomBytes, randomInt } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { recoveryCodes } from '../../db/schema';
import { generatePasswordHash, verifyPassword } from '../../db/utils';
import type { Executor } from '../core/tx';

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const format = (raw: string) => `${raw.slice(0, 5)}-${raw.slice(5)}`;

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => format(Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')));
}

export async function clearRecoveryCodes(ex: Executor, userId: string): Promise<void> {
  await ex.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}

/** Replaces every code of the user with `codes`. */
export async function storeRecoveryCodes(ex: Executor, userId: string, codes: string[]): Promise<void> {
  await clearRecoveryCodes(ex, userId);
  await ex.insert(recoveryCodes).values(codes.map(c => ({ id: `rc-${randomBytes(8).toString('hex')}`, userId, codeHash: generatePasswordHash(normalise(c)) })));
}

/** True, and the code is spent, when `input` matches an unused code of the user. */
export async function consumeRecoveryCode(ex: Executor, userId: string, input: string): Promise<boolean> {
  const candidate = normalise(input);
  if (candidate.length !== 10) return false;
  const rows = await ex.select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  const match = rows.find(r => verifyPassword(candidate, r.codeHash));
  if (!match) return false;
  const spent = await ex.update(recoveryCodes).set({ usedAt: new Date() }).where(and(eq(recoveryCodes.id, match.id), isNull(recoveryCodes.usedAt))).returning({ id: recoveryCodes.id });
  return spent.length === 1;
}
