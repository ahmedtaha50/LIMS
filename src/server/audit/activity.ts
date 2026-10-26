/**
 * Activity of the audit trail by role and hour of day, for the administrator's heat map. Counts what is in the table and
 * nothing else; the first version of the heat map padded a quiet system with random numbers.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../core/context';

const ROLES = ['Analyst', 'Reviewer', 'QA', 'Admin', 'System'];

function validZone(zone: string): string {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return 'UTC'; }
}

/**
 * One cell per role and hour (0-23), in `timeZone` (an IANA name; the server's own zone is
 * Intl.DateTimeFormat().resolvedOptions().timeZone). The role is the one recorded with the entry, else the user's current role;
 * 'System' collects entries whose actor is not a user account (the installer and migrations).
 */
export async function activityHeatmap(db: Db, timeZone: string): Promise<Array<{ role: string; hour: number; value: number }>> {
  const zone = validZone(timeZone);
  const result = await db.execute(sql`
    select coalesce(a.actor_role, u.role, 'System') as role,
           extract(hour from a.timestamp at time zone ${zone})::int as hour,
           count(*)::int as value
    from audit_trail a left join users u on u.id = a.user_id
    group by 1, 2`);
  const counts = new Map<string, number>();
  const roles = new Set(ROLES);
  for (const row of result.rows as Array<{ role: string; hour: number; value: number }>) {
    counts.set(`${row.role}|${row.hour}`, row.value);
    roles.add(row.role);
  }
  const cells: Array<{ role: string; hour: number; value: number }> = [];
  for (const role of roles) for (let hour = 0; hour < 24; hour++) cells.push({ role, hour, value: counts.get(`${role}|${hour}`) ?? 0 });
  return cells;
}
