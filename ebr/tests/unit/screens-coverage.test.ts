import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// E32#1: every route a person can call has a screen that calls it. Found missing in R6: user management, logbook creation,
// logbook type versions, recipe copy, audit trail review, certified copy check, LIMS samples on the batch.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const routes = JSON.parse(readFileSync(join(ROOT, 'tests/route-table.json'), 'utf8')) as Array<{ method: string; path: string; permission: string }>;
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !p.includes('/i18n/') ? [p] : []; });
const client = files(join(ROOT, 'client')).map(f => readFileSync(f, 'utf8'));

/** Routes no person calls from a screen, each with its reason. Anything else without a screen fails the test. */
const NOT_FOR_SCREENS: Record<string, string> = {
  'GET /api/health': 'checked by the load balancer, the service installer and monitoring',
  'GET /api/signatures/meanings': 'the list for other systems; the screens show meanings from their dictionaries',
};

/** The paths a source string calls: template parameters (${...}) and route parameters (:id) both become one segment. */
const shape = (p: string) => p.replace(/([^/])\$\{[^}]+\}$/, '$1').replace(/\$\{[^}]+\}/g, ':p').replace(/:[A-Za-z]+/g, ':p').split('?')[0]!;   // a query appended as ${q} is not a segment
const called = client.map(src => ({
  src,
  // template literals read whole (a ${...} may hold quotes), plain strings up to their quote
  paths: new Set([...src.matchAll(/`(\/api\/[^`]*)`|'(\/api\/[^'\s]*)'/g)].map(m => shape((m[1] ?? m[2])!))),
}));

describe('every function a person uses has a screen (E32#1)', () => {
  it('E32#1: each route a person can call is called by a screen with its method, or is a named exception', () => {
    const missing = routes.filter(r => r.permission !== 'public' || r.path !== '/api/health').filter(r => {
      if (NOT_FOR_SCREENS[`${r.method} ${r.path}`]) return false;
      const want = shape(r.path);
      // an action chosen at run time (`/${what}`) counts when the action's own name is written in the same screen
      const last = want.split('/').pop()!, generic = last.startsWith(':') ? null : want.replace(/\/[^/]+$/, '/:p');
      const hit = ({ src, paths }: (typeof called)[number]) => paths.has(want) || (generic !== null && paths.has(generic) && src.includes(`'${last}'`));
      return !called.some(c => hit(c) && (r.method === 'GET' ? true : c.src.includes(`'${r.method}'`)));
    }).map(r => `${r.method} ${r.path} [${r.permission}]`);
    expect(missing).toEqual([]);
  });

  it('E32#1: the exceptions are real routes, so the list cannot hide a stale entry', () => {
    for (const k of Object.keys(NOT_FOR_SCREENS)) expect(routes.some(r => `${r.method} ${r.path}` === k), k).toBe(true);
  });
});
