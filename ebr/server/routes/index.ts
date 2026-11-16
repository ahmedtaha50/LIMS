import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RouteDef } from '../core/route.js';

/**
 * The route registry is this directory: every file next to this one exports `routes: RouteDef[]`. A track adds a file;
 * nobody edits a shared list (two tracks editing one list was how a wave lost an afternoon on the source project).
 */
export async function loadRoutes(dir: string): Promise<RouteDef[]> {
  const files = readdirSync(dir).filter(f => /\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f) && !/^index\./.test(f)).sort();
  const all: RouteDef[] = [];
  for (const f of files) {
    const mod: { routes?: unknown } = await import(pathToFileURL(join(dir, f)).href);
    if (!Array.isArray(mod.routes)) throw new Error(`server/routes/${f} does not export routes: RouteDef[]`);
    for (const r of mod.routes as RouteDef[]) {
      if (!r.permission || typeof r.permission !== 'string') throw new Error(`${r.method} ${r.path} (${f}) declares no permission: name one, or 'public'`);
      if (!r.path.startsWith('/api/')) throw new Error(`${r.method} ${r.path} (${f}): every route lives under /api/`);
      all.push(r);
    }
  }
  const seen = new Set<string>();
  for (const r of all) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) throw new Error(`route ${key} is defined twice`);
    seen.add(key);
  }
  return all.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The route table as tests/route-table.json stores it: what a reviewer reads to see every endpoint and its permission. */
export const routeTable = (routes: readonly RouteDef[]) => routes.map(r => ({ method: r.method, path: r.path, permission: r.permission, summary: r.summary }));
