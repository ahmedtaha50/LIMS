/** The local account store: users.email (compared without regard to case) and the scrypt hash in users.password_hash. */
import { sql } from 'drizzle-orm';
import { users } from '../../../db/schema';
import { generatePasswordHash, verifyPassword } from '../../../db/utils';
import type { PrincipalResolver } from './index';

/** Verified against when the address is unknown, so the response time does not tell whether an account exists. */
const DUMMY_HASH = generatePasswordHash('not-a-real-account-password');

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export const localDirectory: PrincipalResolver = {
  id: 'local',
  async authenticate(db, email, password) {
    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${normaliseEmail(email)}`).limit(1);
    if (!user) { verifyPassword(password, DUMMY_HASH); return { kind: 'unknown' }; }
    return verifyPassword(password, user.passwordHash) ? { kind: 'ok', user } : { kind: 'bad-password', user };
  },
};
