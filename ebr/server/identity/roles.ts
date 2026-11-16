/**
 * Roles and the permissions they grant: the one place to read who may do what. A track that adds a permission adds it
 * here through a gate patch, and docs/permission-matrix.csv is regenerated from this table.
 * Privileged roles need the second factor (E02#4): until it is set up, their session can only reach 'session' routes.
 */
export const ROLES = {
  operator: { privileged: false, permissions: ['session', 'signatures.read', 'logbook.read', 'logbook.write', 'mbr.read', 'batch.read', 'batch.execute', 'materials.read'] },
  supervisor: { privileged: false, permissions: ['session', 'signatures.read', 'audit.read', 'logbook.read', 'logbook.write', 'logbook.manage', 'logbook.type.design', 'mbr.read', 'mbr.design', 'batch.read', 'batch.create', 'batch.execute', 'batch.exception', 'batch.complete', 'materials.read', 'materials.manage'] },
  qa: { privileged: true, permissions: ['session', 'signatures.read', 'audit.read', 'audit.verify', 'logbook.read', 'logbook.type.approve', 'mbr.read', 'mbr.approve', 'batch.read', 'materials.read', 'materials.release', 'review.perform', 'batch.release'] },
  admin: { privileged: true, permissions: ['session', 'users.manage', 'audit.read', 'audit.verify', 'signatures.read', 'logbook.read', 'logbook.manage'] },
} as const satisfies Record<string, { privileged: boolean; permissions: readonly string[] }>;
export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as Role[];

export const isPrivileged = (roles: readonly string[]) => roles.some(r => (ROLES as Record<string, { privileged: boolean }>)[r]?.privileged);
export function permissionsOf(roles: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of roles) for (const p of (ROLES as Record<string, { permissions: readonly string[] }>)[r]?.permissions ?? []) out.add(p);
  return out;
}

/** The permission matrix as CSV (role, permission), sorted: the derived file docs/permission-matrix.csv. */
export const permissionMatrix = () => ['role,permission,privileged', ...ROLE_NAMES.flatMap(r => [...ROLES[r].permissions].sort().map(p => `${r},${p},${ROLES[r].privileged}`))].join('\n') + '\n';
