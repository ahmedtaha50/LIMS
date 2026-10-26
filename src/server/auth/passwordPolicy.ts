/**
 * Password policy engine (roadmap M05): length and character classes from the security settings, a built-in common-password
 * screen, no e-mail address or name inside the password, and no reuse of the last N passwords (including the current one).
 * `checkPasswordPolicy` returns the broken rules as readable sentences; an empty list means the password is acceptable.
 */
import { randomInt } from 'crypto';
import { verifyPassword } from '../../db/utils';
import { BANNED_FRAGMENTS, COMMON_PASSWORDS } from './commonPasswords';
import type { SecuritySettings } from './settings';

/** Whatever the administrator configures, nothing shorter than this is accepted. */
export const MIN_PASSWORD_FLOOR = 8;
export const MAX_PASSWORD_LENGTH = 128;

export interface PolicyContext {
  settings: Pick<SecuritySettings, 'minPasswordLength' | 'requireUppercase' | 'requireNumbers' | 'requireSymbols' | 'passwordHistoryCount'>;
  email?: string | null;
  name?: string | null;
  /** Newest-first hashes of earlier passwords, current one first. Only the first `passwordHistoryCount` are compared. */
  recentHashes?: string[];
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function checkPasswordPolicy(candidate: string, ctx: PolicyContext): string[] {
  const problems: string[] = [];
  const min = Math.max(ctx.settings.minPasswordLength, MIN_PASSWORD_FLOOR);
  if (candidate.length < min) problems.push(`Use at least ${min} characters.`);
  if (candidate.length > MAX_PASSWORD_LENGTH) problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  if (ctx.settings.requireUppercase && !/[A-Z]/.test(candidate)) problems.push('Include at least one uppercase letter (A-Z).');
  if (ctx.settings.requireNumbers && !/[0-9]/.test(candidate)) problems.push('Include at least one number (0-9).');
  if (ctx.settings.requireSymbols && !/[^A-Za-z0-9]/.test(candidate)) problems.push('Include at least one special character, for example ! ? # $ % -.');

  const flat = normalise(candidate);
  const stripped = flat.replace(/\d+$/, '');
  if (COMMON_PASSWORDS.has(candidate.toLowerCase()) || COMMON_PASSWORDS.has(flat) || COMMON_PASSWORDS.has(stripped) || BANNED_FRAGMENTS.some(f => flat.includes(f))
      || /^(.)\1+$/.test(candidate)) {
    problems.push('This password is too common or easy to guess.');
  }

  const personal = new Set<string>();
  const local = normalise((ctx.email ?? '').split('@')[0] ?? '');
  if (local.length >= 4) personal.add(local);
  for (const part of (ctx.name ?? '').split(/[\s,.-]+/)) { const p = normalise(part); if (p.length >= 4) personal.add(p); }
  if ([...personal].some(p => flat.includes(p))) problems.push('Do not use your e-mail address or your name in the password.');

  const n = ctx.settings.passwordHistoryCount;
  if (n > 0 && (ctx.recentHashes ?? []).slice(0, n).some(h => verifyPassword(candidate, h))) {
    problems.push(`This password was used recently. Choose one you have not used in the last ${n} changes.`);
  }
  return problems;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!?#$%&'; // no = + - @: a value that starts with one of them is read as a formula when pasted into a spreadsheet

/** A random temporary password (18 characters, starts with a letter, all four classes, no look-alike characters) that passes the policy. */
export function generateTemporaryPassword(): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const rest = [pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (rest.length < 17) rest.push(pick(all));
  for (let i = rest.length - 1; i > 0; i--) { const j = randomInt(i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return pick(UPPER) + rest.join('');
}
