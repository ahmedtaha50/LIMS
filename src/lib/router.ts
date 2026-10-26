/**
 * The hash router (roadmap M24). The address of a screen is the part after '#':
 *
 *     #/<view>/<segment>/...?<query>        e.g. #/samples/SMP-2026-00001   #/samples?state=Testing&sort=material&dir=asc
 *
 * A hash, not a path, because the desktop application serves the client on a random local port and from a file-like origin:
 * there is no server-side route for /samples/..., but a hash survives a reload, can be pasted, and Back/Forward work.
 *
 *   useRoute()                  the current route; the component re-renders when it changes
 *   navigate(hash, {replace})   go somewhere (a new history entry, or replace the current one)
 *   setQuery(patch, {push})     change some query keys of the current route (replace by default: typing in a search box must
 *                               not fill the history); null or '' removes a key
 *   formatHash / parseHash      build and read addresses; ids are URI-encoded, so any record id is safe in a segment
 *
 * Without a window (server rendering, tests of markup) every function is a no-op and the route is empty.
 */
import { useMemo, useSyncExternalStore } from 'react';

export interface Route {
  /** The first segment: the screen ('samples', 'inbox', ...). '' when the hash is empty. */
  view: string;
  /** The segments after the view, decoded (a record id, a tab). */
  segments: string[];
  query: URLSearchParams;
}

export type QueryValue = string | number | null | undefined;

/** Fired on window after navigate(..., { replace: true }) and setQuery, which a browser does not announce with 'hashchange'. */
const ROUTE_EVENT = 'lims:route';

const win = (): (Window & typeof globalThis) | undefined => (typeof window === 'undefined' ? undefined : window);

const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

export function parseHash(hash: string): Route {
  const raw = (hash ?? '').replace(/^#/, '');
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
  const parts = pathPart.split('/').filter(Boolean).map(decode);
  if (parts.some(p => p === null)) return { view: '', segments: [], query };
  const [view = '', ...segments] = parts as string[];
  return { view, segments, query };
}

export function formatHash(view: string, segments: readonly string[] = [], query?: Record<string, QueryValue> | URLSearchParams): string {
  const path = [view, ...segments].map(s => encodeURIComponent(s)).join('/');
  const params = new URLSearchParams();
  if (query instanceof URLSearchParams) query.forEach((v, k) => { if (v !== '') params.set(k, v); });
  else if (query) for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

const currentHash = () => win()?.location.hash ?? '';

export function readRoute(): Route {
  return parseHash(currentHash());
}

export function subscribeRoute(listener: () => void): () => void {
  const w = win();
  if (!w) return () => {};
  w.addEventListener('hashchange', listener);
  w.addEventListener(ROUTE_EVENT, listener);
  return () => { w.removeEventListener('hashchange', listener); w.removeEventListener(ROUTE_EVENT, listener); };
}

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  const w = win();
  if (!w) return;
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (target === currentHash()) return;
  if (options.replace) {
    w.history.replaceState(w.history.state ?? null, '', target);
    w.dispatchEvent(new Event(ROUTE_EVENT));
  } else {
    w.location.hash = target; // a new history entry; the browser fires 'hashchange'
  }
}

/** Merges `patch` into the current route's query. */
export function setQuery(patch: Record<string, QueryValue>, options: { push?: boolean } = {}): void {
  const { view, segments, query } = readRoute();
  const next = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') next.delete(k);
    else next.set(k, String(v));
  }
  navigate(formatHash(view, segments, next), { replace: !options.push });
}

/** The current route. Snapshots are the hash string, so a re-render happens only when the address really changed. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}
