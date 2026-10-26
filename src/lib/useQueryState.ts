/**
 * View state kept in the URL query (roadmap M24): sort, filters, search and the page cursor of a list survive a reload, a pasted
 * link and Back/Forward, because they are part of the address (src/lib/router.ts) and not of a component's memory.
 *
 *   const [state, update] = useQueryState({ q: '', sort: { default: 'createdAt', oneOf: ['createdAt', 'id'] } });
 *   update({ q: 'para', after: null });           // replaces the history entry
 *   update({ after: cursor }, { push: true });     // a new history entry
 *
 * A key's spec is its default (a string), or { default, oneOf } to accept only known values (a hand-edited or stale link with an
 * unknown sort column falls back to the default instead of reaching the server).
 */
import { useCallback, useMemo } from 'react';
import { setQuery, useRoute, type QueryValue } from './router';

export type QueryKeySpec = string | { readonly default: string; readonly oneOf?: readonly string[] };
export type QuerySpec = Readonly<Record<string, QueryKeySpec>>;
export type QueryState<S extends QuerySpec> = { [K in keyof S]: string };

export function readQueryState<S extends QuerySpec>(query: URLSearchParams, spec: S): QueryState<S> {
  const out: Record<string, string> = {};
  for (const [key, s] of Object.entries(spec)) {
    const dflt = typeof s === 'string' ? s : s.default;
    const allowed = typeof s === 'string' ? undefined : s.oneOf;
    const v = query.get(key);
    out[key] = v === null || (allowed && !allowed.includes(v)) ? dflt : v;
  }
  return out as QueryState<S>;
}

export function useQueryState<S extends QuerySpec>(spec: S): [QueryState<S>, (patch: Partial<Record<keyof S, QueryValue>>, options?: { push?: boolean }) => void] {
  const { query } = useRoute();
  const state = useMemo(() => readQueryState(query, spec), [query, spec]);
  const update = useCallback((patch: Partial<Record<keyof S, QueryValue>>, options?: { push?: boolean }) => {
    // A value equal to the default is removed from the address: links stay short and canonical.
    const clean: Record<string, QueryValue> = {};
    for (const [k, v] of Object.entries(patch) as Array<[string, QueryValue]>) {
      const s = spec[k];
      const dflt = s === undefined ? undefined : typeof s === 'string' ? s : s.default;
      clean[k] = v !== null && v !== undefined && String(v) === dflt ? null : v;
    }
    setQuery(clean, options);
  }, [spec]);
  return [state, update];
}
