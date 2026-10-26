import { formatDateTime } from '../lib/format';
import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { apiError, useLatest, usePaged } from './RecordHistory';
import { useToast } from './ui/Toast';

interface SecurityEvent {
  id: string; sequence: number; timestamp: string; timestampStr: string; eventType: string; outcome: 'success' | 'failure' | 'denied' | 'info';
  actorId: string | null; actorLabel: string | null; actorRole: string | null; ip: string | null; requestId: string | null; detail: string;
}

const OUTCOME_STYLE: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failure: 'bg-red-50 text-red-700 border-red-200',
  denied: 'bg-amber-50 text-amber-800 border-amber-200',
  info: 'bg-slate-50 text-slate-600 border-slate-200',
};

const REASON_TEXT: Record<string, string> = {
  LINK_BROKEN: 'an event, or its link to the one before, was changed',
  UNSUPPORTED_ALG: 'an event uses a hash algorithm this version cannot check',
  UNSUPPORTED_VERSION: 'an event uses a hash version this version cannot check',
};

/** Sign-in, lockout, refusal, export and configuration events (Admin and QA). */
export function SecurityLog({ token }: { token: string }) {
  const { toast } = useToast();
  const toastRef = useLatest(toast);
  const [type, setType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({ limit: '50' });
  const [types, setTypes] = useState<string[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<{ isValid: boolean; compromisedSequence: number | null; reason: string | null; totalRecords: number } | null>(null);
  const { items, hasMore, loading, error, loadMore, reload } = usePaged<SecurityEvent>(token, '/api/security-events', applied, 'events');

  useEffect(() => {
    fetch('/api/security-events/types', { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => { if (!res.ok) throw new Error(await apiError(res)); return res.json(); })
      .then(d => setTypes(d.types))
      .catch(err => toastRef.current(err.message, 'error'));
  }, [token, toastRef]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = { limit: '50' };
    if (type) next.type = type;
    if (outcome) next.outcome = outcome;
    if (from) next.from = new Date(from).toISOString();
    if (to) next.to = new Date(to).toISOString();
    setApplied(next);
  };

  const verify = async () => {
    setVerifying(true);
    setVerdict(null);
    try {
      const res = await fetch('/api/security-events/verify', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await apiError(res));
      const data = await res.json();
      setVerdict(data);
      if (data.isValid) toast('Security event log is intact.', 'success');
      else toast(`Security event log COMPROMISED at event ${data.compromisedSequence}.`, 'error');
    } catch (err: any) {
      toast(`Verification failed: ${err.message}`, 'error');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div data-testid="security-log">
      <form onSubmit={apply} className="flex flex-wrap items-end gap-3 mb-4 bg-white border border-slate-200 rounded-xl p-4">
        <label className="text-xs font-semibold text-slate-600">Event
          <select value={type} onChange={e => setType(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-normal">
            <option value="">All</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">Outcome
          <select value={outcome} onChange={e => setOutcome(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-normal">
            <option value="">All</option>
            <option value="success">success</option><option value="failure">failure</option><option value="denied">denied</option><option value="info">info</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">From
          <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-normal" />
        </label>
        <label className="text-xs font-semibold text-slate-600">To
          <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} className="block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-normal" />
        </label>
        <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800">Apply</button>
        <button type="button" onClick={verify} disabled={verifying} className="ms-auto flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          <ShieldCheck className="w-4 h-4" /> {verifying ? 'Verifying…' : 'Verify log'}
        </button>
      </form>

      {verdict && (
        <div role="status" className={`p-4 rounded-xl mb-4 flex items-start gap-3 border ${verdict.isValid ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'}`}>
          {verdict.isValid ? <ShieldCheck className="w-5 h-5 shrink-0 text-emerald-600" /> : <ShieldAlert className="w-5 h-5 shrink-0 text-red-600" />}
          <p className="text-sm">{verdict.isValid
            ? `All ${verdict.totalRecords} security events are linked and unchanged.`
            : `Event ${verdict.compromisedSequence} fails verification: ${REASON_TEXT[verdict.reason || ''] || 'it does not match its record'}.`}</p>
        </div>
      )}

      {error && <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error} <button type="button" className="underline ms-2" onClick={reload}>Try again</button></div>}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full text-start text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="p-3 font-semibold text-slate-600">#</th><th className="p-3 font-semibold text-slate-600">Time</th><th className="p-3 font-semibold text-slate-600">Event</th>
              <th className="p-3 font-semibold text-slate-600">Outcome</th><th className="p-3 font-semibold text-slate-600">Who</th><th className="p-3 font-semibold text-slate-600">Address</th><th className="p-3 font-semibold text-slate-600">Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.map(e => (
              <tr key={e.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="p-3 font-mono text-slate-500">{e.sequence}</td>
                <td className="p-3 whitespace-nowrap text-slate-600" title={`${e.timestampStr} (UTC)`}>{formatDateTime(e.timestampStr)}</td>
                <td className="p-3 font-semibold text-blue-700">{e.eventType}</td>
                <td className="p-3"><span className={`px-2 py-0.5 rounded-full border text-xs font-semibold ${OUTCOME_STYLE[e.outcome] || OUTCOME_STYLE.info}`}>{e.outcome}</span></td>
                <td className="p-3">{e.actorId || e.actorLabel || '—'}{e.actorRole ? <span className="text-xs text-slate-500"> · {e.actorRole}</span> : null}{e.actorId && e.actorLabel ? <div className="text-xs text-slate-500">{e.actorLabel}</div> : null}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{e.ip || '—'}</td>
                <td className="p-3 font-mono text-xs text-slate-600 max-w-xs break-words">{e.detail || '—'}</td>
              </tr>
            ))}
            {!loading && !error && items.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No security events match.</td></tr>}
          </tbody>
        </table>
      </div>
      {loading && <p className="text-sm text-slate-500 mt-3">Loading…</p>}
      {hasMore && !loading && <button type="button" onClick={loadMore} className="mt-3 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">Load older events</button>}
    </div>
  );
}
