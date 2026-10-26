// Stability programme (roadmap M31). Owned by r2-stability.
//
// Studies, the pull calendar and protocols. A study is started from an Approved protocol revision and a master batch: product, batch,
// conditions and month points are the protocol's and the batch's, never typed. The calendar shows each timepoint with its pull window;
// Scheduled, Due and Missed are set by the server's schedule, a person only pulls (a sample is registered). A protocol is drafted,
// signed by someone else and never edited once Approved: a change is a new revision. What the user may do comes from
// GET /permissions/me; the server decides again on every call.
import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ClipboardList, Layers, Plus, ShieldCheck, ThermometerSun } from 'lucide-react';
import { useToast } from './ui/Toast';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';
import { STABILITY_FINAL_STATUSES } from '../lib/validations/stability';

interface Study {
  id: string; product: string; batch: string; condition: string; pullPoints: number[]; startDate: string; status: string; version: number;
  legacy: boolean; protocolCode: string | null; protocolRevision: number | null;
  counts: { total: number; due: number; overdue: number; missed: number; complete: number };
  nextDue: { month: number; conditionCode: string; dueDate: string } | null;
}
interface Timepoint {
  id: string; studyId: string; product: string; batch: string; conditionCode: string; month: number; dueDate: string; windowStart: string; windowEnd: string;
  status: string; overdue: boolean; version: number; sampleId: string | null; chamberCode: string | null; deviationId: string | null;
}
interface Protocol {
  id: string; code: string; title: string; revision: number; status: string; version: number; productId: string; productName: string; testPlanCode: string;
  monthPoints: number[]; windowDays: number; conditions: Array<{ conditionId: string; code: string }>; createdBy: string | null; createdByName?: string | null; approvedByName?: string | null;
}
interface Condition { id: string; code: string; name: string; status: string }
interface Product { id: string; name: string; status: string }
interface Batch { id: string; productId: string; batchNo: string; status: string }

