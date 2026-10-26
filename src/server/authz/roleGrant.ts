/**
 * Guard for the two administrator routes that can give a user a role: POST /admin/users (the role of a new account) and
 * PUT /admin/users/:id (a change of role). Granting or removing a privileged role (a role with requires_approval: Admin, QA)
 * needs two people, which is the flow of POST /permissions/role-changes. Changes between roles that need no approval, and
 * everything else those routes do (deactivating, a new Analyst), are unchanged.
 */
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema';
import { AppError } from '../http/errors';
import { recordDenied } from './denied';
import { rolesRequiringApproval } from './grants';
import type { Guard } from './types';

export const forbidUnapprovedPrivilegedRoleChange: Guard = async ({ db, req, user, params, body }) => {
  const to = typeof body.role === 'string' ? body.role : undefined;
  if (to === undefined) return;
  let from: string | null = null;
  if (req.method === 'PUT') {
    if (params.id === user.id) return; // the handler's own answer (SELF_CHANGE_FORBIDDEN) is the right one
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, params.id)).limit(1);
    if (!target || target.role === to) return; // no such user (404 from the handler) or no change
    from = target.role;
  }
  const needsApproval = await rolesRequiringApproval(db);
  if (!needsApproval.has(to) && !(from !== null && needsApproval.has(from))) return;

  await recordDenied(db, req, user, { rule: 'role.grant', reason: 'privileged role change without the second signature', from, to });
  throw new AppError(409, 'ROLE_CHANGE_REQUIRES_APPROVAL', from === null
    ? `A new account cannot be created as ${to}: that role needs two people. Create the account as Analyst or Reviewer, then request the role at POST /api/permissions/role-changes; a second Administrator or QA officer approves it.`
    : `Changing a user from ${from} to ${to} needs two people: request it at POST /api/permissions/role-changes and have a second, independent Administrator or QA officer approve it.`,
  { rule: 'role.grant', from, to });
};
