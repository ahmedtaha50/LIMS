import React, { useState } from 'react';
import { useToast } from './ui/Toast';
import { Actor, FieldDiff, apiError, usePaged, when, type AuditEntry } from './RecordHistory';
import { SecurityLog } from './SecurityLog';
import { History, ShieldCheck, ShieldAlert, Download, Filter } from 'lucide-react';

interface Verification {
  isValid: boolean; compromisedSequence: number | null; reason: string | null; totalRecords: number; headSequence: number;
  versions: Record<string, number>; checkpointsAdded: number; verifiedAt: string;
}

const REASON_TEXT: Record<string, string> = {
  LINK_BROKEN: 'the entry, or its link to the entry before it, was changed',
  SEAL_BROKEN: 'the recorded actor, session or version of the entry was changed',
  CHECKPOINT_MISMATCH: 'a stored checkpoint no longer matches the audit trail',
  UNSUPPORTED_ALG: 'the entry uses a hash algorithm this version cannot check',
  UNSUPPORTED_VERSION: 'the entry uses a hash version this version cannot check',
};

const EMPTY = { entity: '', entityId: '', userId: '', actorRole: '', action: '', from: '', to: '' };
type Filters = typeof EMPTY;

/** Filter values to query parameters: empty ones are left out, the datetime-local inputs become ISO instants. */
function toParams(f: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (!v.trim()) continue;
    out[k] = k === 'from' || k === 'to' ? new Date(v).toISOString() : v.trim();
  }
  return out;
}

