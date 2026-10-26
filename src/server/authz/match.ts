/**
 * Finds the rule of a request: the most specific "METHOD /path/:param" key of the route table that matches. Express matches case
 * insensitively and ignores a trailing slash; so does this. A request with no matching key has no route.
 */
import { ROUTE_RULES } from './routeTable';
import type { RouteRule } from './types';

interface Compiled { key: string; method: string; regex: RegExp; names: string[]; literals: number; rule: RouteRule }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compiled: Compiled[] = Object.entries(ROUTE_RULES).map(([key, rule]) => {
  const [method, pattern] = key.split(' ');
  const names: string[] = [];
  let literals = 0;
  const source = pattern.split('/').map(seg => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    if (seg) literals++;
    return escape(seg);
  }).join('/');
  return { key, method, regex: new RegExp(`^${source}/?$`, 'i'), names, literals, rule };
}).sort((a, b) => b.literals - a.literals || a.names.length - b.names.length);

export interface MatchedRule { key: string; rule: RouteRule; /** The route pattern, e.g. "/samples/:id/transition". */ route: string; params: Record<string, string> }

const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };

export function matchRule(method: string, path: string): MatchedRule | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const c of compiled) {
    if (c.method !== m) continue;
    const hit = c.regex.exec(path);
    if (!hit) continue;
    return { key: c.key, rule: c.rule, route: c.key.slice(c.method.length + 1), params: Object.fromEntries(c.names.map((n, i) => [n, decode(hit[i + 1])])) };
  }
  return null;
}
