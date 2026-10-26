import { formatDateTime } from '../lib/format';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { useToast } from './ui/Toast';

/** Message of a failed API answer, in words a person can act on. */
export async function apiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) return 'Your session has expired. Sign in again.';
  if (res.status === 403) return body.error || 'You are not allowed to see this.';
  return body.error || `The request failed (${res.status}).`;
}

/** The ToastProvider makes a new `toast` function on every render; an effect that depended on it would refetch (and, on an error, toast again) forever. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Keyset-paged list from one of the audit endpoints. `reload` fetches the first page for the current params, `loadMore` the
 * next one below the last row seen, so rows added while the screen is open never shift a page. A failure shows a toast and
 * stays on screen as `error`; the list is never left looking empty by accident.
 */
export function usePaged<T>(token: string, path: string, params: Record<string, string>, listKey: 'entries' | 'events', enabled = true) {
  const toastRef = useLatest(useToast().toast);
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify(params);

  const fetchPage = useCallback(async (after: number | null) => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams(JSON.parse(key));
      if (after !== null) query.set('cursor', String(after));
      const res = await fetch(`${path}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await apiError(res));
      const data = await res.json();
      if (ticket !== latest.current) return; // a newer request superseded this one
      setItems(prev => (after === null ? data[listKey] : [...prev, ...data[listKey]]));
      setCursor(data.nextCursor);
      setHasMore(Boolean(data.hasMore));
    } catch (err: any) {
      if (ticket !== latest.current) return;
      setError(err.message);
      toastRef.current(err.message, 'error');
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [token, path, key, listKey, toastRef]);

  useEffect(() => { if (enabled) fetchPage(null); }, [enabled, fetchPage]);

  return { items, hasMore, loading, error, reload: () => fetchPage(null), loadMore: () => (cursor !== null ? fetchPage(cursor) : undefined) };
}

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max)}…` : text);

function asObject(text: string): Record<string, unknown> | null {
  if (!text || text[0] !== '{') return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const show = (v: unknown) => clip(typeof v === 'string' ? v : JSON.stringify(v));

/** What a change did: the changed keys of a JSON record, or old -> new for a plain value. Long values open on click. */
export function FieldDiff({ field, oldValue, newValue }: { field: string; oldValue: string; newValue: string }) {
  const [open, setOpen] = useState(false);
  const before = asObject(oldValue), after = asObject(newValue);

  if (after && (before || !oldValue)) {
    const keys = Object.keys(after).filter(k => !before || JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const shown = open ? keys : keys.slice(0, 4);
    return (
      <ul className="text-xs space-y-0.5">
        {shown.map(k => (
          <li key={k}>
            <span className="font-mono text-slate-500">{k}</span>{' '}
            {before && k in before ? <><del className="text-red-600">{show(before[k])}</del> → </> : null}
            <span className="text-emerald-700">{show(after[k])}</span>
          </li>
        ))}
        {keys.length > 4 && <li><button type="button" className="text-blue-600 hover:underline" onClick={() => setOpen(o => !o)}>{open ? 'Show less' : `+${keys.length - 4} more`}</button></li>}
        {keys.length === 0 && <li className="text-slate-400">no field changed</li>}
      </ul>
    );
  }

  if (!oldValue && !newValue) return <span className="text-xs text-slate-400">{field && field !== 'all' ? field : '—'}</span>;
  const long = oldValue.length > 140 || newValue.length > 140;
  return (
    <div className="text-xs break-words">
      <span className="font-mono text-slate-500">{field}</span>{' '}
      {oldValue && <del className="text-red-600">{open ? oldValue : clip(oldValue)}</del>}
      {oldValue && newValue && ' → '}
      {newValue && <span className="text-emerald-700">{open ? newValue : clip(newValue)}</span>}
      {long && <button type="button" className="ms-2 text-blue-600 hover:underline" onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

export interface AuditEntry {
  id: string; sequence: number; timestamp: string; timestampStr: string | null; userId: string; actorName: string | null; actorRole: string | null;
  sessionId: string | null; appVersion: string | null; action: string; entity: string; entityId: string; field: string; oldValue: string; newValue: string;
  reason: string; hash: string; hashVersion: number; hashAlg: string;
}

/** Who did it: the name and role recorded when it happened, else the user id. */
export function Actor({ entry }: { entry: Pick<AuditEntry, 'userId' | 'actorName' | 'actorRole'> }) {
  return (
    <div>
      <div className="font-medium">{entry.actorName || entry.userId}</div>
      <div className="text-xs text-slate-500">{entry.actorRole ? `${entry.actorRole} · ` : ''}{entry.actorName ? entry.userId : ''}</div>
    </div>
  );
}

export const when = (entry: Pick<AuditEntry, 'timestamp' | 'timestampStr'>) => ({
  local: formatDateTime(entry.timestampStr || entry.timestamp),
  utc: entry.timestampStr || new Date(entry.timestamp).toISOString(),
});

/**
 * The History tab of one record: every audit entry about it, newest first, with who, when, why and what changed.
 * `related` adds the records it is made of (for a sample: its results), so the tab tells the whole story.
 * Readable by Admin, QA and Reviewer (GET /api/audit/history).
 */
export function RecordHistory({ token, entity, entityId, related }: { token: string; entity: string; entityId: string; related?: Array<{ entity: string; entityId: string }> }) {
  const params: Record<string, string> = { entity, entityId, limit: '50' };
  if (related?.length) params.refs = related.map(r => `${r.entity}:${r.entityId}`).join(',');
  const { items, hasMore, loading, error, loadMore, reload } = usePaged<AuditEntry>(token, '/api/audit/history', params, 'entries');

  return (
    <div data-testid="record-history">
      <div className="flex items-center gap-2 mb-3 text-slate-700 font-semibold"><History className="w-4 h-4" /> History of {entity} {entityId}</div>
      {error && <div role="alert" className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error} <button type="button" className="underline ms-2" onClick={reload}>Try again</button></div>}
      {!error && !loading && items.length === 0 && <p className="text-sm text-slate-500">No audit entries for this record.</p>}
      <ol className="space-y-3">
        {items.map(e => {
          const t = when(e);
          return (
            <li key={e.id} className="border border-slate-200 rounded-lg p-3 bg-white">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-blue-700">{e.action}{e.entity !== entity || e.entityId !== entityId ? <span className="font-normal text-slate-500"> · {e.entity} {e.entityId}</span> : null}</span>
                <span className="text-xs text-slate-500" title={`${t.utc} (UTC)`}>{t.local}</span>
              </div>
              <div className="text-sm mt-1"><Actor entry={e} /></div>
              <div className="mt-2"><FieldDiff field={e.field} oldValue={e.oldValue} newValue={e.newValue} /></div>
              {e.reason && <p className="text-xs text-slate-600 mt-2"><span className="font-semibold">Reason:</span> {e.reason}</p>}
              <p className="text-[10px] font-mono text-slate-400 mt-1 truncate" title={e.hash}>#{e.sequence} · {e.hash}</p>
            </li>
          );
        })}
      </ol>
      {loading && <p className="text-sm text-slate-500 mt-3">Loading…</p>}
      {hasMore && !loading && <button type="button" onClick={loadMore} className="mt-3 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">Load older entries</button>}
    </div>
  );
}
