// The permission matrix as CSV, for access review (Annex 11 s.12): one row per permission, an X per role that holds it, and the
// routes the permission unlocks. GET /api/permissions/matrix?format=csv writes it from the database; docs/permission-matrix.csv
// is written from the catalog (scripts/authz/export-matrix.ts) and a test fails when it is stale.
import { DEFAULT_MATRIX, PERMISSIONS, ROLE_NAMES } from '../../lib/permissions';
import type { MatrixView } from './grants';
import { ROUTE_RULES } from './routeTable';

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** permission code -> the "METHOD /path" keys bound to it, in table order. */
export function routesByPermission(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, rule] of Object.entries(ROUTE_RULES)) if (rule.kind === 'perm') (out[rule.permission] ??= []).push(key);
  return out;
}

export function matrixCsv(matrix: MatrixView, routes: Record<string, string[]> = routesByPermission()): string {
  const roleNames = matrix.roles.map(r => r.name);
  const held = Object.fromEntries(roleNames.map(r => [r, new Set(matrix.grants[r] ?? [])]));
  const lines = [['permission', 'category', 'description', ...roleNames, 'routes'].map(cell).join(',')];
  for (const p of matrix.permissions) {
    lines.push([p.code, p.category, p.description, ...roleNames.map(r => (held[r].has(p.code) ? 'X' : '')), (routes[p.code] ?? []).join('; ')].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** The same document from src/lib/permissions.ts and the route table, without a database. */
export function matrixCsvFromCatalog(): string {
  return matrixCsv({
    roles: ROLE_NAMES.map(name => ({ name, description: '', requiresApproval: false, active: true })),
    permissions: PERMISSIONS.map(p => ({ code: p.code, category: p.category, description: p.description })),
    grants: Object.fromEntries(ROLE_NAMES.map(r => [r, [...DEFAULT_MATRIX[r]]])),
  });
}
