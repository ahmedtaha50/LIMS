/**
 * The first Administrator (roadmap M05 "bootstrap rule"). Allowed only while no active Administrator exists, so it cannot be used
 * to add a second one behind the application's back; the account must change its password at the first sign-in; the creation is
 * an audited transaction whose actor is the operator (`cli:<os user>`), like every other break-glass action.
 * Used by `admin-cli bootstrap-admin`; the installer (init-db) should call this instead of inserting the row itself.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../core/context';
import { loadSecuritySettings } from './settings';
import { createUser } from './users';
import { AppError } from '../http/errors';

export async function bootstrapFirstAdmin(db: Db, input: { actor: string; name: string; email: string; password: string; reason: string }) {
  const settings = await loadSecuritySettings(db);
  return db.transaction(async tx => {
    // One bootstrap at a time: two installers started together must not both pass the check. (7001 audit chain, 7002 migrations, 7003 security events.)
    await tx.execute(sql`select pg_advisory_xact_lock(7010)`);
    const active = await tx.execute(sql`select count(*)::int as n from users where role = 'Admin' and active`);
    if ((active as any).rows[0].n > 0) throw new AppError(409, 'ADMIN_EXISTS', 'An active administrator already exists. Use reset-password for that account instead.');
    return createUser(tx, input.actor, settings, { name: input.name, email: input.email, role: 'Admin', reason: input.reason, password: input.password });
  });
}
