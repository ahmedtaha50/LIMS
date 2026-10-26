// Reads the permission matrix from its tables. The rows are installed by drizzle/0040_authz.sql and equal src/lib/permissions.ts.
import { and, asc, eq } from 'drizzle-orm';
import { permissions, rolePermissions, roles } from '../../db/schema/authz';
import { ROLE_NAMES } from '../../lib/permissions';
import type { Executor } from '../core/tx';

/** The permission codes the role holds. A role that is not in the matrix, or is switched off, holds none. */
export async function permissionsOfRole(ex: Executor, roleName: string): Promise<string[]> {
  const rows = await ex.select({ code: rolePermissions.permissionCode, position: permissions.position })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .innerJoin(permissions, eq(permissions.code, rolePermissions.permissionCode))
    .where(and(eq(roles.name, roleName), eq(roles.active, true)))
    .orderBy(asc(permissions.position));
  return rows.map(r => r.code);
}

/** Names of the roles whose grant, or removal, needs the second signature. */
export async function rolesRequiringApproval(ex: Executor): Promise<Set<string>> {
  const rows = await ex.select({ name: roles.name }).from(roles).where(and(eq(roles.requiresApproval, true), eq(roles.active, true)));
  return new Set(rows.map(r => r.name));
}

export interface MatrixView {
  roles: Array<{ name: string; description: string; requiresApproval: boolean; active: boolean }>;
  permissions: Array<{ code: string; category: string; description: string }>;
  grants: Record<string, string[]>;
}

const roleOrder = (name: string) => { const i = (ROLE_NAMES as readonly string[]).indexOf(name); return i === -1 ? ROLE_NAMES.length : i; };

/** The whole matrix, roles in the catalog's order, permissions in catalog order. */
export async function loadMatrix(ex: Executor): Promise<MatrixView> {
  const roleRows = (await ex.select().from(roles)).sort((a, b) => roleOrder(a.name) - roleOrder(b.name) || a.name.localeCompare(b.name));
  const permissionRows = await ex.select().from(permissions).orderBy(asc(permissions.position));
  const grantRows = await ex.select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode, position: permissions.position })
    .from(rolePermissions).innerJoin(permissions, eq(permissions.code, rolePermissions.permissionCode)).orderBy(asc(permissions.position));
  const nameOf = new Map(roleRows.map(r => [r.id, r.name]));
  const grants: Record<string, string[]> = Object.fromEntries(roleRows.map(r => [r.name, [] as string[]]));
  for (const g of grantRows) grants[nameOf.get(g.roleId)!]?.push(g.code);
  return {
    roles: roleRows.map(r => ({ name: r.name, description: r.description, requiresApproval: r.requiresApproval, active: r.active })),
    permissions: permissionRows.map(p => ({ code: p.code, category: p.category, description: p.description })),
    grants,
  };
}