const STATUS_STYLE: Record<string, string> = {
  Ongoing: 'bg-blue-100 text-blue-800 border-blue-200', Completed: 'bg-emerald-100 text-emerald-800 border-emerald-200', Aborted: 'bg-red-100 text-red-800 border-red-200',
  Scheduled: 'bg-slate-100 text-slate-700 border-slate-200', Due: 'bg-amber-100 text-amber-800 border-amber-200', Missed: 'bg-red-100 text-red-800 border-red-200',
  Pulled: 'bg-blue-100 text-blue-800 border-blue-200', InTesting: 'bg-indigo-100 text-indigo-800 border-indigo-200', Complete: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  Draft: 'bg-amber-100 text-amber-800 border-amber-200', Approved: 'bg-emerald-100 text-emerald-800 border-emerald-200', Superseded: 'bg-slate-200 text-slate-600 border-slate-300',
};
const Badge = ({ status, overdue }: { status: string; overdue?: boolean }) => (
  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${STATUS_STYLE[status] ?? STATUS_STYLE.Scheduled}`}>{overdue ? `${status} · overdue` : status}</span>
);
const input = 'px-3 py-1.5 border border-slate-300 rounded text-sm';

type Tab = 'studies' | 'calendar' | 'protocols';

export function StabilityStudies({ token, user }: { token: string; user: any }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('studies');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [calendar, setCalendar] = useState<Timepoint[]>([]);
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState('');
  const [calendarFilter, setCalendarFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [newStudy, setNewStudy] = useState<{ protocolId: string; batchId: string; startDate: string } | null>(null);
  const [ending, setEnding] = useState<{ study: Study; status: 'Completed' | 'Aborted'; reason: string } | null>(null);
  const [drafting, setDrafting] = useState<{ id?: string; version?: number; code: string; title: string; productId: string; testPlanCode: string; conditionIds: string[]; monthPoints: string; windowDays: string } | null>(null);
  const [approving, setApproving] = useState<Protocol | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, p] = await Promise.all([apiFetch<Study[]>('/stability'), apiFetch<Timepoint[]>('/stability/timepoints'), apiFetch<Protocol[]>('/stability/protocols')]);
      setStudies(s); setCalendar(c); setProtocols(p);
    } catch (err) { toast.error(errorMessage(err, 'The stability studies could not be loaded.')); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => {
    load();
    apiFetch<{ permissions: string[] }>('/permissions/me').then(me => setPermissions(me.permissions))
      .catch(err => toast.error(errorMessage(err, 'Your permissions could not be loaded; actions are hidden.')));
    Promise.all([apiFetch<Condition[]>('/stability/conditions'), apiFetch<Product[]>('/products'), apiFetch<Batch[]>('/batches')])
      .then(([c, p, b]) => { setConditions(c); setProducts(p); setBatches(b); })
      .catch(err => toast.error(errorMessage(err, 'Conditions, products and batches could not be loaded.')));
  }, [load, toast]);

  const can = (code: string) => permissions.includes(code);
  const approved = protocols.filter(p => p.status === 'Approved');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const startStudy = () => act(async () => {
    if (!newStudy) return;
    const s = await apiFetch<Study>('/stability', { method: 'POST', body: newStudy });
    toast.success(`Study ${s.id} started: its pull calendar is generated.`);
    setNewStudy(null); await load();
  });
  const endStudy = () => act(async () => {
    if (!ending) return;
    await apiFetch(`/stability/${ending.study.id}`, { method: 'PUT', body: { status: ending.status, reason: ending.reason.trim(), expectedVersion: ending.study.version } });
    toast.success(`Study ${ending.study.id} ${ending.status.toLowerCase()}.`);
    setEnding(null); await load();
  });
  const pull = (tp: Timepoint) => act(async () => {
    const r = await apiFetch<{ sample: { id: string } }>(`/stability/timepoints/${tp.id}/pull`, { method: 'POST', body: { expectedVersion: tp.version } });
    toast.success(`Pulled: sample ${r.sample.id} registered with the test plan.`);
    await load();
  });
  const saveProtocol = () => act(async () => {
    if (!drafting) return;
    const monthPoints = drafting.monthPoints.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    const body: Record<string, unknown> = { title: drafting.title, testPlanCode: drafting.testPlanCode, conditionIds: drafting.conditionIds, monthPoints, windowDays: Number(drafting.windowDays) };
    if (drafting.id) { body.expectedVersion = drafting.version; await apiFetch(`/stability/protocols/${drafting.id}`, { method: 'PUT', body }); }
    else await apiFetch('/stability/protocols', { method: 'POST', body: { ...body, code: drafting.code, productId: drafting.productId } });
    toast.success('Protocol saved as a Draft (audit logged).');
    setDrafting(null); await load();
  });
  const revise = (p: Protocol) => act(async () => {
    const r = await apiFetch<Protocol>(`/stability/protocols/${p.id}/revise`, { method: 'POST', body: {} });
    toast.success(`Protocol ${r.code} Rev ${r.revision} drafted from Rev ${p.revision}.`);
    await load();
  });
  const approve = async (password: string, reason?: string, totpCode?: string) => {
    if (!approving) return;
    const body: Record<string, unknown> = { password, expectedVersion: approving.version };
    if (reason?.trim()) body.reason = reason.trim();
    if (totpCode) body.totpCode = totpCode;
    try {
      await apiFetch(`/stability/protocols/${approving.id}/approve`, { method: 'POST', body, replay: 'never' });
      toast.success(`Protocol ${approving.code} Rev ${approving.revision} approved.`);
      setApproving(null); await load();
    } catch (err) { toast.error(errorMessage(err)); throw err; }
  };

  const shownStudies = studies.filter(s => !filter || `${s.id} ${s.product} ${s.batch} ${s.condition}`.toLowerCase().includes(filter.toLowerCase()));
  const shownCalendar = calendar.filter(t => !calendarFilter || (calendarFilter === 'overdue' ? t.overdue : t.status === calendarFilter));

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-2 justify-between items-center">
        <div role="tablist" aria-label="Stability" className="flex gap-1">
          {([['studies', 'Studies', Layers], ['calendar', 'Pull calendar', CalendarClock], ['protocols', 'Protocols', ClipboardList]] as const).map(([t, label, Icon]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-white border border-slate-300 font-semibold' : 'text-slate-600'}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          {tab === 'studies' && <input type="search" aria-label="Search studies" placeholder="Search studies..." value={filter} onChange={e => setFilter(e.target.value)} className={input} />}
          {tab === 'calendar' && (
            <select aria-label="Filter the calendar" value={calendarFilter} onChange={e => setCalendarFilter(e.target.value)} className={input}>
              <option value="">All pulls</option>{['Scheduled', 'Due', 'overdue', 'Missed', 'Pulled', 'InTesting', 'Complete'].map(s => <option key={s} value={s}>{s === 'overdue' ? 'Overdue' : s}</option>)}
            </select>
          )}
          {tab === 'studies' && can('stability.create') && (
            <Button variant="primary" disabled={approved.length === 0} onClick={() => setNewStudy({ protocolId: approved[0]?.id ?? '', batchId: '', startDate: '' })}><Plus className="w-4 h-4" /> Start study</Button>
          )}
          {tab === 'protocols' && can('stability.manage') && (
            <Button variant="primary" onClick={() => setDrafting({ code: '', title: '', productId: '', testPlanCode: '', conditionIds: [], monthPoints: '0, 3, 6, 9, 12', windowDays: '7' })}><Plus className="w-4 h-4" /> New protocol</Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'studies' && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {shownStudies.map(s => (
              <div key={s.id} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm" data-study-id={s.id}>
                <div className="flex justify-between items-start mb-3 gap-2">
                  <div>
                    <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2"><ThermometerSun className="w-5 h-5 text-amber-500" /> {s.id}</h3>
                    <p className="text-sm font-semibold text-blue-600 mt-1">{s.product} · {s.batch}</p>
                    <p className="text-xs text-slate-500">{s.legacy ? 'Started before protocols (no pull calendar)' : `Protocol ${s.protocolCode} Rev ${s.protocolRevision}`} · started {s.startDate}</p>
                  </div>
                  <Badge status={s.status} />
                </div>
                <p className="text-sm text-slate-700">Conditions: {s.condition}</p>
                <p className="text-sm text-slate-700 mt-1">Month points: {s.pullPoints.join(', ')}</p>
                {!s.legacy && (
                  <p className="text-sm mt-2">
                    {s.counts.complete}/{s.counts.total} complete · {s.counts.due} due{s.counts.overdue > 0 && <strong className="text-red-700"> ({s.counts.overdue} overdue)</strong>} · {s.counts.missed} missed
                    {s.nextDue && <span className="text-slate-500"> · next {s.nextDue.conditionCode} month {s.nextDue.month}, {s.nextDue.dueDate}</span>}
                  </p>
                )}
                {!STABILITY_FINAL_STATUSES.includes(s.status) && can('stability.edit') && (
                  <div className="flex gap-2 mt-4 pt-3 border-t border-slate-100">
                    <Button onClick={() => setEnding({ study: s, status: 'Completed', reason: '' })}>Complete</Button>
                    <Button variant="danger" onClick={() => setEnding({ study: s, status: 'Aborted', reason: '' })}>Abort</Button>
                  </div>
                )}
              </div>
            ))}
            {shownStudies.length === 0 && !loading && <div className="col-span-2 text-center p-12 text-slate-500">No stability studies found.</div>}
          </div>
        )}

        {tab === 'calendar' && (
          <table className="w-full text-sm">
            <thead><tr className="text-start text-xs uppercase text-slate-500 border-b border-slate-200"><th className="py-2">Study</th><th>Condition</th><th>Month</th><th>Due</th><th>Window</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shownCalendar.map(t => (
                <tr key={t.id} className="border-b border-slate-100" data-timepoint-id={t.id}>
                  <td className="py-2"><span className="font-mono">{t.studyId}</span><br /><span className="text-xs text-slate-500">{t.product} · {t.batch}</span></td>
                  <td>{t.conditionCode}{t.chamberCode && <span className="text-xs text-slate-500"> ({t.chamberCode})</span>}</td>
                  <td>{t.month}</td><td>{t.dueDate}</td><td className="text-xs">{t.windowStart} to {t.windowEnd}</td>
                  <td><Badge status={t.status} overdue={t.overdue} />{t.deviationId && <span className="block text-xs text-red-700">Deviation {t.deviationId}</span>}{t.sampleId && <span className="block text-xs text-slate-500">Sample {t.sampleId}</span>}</td>
                  <td>{t.status === 'Due' && can('sample.register') && <Button variant="primary" busy={busy} onClick={() => pull(t)}>Pull</Button>}</td>
                </tr>
              ))}
            </tbody>
            {shownCalendar.length === 0 && !loading && <tfoot><tr><td colSpan={7} className="text-center p-12 text-slate-500">No pulls match.</td></tr></tfoot>}
          </table>
        )}

        {tab === 'protocols' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {protocols.map(p => (
              <div key={p.id} className="border border-slate-200 rounded-xl p-4" data-protocol-id={p.id}>
                <div className="flex justify-between gap-2"><h3 className="font-bold">{p.title}</h3><Badge status={p.status} /></div>
                <p className="text-xs font-mono text-slate-500">{p.code} · Rev {p.revision}</p>
                <p className="text-sm mt-2">{p.productName} · test plan {p.testPlanCode}</p>
                <p className="text-sm">Conditions: {p.conditions.map(c => c.code).join(', ')}</p>
                <p className="text-sm">Month points: {p.monthPoints.join(', ')} · window ±{p.windowDays} d</p>
                <p className="text-xs text-slate-500 mt-1">Drafted by {p.createdByName ?? 'unknown'}{p.approvedByName ? ` · approved by ${p.approvedByName}` : ''}</p>
                <div className="flex gap-2 mt-3">
                  {p.status === 'Draft' && can('stability.manage') && <Button onClick={() => setDrafting({ id: p.id, version: p.version, code: p.code, title: p.title, productId: p.productId, testPlanCode: p.testPlanCode, conditionIds: p.conditions.map(c => c.conditionId), monthPoints: p.monthPoints.join(', '), windowDays: String(p.windowDays) })}>Edit</Button>}
                  {p.status === 'Draft' && can('stability.approve') && p.createdBy !== user?.id && <Button variant="primary" onClick={() => setApproving(p)}><ShieldCheck className="w-4 h-4" /> Approve</Button>}
                  {p.status === 'Draft' && p.createdBy === user?.id && <span className="text-xs text-slate-500 self-center">another person must approve it</span>}
                  {p.status === 'Approved' && can('stability.manage') && <Button onClick={() => revise(p)}>New revision</Button>}
                </div>
              </div>
            ))}
            {protocols.length === 0 && !loading && <p className="col-span-full text-center p-12 text-slate-500">No protocols yet.</p>}
          </div>
        )}
      </div>

      <Modal open={!!newStudy} title="Start a stability study" onClose={() => setNewStudy(null)} dismissible={!busy}
        footer={<><Button onClick={() => setNewStudy(null)} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={startStudy} disabled={!newStudy?.protocolId || !newStudy?.batchId || !newStudy?.startDate}>Start</Button></>}>
        {newStudy && (
          <div className="space-y-3 text-sm">
            <label className="flex flex-col gap-1">Approved protocol
              <select className={input} value={newStudy.protocolId} onChange={e => setNewStudy({ ...newStudy, protocolId: e.target.value, batchId: '' })}>
                {approved.map(p => <option key={p.id} value={p.id}>{p.code} Rev {p.revision} · {p.productName}</option>)}
              </select></label>
            <label className="flex flex-col gap-1">Batch
              <select className={input} value={newStudy.batchId} onChange={e => setNewStudy({ ...newStudy, batchId: e.target.value })}>
                <option value="">Select a batch</option>
                {batches.filter(b => b.productId === approved.find(p => p.id === newStudy.protocolId)?.productId && ['Quarantine', 'Released'].includes(b.status)).map(b => <option key={b.id} value={b.id}>{b.batchNo} ({b.status})</option>)}
              </select></label>
            <label className="flex flex-col gap-1">Start date<input type="date" className={input} value={newStudy.startDate} onChange={e => setNewStudy({ ...newStudy, startDate: e.target.value })} /></label>
            <p className="text-xs text-slate-500">The pull calendar (due dates and windows) is generated from the protocol and this start date.</p>
          </div>
        )}
      </Modal>

      <Modal open={!!ending} title={ending ? `${ending.status === 'Aborted' ? 'Abort' : 'Complete'} study ${ending.study.id}` : ''} onClose={() => setEnding(null)} dismissible={!busy}
        footer={<><Button onClick={() => setEnding(null)} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={endStudy} disabled={(ending?.reason.trim().length ?? 0) < 5}>Confirm</Button></>}>
        {ending && (
          <div className="space-y-3 text-sm">
            <label className="flex flex-col gap-1">Reason<textarea rows={3} className={input} value={ending.reason} onChange={e => setEnding({ ...ending, reason: e.target.value })} /></label>
            <p className="text-xs text-slate-500">A finished study is final. Completing needs every pull finished (Complete or Missed).</p>
          </div>
        )}
      </Modal>

      <Modal open={!!drafting} size="lg" title={drafting?.id ? 'Edit protocol (Draft)' : 'New protocol (Draft)'} onClose={() => setDrafting(null)} dismissible={!busy}
        footer={<><Button onClick={() => setDrafting(null)} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} onClick={saveProtocol}>Save</Button></>}>
        {drafting && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">Code<input className={`${input} font-mono`} value={drafting.code} disabled={!!drafting.id} onChange={e => setDrafting({ ...drafting, code: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Title<input className={input} value={drafting.title} onChange={e => setDrafting({ ...drafting, title: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Product
              <select className={input} value={drafting.productId} disabled={!!drafting.id} onChange={e => setDrafting({ ...drafting, productId: e.target.value })}>
                <option value="">Select a product</option>{products.filter(p => p.status === 'Active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1">Test plan code (Effective, for this product)<input className={`${input} font-mono`} value={drafting.testPlanCode} onChange={e => setDrafting({ ...drafting, testPlanCode: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Month points (comma separated, 0 = initial)<input className={input} value={drafting.monthPoints} onChange={e => setDrafting({ ...drafting, monthPoints: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Pull window (days either side of the due date)<input type="number" min={0} max={60} className={input} value={drafting.windowDays} onChange={e => setDrafting({ ...drafting, windowDays: e.target.value })} /></label>
            <fieldset className="md:col-span-2 border border-slate-200 rounded-lg p-3"><legend className="px-1 font-semibold text-slate-700">Storage conditions</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {conditions.filter(c => c.status === 'Active').map(c => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={drafting.conditionIds.includes(c.id)} onChange={e => setDrafting({ ...drafting, conditionIds: e.target.checked ? [...drafting.conditionIds, c.id] : drafting.conditionIds.filter(x => x !== c.id) })} />
                    <span><span className="font-mono">{c.code}</span> {c.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </Modal>

      {approving && (
        <ElectronicSignatureModal user={user} token={token} meaningCode="STABILITY_PROTOCOL_APPROVAL" action="approve"
          entityName={`Stability protocol ${approving.code} Rev ${approving.revision}`} recordVersion={approving.version}
          onClose={() => setApproving(null)} onSign={approve} />
      )}
    </div>
  );
}
