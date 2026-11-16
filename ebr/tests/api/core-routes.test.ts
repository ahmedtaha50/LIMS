import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoutes, routeTable } from '../../server/routes/index.js';
import { ROUTES } from '../helpers/app.js';

const SNAPSHOT = fileURLToPath(new URL('../route-table.json', import.meta.url));
const CORE = fileURLToPath(new URL('../../server/core/route.js', import.meta.url)).replace(/\.js$/, '.ts');

function routesDir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'ebr-routes-'));
  for (const [f, src] of Object.entries(files)) writeFileSync(join(d, f), src);
  return d;
}

describe('route registry (E01#3)', () => {
  it('the route table matches tests/route-table.json (UPDATE_ROUTE_TABLE=1 to accept a deliberate change)', async () => {
    const table = routeTable(await loadRoutes(ROUTES));
    if (process.env.UPDATE_ROUTE_TABLE === '1') writeFileSync(SNAPSHOT, JSON.stringify(table, null, 2) + '\n');
    expect(table).toEqual(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  });

  it('a new file in the routes directory is mounted without editing any list', async () => {
    const d = routesDir({ 'a.ts': `export const routes = [{ method: 'GET', path: '/api/a', permission: 'public', summary: 'a', handler: () => 1 }];` });
    try { expect((await loadRoutes(d)).map(r => r.path)).toEqual(['/api/a']); } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('a route without a permission, outside /api/, or defined twice is refused when the server loads', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ 'a.ts': `export const routes = [{ method: 'GET', path: '/api/a', summary: 'a', handler: () => 1 }];` }, /declares no permission/],
      [{ 'a.ts': `export const routes = [{ method: 'GET', path: '/a', permission: 'public', summary: 'a', handler: () => 1 }];` }, /under \/api\//],
      [{ 'a.ts': `export const routes = [{ method: 'GET', path: '/api/a', permission: 'public', summary: 'a', handler: () => 1 }];`, 'b.ts': `export const routes = [{ method: 'GET', path: '/api/a', permission: 'public', summary: 'b', handler: () => 2 }];` }, /defined twice/],
      [{ 'a.ts': `export const nothing = 1;` }, /does not export routes/],
    ];
    for (const [files, why] of cases) {
      const d = routesDir(files);
      try { await expect(loadRoutes(d)).rejects.toThrow(why); } finally { rmSync(d, { recursive: true, force: true }); }
    }
    expect(CORE).toMatch(/route\.ts$/);
  });
});
