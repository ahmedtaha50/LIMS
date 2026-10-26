/**
 * The service principal (roadmap M15): the named identity under which scheduled work is done. A change made by a timer is a GxP
 * record change, so it is attributed to this account in the audit trail (with a reason 'Scheduled: <task>'), never to an
 * anonymous 'system'. The account is provisioned on first use, audited, and cannot sign in: it has no password, no e-mail
 * address and is inactive, so no token for it is ever accepted and no one can authenticate as it.
 */
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import type { Db } from '../core/context';

export const SERVICE_PRINCIPAL_ID = 'svc-scheduler';

export async function ensureServicePrincipal(db: Db): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, SERVICE_PRINCIPAL_ID)).limit(1);
  if (existing) return SERVICE_PRINCIPAL_ID;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(users).values({
      id: SERVICE_PRINCIPAL_ID, uid: SERVICE_PRINCIPAL_ID, name: 'Scheduler (service principal)', role: 'Service', active: false,
    }).onConflictDoNothing().returning({ id: users.id });
    if (inserted.length) {
      await writeAudit(tx, SERVICE_PRINCIPAL_ID, 'Create', 'User', SERVICE_PRINCIPAL_ID, 'user', '', JSON.stringify({ role: 'Service', interactive: false }),
        'Provisioned: non-interactive service principal for scheduled tasks');
    }
  });
  return SERVICE_PRINCIPAL_ID;
}
