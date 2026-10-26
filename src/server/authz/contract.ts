/**
 * The deny-by-default contract (roadmap M09): the route table and the routes the application registers must agree. Checked
 * when the application is built (createApp), so a route without a rule stops the server from starting, and by
 * tests/api/route-contract.test.ts.
 *
 * Reads Express's own router stack, the same way tests/helpers/routeTable.ts does: it follows routers mounted at a fixed prefix.
 */
import type { Express } from 'express';
import { ROUTE_RULES } from './routeTable';

export interface RegisteredRoute { method: string; path: string; authenticated: boolean }

export interface Violation {
  route: string;
  problem: 'no-rule' | 'stale-rule' | 'auth-mismatch' | 'no-body' | 'duplicate';
  message: string;
  fix: string;
}

function mountPrefix(layer: any): string {
  if (layer.keys && layer.keys.length) throw new Error('A router mounted at a parameterised path cannot be checked by the route contract.');
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = /^\^((?:\\\/[^\\/()?*+[\]{}|^$]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
  if (!m) throw new Error(`A router mount pattern the route contract does not understand: ${src}`);
  return m[1].replace(/\\\//g, '/');
}

function walk(stack: any[], prefix: string, out: RegisteredRoute[]) {
  for (const layer of stack) {
    if (layer.route) {
      const authenticated = layer.route.stack.some((l: any) => l.name === 'requireAuth');
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, authenticated });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), out);
    }
  }
}

export function listRoutes(app: Express): RegisteredRoute[] {
  const stack = (app as any)._router?.stack ?? (app as any).router?.stack;
  const out: RegisteredRoute[] = [];
  if (stack) walk(stack, '', out);
  return out;
}

const TABLE = 'src/server/authz/routeTable.ts';

/**
 * Whether the routes' authentication can be read at all. It is read from the NAME of the route's handler (requireAuth), which the
 * test and development builds keep and the minified server bundle does not (esbuild renames it). When no route shows it, the
 * cross-check between a rule and the route's own requireAuth is skipped: the runtime layer authenticates every `perm` rule
 * itself, so the table stays the authority, and the tests (which run unbundled) still make the cross-check.
 */
export const canCheckAuthentication = (routes: readonly RegisteredRoute[]): boolean => routes.some(r => r.authenticated);

export function findContractViolations(app: Express): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const routes = listRoutes(app);
  const checkAuth = canCheckAuthentication(routes);
  for (const r of routes) {
    const route = `${r.method} ${r.path.replace(/^\/api(?=\/)/, '')}`;
    if (seen.has(route)) violations.push({ route, problem: 'duplicate', message: 'registered twice: the later handler is shadowed', fix: 'remove one registration' });
    seen.add(route);
    const rule = ROUTE_RULES[route];
    if (!rule) {
      violations.push({ route, problem: 'no-rule', message: 'has no permission rule, so nobody may call it', fix: `add '${route}': perm('<permission.code>', { body: [...] }) to ${TABLE}` });
      continue;
    }
    if (checkAuth && (rule.kind === 'public') === r.authenticated) {
      violations.push({
        route, problem: 'auth-mismatch',
        message: rule.kind === 'public' ? 'is declared public but runs requireAuth' : 'is declared protected but does not run requireAuth',
        fix: `make the rule in ${TABLE} and the route agree`,
      });
    }
    if (/^(POST|PUT|PATCH|DELETE) /.test(route) && rule.body === undefined) {
      violations.push({ route, problem: 'no-body', message: 'changes data but its rule does not list the keys it accepts', fix: `give the rule a body (a Zod schema, a list of keys, or [] for none) in ${TABLE}` });
    }
  }
  for (const route of Object.keys(ROUTE_RULES)) {
    if (!seen.has(route)) violations.push({ route, problem: 'stale-rule', message: 'is in the route table but no such route is registered', fix: `remove it from ${TABLE}, or register the route` });
  }
  return violations;
}

/** Throws, listing every violation with the line to fix it, when the table and the registered routes disagree. */
export function assertRouteContract(app: Express): void {
  const violations = findContractViolations(app);
  if (violations.length === 0) return;
  throw new Error(
    `The route table (${TABLE}) and the registered routes disagree, so the application will not start:\n` +
    violations.map(v => `  - ${v.route} ${v.message}. Fix: ${v.fix}.`).join('\n'),
  );
}
