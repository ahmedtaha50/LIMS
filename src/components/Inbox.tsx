import { formatDateTime } from '../lib/format';
import React, { useEffect, useState } from 'react';
import { Inbox as InboxIcon, RefreshCw } from 'lucide-react';
import { apiFetch, errorMessage } from '../lib/api';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/**
 * "My Tasks" (roadmap M24): what is waiting for the signed-in user, from GET /api/inbox. The server decides what the user's role may
 * act on and leaves out the records the user took part in (segregation of duties), so nothing here is offered that the user would
 * be refused. Each group is in the order the server applies, oldest first, and says so.
 */
interface InboxItem { id: string; entity: string; title: string; detail: string; since: string | null; href: string }
interface InboxGroup { key: string; title: string; count: number; order: 'oldest-first'; items: InboxItem[]; more: boolean }
interface InboxAnswer { generatedAt: string; groups: InboxGroup[] }

const when = (iso: string | null) => (iso ? formatDateTime(iso) : '');

export function Inbox() {
  const [data, setData] = useState<InboxAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    apiFetch<InboxAnswer>('/inbox', { signal: ctl.signal })
      .then(d => { setData(d); setFailure(null); })
      .catch(e => { if (!ctl.signal.aborted) setFailure(errorMessage(e)); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [attempt]);

  const waiting = data?.groups.filter(g => g.count > 0) ?? [];
  const clear = data?.groups.filter(g => g.count === 0) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2"><InboxIcon className="w-5 h-5" aria-hidden="true" /> Waiting for you</h3>
        <Button size="sm" onClick={() => setAttempt(a => a + 1)} busy={loading}><RefreshCw className="w-4 h-4" aria-hidden="true" /> Refresh</Button>
      </div>

      {loading && !data && <p role="status" className="text-slate-600">Loading your tasks...</p>}
      {failure && (
        <div role="alert" className="p-4 rounded-lg border border-red-200 bg-red-50 text-red-800 flex flex-wrap items-center gap-3">
          <span>Could not load your tasks: {failure}</span>
          <Button size="sm" onClick={() => setAttempt(a => a + 1)}>Try again</Button>
        </div>
      )}

      {data && waiting.length === 0 && (
        <p role="status" className="p-6 rounded-xl border border-slate-200 bg-white text-slate-700">
          Nothing is waiting for you.{clear.length > 0 && ` Checked: ${clear.map(g => g.title.toLowerCase()).join(', ')}.`}
        </p>
      )}

      {waiting.map(g => (
        <section key={g.key} aria-labelledby={`inbox-${g.key}`} className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <header className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <h4 id={`inbox-${g.key}`} className="font-semibold text-slate-800 flex items-center gap-2">{g.title} <Badge tone="info">{g.count}</Badge></h4>
            <span className="text-xs text-slate-600">Oldest first{g.more ? `, showing ${g.items.length} of ${g.count}` : ''}</span>
          </header>
          <ul className="divide-y divide-slate-100">
            {g.items.map(item => (
              <li key={`${item.entity}:${item.id}`} className="ui-row px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <a href={item.href} className="font-mono font-semibold text-blue-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">{item.title}</a>
                  <p className="text-sm text-slate-700">{item.detail}</p>
                </div>
                {item.since && <span className="text-xs text-slate-600">since {when(item.since)}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