export function AuditTrail({ token }: { token: string }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<'trail' | 'security'>('trail');
  const [form, setForm] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Record<string, string>>({ limit: '50' });
  const { items: entries, hasMore, loading, error, loadMore, reload } = usePaged<AuditEntry>(token, '/api/audit', applied, 'entries', tab === 'trail');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportReason, setExportReason] = useState('');
  const [exporting, setExporting] = useState(false);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault();
    try { setApplied({ ...toParams(form), limit: '50' }); } catch { toast('One of the dates is not valid.', 'error'); }
  };
  const reset = () => { setForm(EMPTY); setApplied({ limit: '50' }); };
  const showRecord = (entity: string, entityId: string) => {
    const next = { ...EMPTY, entity, entityId };
    setForm(next);
    setApplied({ ...toParams(next), limit: '50' });
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerification(null);
    try {
      const res = await fetch('/api/audit/verify', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await apiError(res));
      const data: Verification = await res.json();
      setVerification(data);
      if (data.isValid) toast('Audit trail is intact.', 'success');
      else toast(`COMPROMISED at sequence ${data.compromisedSequence}`, 'error');
    } catch (err: any) {
      toast(`Verification failed: ${err.message}`, 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (exportReason.trim().length < 3) { toast('Enter the reason for the export (at least 3 characters).', 'error'); return; }
    setExporting(true);
    try {
      const { limit: _page, ...filters } = applied; // the filters on screen, not the page size
      const res = await fetch('/api/audit/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...filters, reason: exportReason.trim() }),
      });
      if (!res.ok) throw new Error(await apiError(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'audit-trail.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Audit trail exported. The export has been recorded in the audit trail.', 'success');
      setExportOpen(false);
      setExportReason('');
      reload(); // shows the Export entry just written
    } catch (err: any) {
      toast(`Export failed: ${err.message}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  const input = 'block mt-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-normal';

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><History /> 21 CFR Part 11 Audit Trail</h2>
        {tab === 'trail' && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setExportOpen(o => !o)} className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50">
              <Download className="w-4 h-4" /> Export CSV
            </button>
            <button type="button" onClick={handleVerify} disabled={verifying} className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors disabled:opacity-50">
              {verifying ? <History className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Verify Cryptographic Integrity
            </button>
          </div>
        )}
      </div>

      <div role="tablist" className="flex gap-1 mb-4 border-b border-slate-200">
        {([['trail', 'Audit trail'], ['security', 'Security events']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === id ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{label}</button>
        ))}
      </div>

      {tab === 'security' ? <SecurityLog token={token} /> : (
        <>
          {verification && (
            <div role="status" data-testid="verification" className={`p-4 rounded-xl mb-6 flex items-start gap-4 border ${verification.isValid ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'}`}>
              {verification.isValid ? <ShieldCheck className="w-6 h-6 text-emerald-600 shrink-0" /> : <ShieldAlert className="w-6 h-6 text-red-600 shrink-0" />}
              <div>
                <h4 className="font-bold">{verification.isValid ? 'Cryptographic Chain Validated' : 'SYSTEM COMPROMISED'}</h4>
                <p className="text-sm mt-1">
                  {verification.isValid
                    ? `All ${verification.totalRecords} entries are linked and unchanged (${Object.entries(verification.versions).map(([v, n]) => `${n} in format ${v}`).join(', ') || 'none'}). ${verification.checkpointsAdded ? `${verification.checkpointsAdded} checkpoint(s) recorded.` : ''}`
                    : `Entry ${verification.compromisedSequence} fails verification: ${REASON_TEXT[verification.reason || ''] || 'it does not match its record'}. The database was changed outside the application.`}
                </p>
              </div>
            </div>
          )}

          {exportOpen && (
            <form onSubmit={handleExport} className="mb-4 flex flex-wrap items-end gap-3 bg-white border border-slate-200 rounded-xl p-4">
              <label className="text-xs font-semibold text-slate-600 grow">Reason for the export (recorded in the audit trail)
                <input value={exportReason} onChange={e => setExportReason(e.target.value)} maxLength={500} className={`${input} w-full`} placeholder="e.g. Quarterly audit trail review" />
              </label>
              <p className="text-xs text-slate-500 w-full">The file contains every entry that matches the filters below as they are now applied: {Object.keys(applied).filter(k => k !== 'limit').join(', ') || 'none (the whole trail)'}.</p>
              <button type="submit" disabled={exporting} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50">{exporting ? 'Exporting…' : 'Download'}</button>
            </form>
          )}

          <form onSubmit={apply} className="flex flex-wrap items-end gap-3 mb-4 bg-white border border-slate-200 rounded-xl p-4" aria-label="Filters">
            <label className="text-xs font-semibold text-slate-600">Record type<input value={form.entity} onChange={set('entity')} className={`${input} w-32`} placeholder="Sample" /></label>
            <label className="text-xs font-semibold text-slate-600">Record id<input value={form.entityId} onChange={set('entityId')} className={`${input} w-40`} placeholder="SMP-2026-00001" /></label>
            <label className="text-xs font-semibold text-slate-600">User id<input value={form.userId} onChange={set('userId')} className={`${input} w-32`} /></label>
            <label className="text-xs font-semibold text-slate-600">Role
              <select value={form.actorRole} onChange={set('actorRole')} className={input}>
                <option value="">Any</option><option>Analyst</option><option>Reviewer</option><option>QA</option><option>Admin</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600">Action<input value={form.action} onChange={set('action')} className={`${input} w-32`} placeholder="Transition" /></label>
            <label className="text-xs font-semibold text-slate-600">From<input type="datetime-local" value={form.from} onChange={set('from')} className={input} /></label>
            <label className="text-xs font-semibold text-slate-600">To<input type="datetime-local" value={form.to} onChange={set('to')} className={input} /></label>
            <button type="submit" className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"><Filter className="w-4 h-4" /> Apply</button>
            <button type="button" onClick={reset} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50">Reset</button>
          </form>

          {error && <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error} <button type="button" className="underline ms-2" onClick={reload}>Try again</button></div>}

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
            <table className="w-full table-fixed text-start text-sm" data-testid="audit-table">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-3 w-14 font-semibold text-slate-600">Seq</th>
                  <th className="p-3 w-32 font-semibold text-slate-600">Time</th>
                  <th className="p-3 w-40 font-semibold text-slate-600">Actor</th>
                  <th className="p-3 w-28 font-semibold text-slate-600">Action</th>
                  <th className="p-3 w-36 font-semibold text-slate-600">Record</th>
                  <th className="p-3 font-semibold text-slate-600">Changes</th>
                  <th className="p-3 w-48 font-semibold text-slate-600">Reason</th>
                  <th className="p-3 w-24 font-semibold text-slate-600">Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => {
                  const t = when(e);
                  return (
                    <tr key={e.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                      <td className="p-3 font-mono text-slate-500">{e.sequence}</td>
                      <td className="p-3 text-xs text-slate-600" title={`${t.utc} (UTC)`}>{t.local}</td>
                      <td className="p-3 break-words"><Actor entry={e} /></td>
                      <td className="p-3 font-semibold text-blue-600 break-words">{e.action}</td>
                      <td className="p-3 break-words"><button type="button" className="text-start hover:underline" title="Show only this record" onClick={() => showRecord(e.entity, e.entityId)}>{e.entity}<div className="text-xs text-slate-500 break-all">{e.entityId}</div></button></td>
                      <td className="p-3 break-words"><FieldDiff field={e.field} oldValue={e.oldValue} newValue={e.newValue} /></td>
                      <td className="p-3 text-xs break-words" data-testid="reason">{e.reason || '—'}</td>
                      <td className="p-3 font-mono text-xs text-slate-400 truncate" title={`${e.hash} (format ${e.hashVersion}, ${e.hashAlg})`}>{e.hash}</td>
                    </tr>
                  );
                })}
                {!loading && !error && entries.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-500">No audit entries match.</td></tr>}
              </tbody>
            </table>
          </div>
          {loading && <p className="text-sm text-slate-500 mt-3">Loading…</p>}
          {hasMore && !loading && <button type="button" onClick={loadMore} className="mt-3 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">Load older entries</button>}
        </>
      )}
    </div>
  );
}
