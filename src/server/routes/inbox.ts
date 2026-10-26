// Domain: the task inbox ("My Tasks"). Owned by r2-ui-foundation (roadmap M24).
//
//   GET /inbox   what is waiting for the signed-in user, in groups. A group is evaluated only when the user's role may act on it
//                (the permission matrix, and for samples the workflow's allowed roles), and a record the user took part in, which the
//                handler would refuse to let them sign, is left out (segregation of duties). Each group: { key, title, count, order,
//                items (the oldest 25), more }. Every group is ordered oldest first, and says so; nothing is ranked by "urgency".
//
// The inbox is guidance: the route that carries out the action checks everything again.
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { UserRow } from '../auth/sessions';
import { permissionsOfRole } from '../authz/grants';
import { loadSodRule } from '../authz/sod';
import type { Db, RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import { SampleWorkflow } from '../workflow/transitions';
import { OOS_TERMINAL_STATUSES } from '../../lib/constants/oos';

export const INBOX_GROUP_SIZE = 25;
export const inboxQuerySchema = z.object({}).strict();

export interface InboxItem { id: string; entity: string; title: string; detail: string; since: string | null; href: string }
export interface InboxGroup { key: string; title: string; count: number; order: 'oldest-first'; items: InboxItem[]; more: boolean }

const rowsOf = (r: unknown) => (r as { rows: any[] }).rows;
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const roleMay = (role: string, from: string, to: string) => SampleWorkflow.some(r => (r.from === from || r.from === '*') && r.to === to && (r.allowedRoles as string[]).includes(role));

/** count(*) OVER () gives the size of the whole group with the first rows, in one query. */
async function group(db: Db, key: string, title: string, query: ReturnType<typeof sql>, toItem: (r: any) => InboxItem): Promise<InboxGroup> {
  const rows = rowsOf(await db.execute(query));
  const count = rows.length ? Number(rows[0].__total) : 0;
  return { key, title, count, order: 'oldest-first', items: rows.map(toItem), more: count > rows.length };
}

export async function buildInbox(db: Db, user: UserRow): Promise<{ generatedAt: string; groups: InboxGroup[] }> {
  const granted = new Set(await permissionsOfRole(db, user.role));
  const groups: InboxGroup[] = [];
  const take = INBOX_GROUP_SIZE;

  // Results to review: the workflow's reviewers, never the person who registered the sample or entered one of its results
  // (the same two rules the transition handler enforces).
  if (granted.has('sample.transition') && roleMay(user.role, 'Pending Review', 'Approved')) {
    groups.push(await group(db, 'review', 'Results to review', sql`
      SELECT s.id, s.material, s.batch, s.created_at, count(*) OVER () AS __total FROM samples s
      WHERE s.state = 'Pending Review' AND s.created_by <> ${user.id}
        AND NOT EXISTS (SELECT 1 FROM results r WHERE r.sample_id = s.id AND r.entered_by = ${user.id})
      ORDER BY s.created_at ASC, s.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'Sample', title: r.id, detail: `${r.material} · ${r.batch} · waiting for review`, since: iso(r.created_at), href: `#/samples/${encodeURIComponent(r.id)}` })));
  }

  // Samples to test: those the role may start or fill in. There is no assignment yet (worklists come later): every open sample.
  if (granted.has('result.enter') && roleMay(user.role, 'Logged', 'Testing')) {
    groups.push(await group(db, 'testing', 'Samples to test', sql`
      SELECT s.id, s.material, s.batch, s.state, s.created_at, count(*) OVER () AS __total FROM samples s
      WHERE s.state IN ('Logged', 'Testing')
      ORDER BY s.created_at ASC, s.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'Sample', title: r.id, detail: `${r.material} · ${r.batch} · ${r.state}`, since: iso(r.created_at), href: `#/samples/${encodeURIComponent(r.id)}` })));
  }

  // Specifications to approve: drafts the user neither created nor edited (rule spec.approve, read from sod_rules).
  if (granted.has('spec.approve')) {
    const rule = await loadSodRule(db, 'spec.approve');
    const actions = sql.join(rule.authorActions.map(a => sql`${a}`), sql`, `);
    groups.push(await group(db, 'spec-approval', 'Specifications to approve', sql`
      SELECT sp.id, sp.material, sp.revision_label, sp.effective_date,
             (SELECT min(a.timestamp) FROM audit_trail a WHERE a.entity = ${rule.entity} AND a.entity_id = sp.id) AS since,
             count(*) OVER () AS __total
      FROM specifications sp
      WHERE sp.status = 'Draft' AND sp.created_by IS DISTINCT FROM ${user.id}
        AND NOT EXISTS (SELECT 1 FROM audit_trail a WHERE a.entity = ${rule.entity} AND a.entity_id = sp.id AND a.user_id = ${user.id} AND a.action IN (${actions}))
      ORDER BY since ASC NULLS FIRST, sp.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'Specification', title: `${r.material} Rev ${r.revision_label}`, detail: `Draft, effective ${r.effective_date}`, since: iso(r.since), href: '#/specs' })));
  }

  const terminal = sql.join(OOS_TERMINAL_STATUSES.map(s => sql`${s}`), sql`, `);
  if (granted.has('oos.edit')) {
    groups.push(await group(db, 'oos-assigned', 'OOS investigations assigned to you', sql`
      SELECT o.id, o.sample_id, o.parameter, o.phase, o.date_raised, count(*) OVER () AS __total FROM oos_investigations o
      WHERE o.assigned_to = ${user.id} AND o.status NOT IN (${terminal})
      ORDER BY o.date_raised ASC, o.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'OOS', title: r.id, detail: `${r.sample_id} · ${r.parameter} · ${r.phase ?? 'phase not set'}`, since: iso(r.date_raised), href: '#/oos' })));
  }
  if (granted.has('oos.close')) {
    groups.push(await group(db, 'oos-closure', 'OOS investigations waiting for QA closure', sql`
      SELECT o.id, o.sample_id, o.parameter, o.date_raised, count(*) OVER () AS __total FROM oos_investigations o
      WHERE o.status = 'Open' AND o.phase = 'Pending QA'
      ORDER BY o.date_raised ASC, o.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'OOS', title: r.id, detail: `${r.sample_id} · ${r.parameter}`, since: iso(r.date_raised), href: '#/oos' })));
  }

  // Role changes to decide: never one the user requested or one that is for the user (rule role.grant).
  if (granted.has('authz.role.approve')) {
    groups.push(await group(db, 'role-changes', 'Role changes to decide', sql`
      SELECT ur.id, ur.requested_at, ur.previous_role, r.name AS role_name, u.name AS user_name, count(*) OVER () AS __total
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
      WHERE ur.status = 'Pending' AND ur.requested_by <> ${user.id} AND ur.user_id <> ${user.id}
      ORDER BY ur.requested_at ASC, ur.id ASC LIMIT ${take}`,
    r => ({ id: r.id, entity: 'UserRole', title: `${r.user_name}: ${r.previous_role} to ${r.role_name}`, detail: 'Waiting for an independent approval', since: iso(r.requested_at), href: '#/admin' })));
  }

  if (!user.hasCompletedSoftwareTraining) {
    groups.push({ key: 'training', title: 'Your training', count: 1, order: 'oldest-first', more: false, items: [
      { id: user.id, entity: 'User', title: 'Complete the software training', detail: 'Signing records needs the software training first.', since: null, href: '#/training' },
    ] });
  }

  return { generatedAt: new Date().toISOString(), groups };
}

export const inboxRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  router.get('/inbox', requireAuth, validate(inboxQuerySchema, 'query'), async (req, res) => {
    const user = (req as any).user as UserRow; // the actor is the session's user, never a parameter
    res.json(await buildInbox(db, user));
  });
  return router;
};
