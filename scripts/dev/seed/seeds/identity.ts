// Demo data: Ensure core users exist. Moved unchanged from the former src/server/seed_pg.ts (see tag pre-r1); skips when the table already has rows.
import { scryptSync } from 'crypto';
import type { Db } from '../../../../src/server/core/context';
import { users } from '../../../../src/db/schema';

export async function seedUsers(db: Db): Promise<void> {
  const salt = 'gxp-salt-2026';
  const pwdHash = scryptSync('password', salt, 64).toString('hex');

  const existingUsers = await db.select().from(users);
  if (existingUsers.length === 0) {
    await db.insert(users).values([
      { id: 'usr-admin', uid: 'admin', email: 'admin@gxp.com', name: 'Dr. Sarah Jenkins', role: 'Admin', passwordHash: pwdHash, hasCompletedSoftwareTraining: true },
      { id: 'usr-qa', uid: 'qa', email: 'qa@gxp.com', name: 'Marcus Vance, QA Officer', role: 'QA', passwordHash: pwdHash, hasCompletedSoftwareTraining: true },
      { id: 'usr-reviewer', uid: 'reviewer', email: 'reviewer@gxp.com', name: 'Dr. Elena Rostova', role: 'Reviewer', passwordHash: pwdHash, hasCompletedSoftwareTraining: true },
      { id: 'usr-analyst1', uid: 'analyst1', email: 'analyst1@gxp.com', name: 'Ahmed Taha, QC Analyst', role: 'Analyst', passwordHash: pwdHash, hasCompletedSoftwareTraining: true },
      { id: 'usr-analyst2', uid: 'analyst2', email: 'analyst2@gxp.com', name: 'Claire Dupont, Chemist', role: 'Analyst', passwordHash: pwdHash, hasCompletedSoftwareTraining: true },
    ]);
  } else {
    // Ensure existing key users have software training completed
    await db.update(users).set({ hasCompletedSoftwareTraining: true });
  }
}
