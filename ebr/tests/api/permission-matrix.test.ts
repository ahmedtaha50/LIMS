import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { permissionMatrix, ROLES } from '../../server/identity/roles.js';
import { loadRoutes } from '../../server/routes/index.js';
import { ROUTES } from '../helpers/app.js';

const FILE = fileURLToPath(new URL('../../docs/permission-matrix.csv', import.meta.url));

describe('permission matrix (derived file)', () => {
  it('docs/permission-matrix.csv is generated from server/identity/roles.ts (UPDATE_ROUTE_TABLE=1 to regenerate)', () => {
    if (process.env.UPDATE_ROUTE_TABLE === '1') writeFileSync(FILE, permissionMatrix());
    expect(readFileSync(FILE, 'utf8')).toBe(permissionMatrix());
  });
  it('every permission a route asks for is granted by some role, so no route is unreachable by mistake', async () => {
    const granted = new Set<string>(Object.values(ROLES).flatMap(r => [...r.permissions]));
    const missing = (await loadRoutes(ROUTES)).filter(r => r.permission !== 'public' && !granted.has(r.permission)).map(r => `${r.method} ${r.path} needs ${r.permission}`);
    expect(missing).toEqual([]);
  });
});
