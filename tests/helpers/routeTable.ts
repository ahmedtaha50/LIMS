/**
 * Route-table extraction for the characterization test (tests/route-table.json).
 *
 * Walks an Express 4 Router stack and returns one entry per registered (method, path),
 * flagging whether `requireAuth` is in the handler chain. The table is the public contract
 * of the API surface: a refactor that adds, drops or un-protects a route changes it.
 */
import type { Express, Router } from 'express';

export interface RouteEntry {
  method: string;
  path: string;
  auth: boolean;
}

/** Recover a static mount prefix from a nested router layer's regexp; '' for a mount at '/'. */
function mountPrefix(layer: any): string {
  if (layer.keys && layer.keys.length) throw new Error('Parameterised router mounts are not supported by the route table');
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = /^\^((?:\\\/[^\\/()?*+[\]{}|^$]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
  if (!m) throw new Error(`Unsupported router mount pattern: ${src}`);
  return m[1].replace(/\\\//g, '/');
}

interface RawRoute extends RouteEntry {
  handlers: Function[];
}

function walk(stack: any[], prefix: string, out: RawRoute[]) {
  for (const layer of stack) {
    if (layer.route) {
      const auth = layer.route.stack.some((l: any) => l.name === 'requireAuth');
      const handlers = layer.route.stack.map((l: any) => l.handle);
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, auth, handlers });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), out);
    }
  }
}

function rawRoutes(target: Express | Router): RawRoute[] {
  const stack = (target as any).stack ?? (target as any)._router?.stack;
  if (!stack) throw new Error('No router stack found: mount at least one router or route first');
  const out: RawRoute[] = [];
  walk(stack, '', out);
  return out;
}

/** Accepts an Express application (paths include the /api mount) or a bare Router. */
export function extractRouteTable(target: Express | Router): RouteEntry[] {
  return rawRoutes(target).map(({ method, path, auth }) => ({ method, path, auth }));
}

/** "METHOD /path" of every route that has a handler `isWrapped` does not recognise. */
export function routesWithUnwrappedHandlers(target: Express | Router, isWrapped: (fn: Function) => boolean): string[] {
  return rawRoutes(target).filter(r => !r.handlers.every(isWrapped)).map(r => `${r.method} ${r.path}`).sort();
}

/** Stable order so a diff only shows real changes (registration order is not part of the contract). */
export function sortRouteTable(entries: RouteEntry[]): RouteEntry[] {
  return [...entries].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path));
}
