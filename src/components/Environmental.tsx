// Environmental monitoring screen (roadmap M32, r2-em): the programme's results, heat grid and adverse trends, the site map of sampling
// points, the approved limit profiles and the batch room windows. The server is the authority: it judges every result against the
// Approved profile, opens excursions and deviations, and refuses what the role may not do. What the screen offers (env.manage,
// env.correct) comes from GET /permissions/me; every failure is shown as the server's message.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Grid3x3, MapPin, Plus, ShieldCheck, Wind } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';
import { CLEANROOM_GRADES } from '../lib/validations/env';
import { EM_LIMIT_APPROVAL, EM_METHODS, ISO_CLASSES, isViable, OCCUPANCY_STATES, TREND_RULES } from '../server/em/constants';

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1';

export interface EmPoint { id: string; code: string; room: string; description: string; grade: string; status: string; version: number }
export interface EmProfile {
  id: string; grade: string; method: string; occupancy: string; isoClass: string | null; unit: string; alertLimit: number | null; actionLimit: number;
  source: string; status: string; origin: string; createdBy: string | null; approvedBy: string | null; version: number;
}
export interface EmResultRow {
  id: string; pointId: string; pointCode: string; room: string; grade: string; method: string; occupancy: string; sampledOn: string; count: number; unit: string;
  mediaLot: string | null; organism: string | null; status: string; limitAlert: number | null; limitAction: number; version: number;
  excursionId: string | null; deviationId: string | null; deviationState: string | null;
}
export interface EmTrend { id: string; rule: keyof typeof TREND_RULES; pointCode: string; room: string; detail: string; status: string; detectedAt: string; acknowledgement: string | null; version: number }
export interface HeatGridData { columns: string[]; rows: Array<{ pointId: string; code: string; room: string; grade: string; cells: Array<{ worst: string; n: number } | null> }> }
interface BatchRoom { id: string; productBatchId: string; batchNo: string; productName: string; room: string; fromDate: string; toDate: string; version: number }

export const statusClass = (status: string | null | undefined) =>
  status === 'Pass' ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
    : status === 'Alert' ? 'bg-amber-100 text-amber-800 border-amber-200'
      : status === 'Action' || status === 'Action Level' ? 'bg-red-100 text-red-800 border-red-200'
        : 'bg-slate-100 text-slate-500 border-slate-200';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border inline-flex items-center gap-1 ${statusClass(status)}`}>
      {status === 'Pass' ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}{status}
    </span>
  );
}

/** Worst status per sampling point and week; an empty cell is a week without a result. */
export function HeatGrid({ data }: { data: HeatGridData | null }) {
  if (!data) return <p className="text-sm text-slate-500">Loading the heat grid…</p>;
  if (data.rows.length === 0) return <p className="text-sm text-slate-500">No sampling points yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="px-2 py-1 text-start text-slate-600">Point</th>
            {data.columns.map(c => <th key={c} className="px-1 py-1 font-mono text-slate-500">{c.slice(5)}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.rows.map(r => (
            <tr key={r.pointId}>
              <td className="px-2 py-1 whitespace-nowrap"><span className="font-semibold">{r.code}</span> <span className="text-slate-500">{r.room} · {r.grade}</span></td>
              {r.cells.map((c, i) => (
                <td key={i} title={c ? `${c.n} result(s), worst ${c.worst}` : 'No result'} className={`w-9 h-7 border text-center ${c ? statusClass(c.worst) : 'bg-white border-slate-100 text-slate-300'}`}>
                  {c ? c.n : '·'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultTable({ results, canCorrect, onCorrect, onIdentify }: {
  results: EmResultRow[]; canCorrect: boolean; onCorrect: (r: EmResultRow) => void; onIdentify: (r: EmResultRow) => void;
}) {
  if (results.length === 0) return <p className="text-sm text-slate-500 p-6">No results recorded.</p>;
  return (
    <table className="w-full text-start text-sm">
      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
        <tr>{['Result', 'Point', 'Grade', 'Method', 'Sampled', 'Count', 'Limits (alert / action)', 'Organism', 'Status', ''].map(h => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {results.map(r => (
          <tr key={r.id}>
            <td className="px-3 py-2 font-mono text-blue-700">{r.id}</td>
            <td className="px-3 py-2"><span className="font-medium">{r.pointCode}</span> <span className="text-slate-500">{r.room}</span></td>
            <td className="px-3 py-2">{r.grade}</td>
            <td className="px-3 py-2">{r.method} <span className="text-slate-500">({r.occupancy})</span></td>
            <td className="px-3 py-2 font-mono">{r.sampledOn}</td>
            <td className="px-3 py-2 font-mono">{r.count} <span className="text-slate-500">{r.unit}</span></td>
            <td className="px-3 py-2 font-mono text-slate-500">{r.limitAlert ?? '—'} / {r.limitAction}</td>
            <td className="px-3 py-2">{r.organism ?? (isViable(r.method) && r.count > 0 ? <button className={button} onClick={() => onIdentify(r)}>Identify</button> : '—')}</td>
            <td className="px-3 py-2">
              <StatusBadge status={r.status} />
              {r.deviationId && <span className="block text-xs text-red-700 mt-1">Excursion {r.excursionId}, deviation {r.deviationId} ({r.deviationState})</span>}
            </td>
            <td className="px-3 py-2">{canCorrect && <button className={button} onClick={() => onCorrect(r)}>Correct</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProfileTable({ profiles, canManage, onApprove }: { profiles: EmProfile[]; canManage: boolean; onApprove: (p: EmProfile) => void }) {
  return (
    <table className="w-full text-start text-sm">
      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
        <tr>{['Grade', 'Method', 'Occupancy', 'ISO class', 'Alert', 'Action', 'Unit', 'Source', 'Status', ''].map(h => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {profiles.map(p => (
          <tr key={p.id} className={p.status === 'Retired' ? 'text-slate-400' : ''}>
            <td className="px-3 py-2">{p.grade}</td><td className="px-3 py-2">{p.method}</td><td className="px-3 py-2">{p.occupancy}</td>
            <td className="px-3 py-2">{p.isoClass ?? '—'}</td><td className="px-3 py-2 font-mono">{p.alertLimit ?? 'not set'}</td>
            <td className="px-3 py-2 font-mono">{p.actionLimit}</td><td className="px-3 py-2">{p.unit}</td>
            <td className="px-3 py-2 text-xs max-w-xs">{p.source}</td>
            <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs border ${p.status === 'Approved' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-slate-50 border-slate-200'}`}>{p.status}</span></td>
            <td className="px-3 py-2">{canManage && p.status === 'Draft' && <button className={button} onClick={() => onApprove(p)}><ShieldCheck className="w-4 h-4 inline" /> Approve</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line of text asked for an action (an organism, a reason, a QA review), with the server's refusal shown by the caller's toast. */
export function TextDialog({ title, label, minLength = 1, onCancel, onSubmit }: { title: string; label: string; minLength?: number; onCancel: () => void; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
      <form className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await onSubmit(text.trim()); } finally { setBusy(false); } }}>
        <h3 className="font-semibold">{title}</h3>
        <label className="block text-sm">{label}<textarea required minLength={minLength} className={`${input} w-full`} value={text} onChange={e => setText(e.target.value)} /></label>
        <div className="flex justify-end gap-2"><button type="button" className={button} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy} className={primary}>Save</button></div>
      </form>
    </div>
  );
}

type Tab = 'results' | 'trends' | 'points' | 'limits' | 'batches' | 'legacy';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'results', label: 'Results' }, { key: 'trends', label: 'Heat grid and trends' }, { key: 'points', label: 'Sampling points' },
  { key: 'limits', label: 'Limit profiles' }, { key: 'batches', label: 'Batch rooms' }, { key: 'legacy', label: 'Records before the programme' },
];

const emptyResult = { pointId: '', method: 'Settle plate', occupancy: 'In operation', sampledOn: '', count: '', mediaLot: '', incubationStartedAt: '', incubationEndedAt: '', incubationConditions: '', organism: '' };
/** A datetime-local value (the user's clock) as an ISO instant. */
const toInstant = (local: string) => (local ? new Date(local).toISOString() : undefined);

export function Environmental({ token, user }: { token: string; user: any }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('results');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [points, setPoints] = useState<EmPoint[]>([]);
  const [profiles, setProfiles] = useState<EmProfile[]>([]);
  const [results, setResults] = useState<EmResultRow[]>([]);
  const [trends, setTrends] = useState<EmTrend[]>([]);
  const [heat, setHeat] = useState<HeatGridData | null>(null);
  const [batchRooms, setBatchRooms] = useState<BatchRoom[]>([]);
  const [legacy, setLegacy] = useState<any[]>([]);
  const [form, setForm] = useState(emptyResult);
  const [pointForm, setPointForm] = useState({ code: '', room: '', description: '', grade: '' });
  const [profileForm, setProfileForm] = useState({ grade: '', method: 'Air', occupancy: 'In operation', isoClass: '', alertLimit: '', actionLimit: '', source: '' });
  const [roomForm, setRoomForm] = useState({ productBatchId: '', room: '', fromDate: '', toDate: '' });
  const [correcting, setCorrecting] = useState<(EmResultRow & { newCount: string; reason: string }) | null>(null);
  const [approving, setApproving] = useState<EmProfile | null>(null);
  const [asking, setAsking] = useState<{ title: string; label: string; minLength: number; submit: (text: string) => Promise<void> } | null>(null);
  const canManage = permissions.includes('env.manage');
  const canCorrect = permissions.includes('env.correct');

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);

  const load = useCallback(async () => {
    try {
      const [pts, prof, res, tr, hm, br, leg] = await Promise.all([
        apiFetch<EmPoint[]>('/em/points'), apiFetch<EmProfile[]>('/em/limit-profiles'), apiFetch<EmResultRow[]>('/em/results'),
        apiFetch<EmTrend[]>('/em/trends'), apiFetch<HeatGridData>('/em/heatmap'), apiFetch<BatchRoom[]>('/em/batch-rooms'), apiFetch<any[]>('/env-records'),
      ]);
      setPoints(pts); setProfiles(prof); setResults(res); setTrends(tr); setHeat(hm); setBatchRooms(br); setLegacy(leg);
    } catch (err) { fail(err, 'The environmental monitoring data could not be loaded.'); }
  }, [fail]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
    void load();
  }, [load, fail]);

  const viable = isViable(form.method);
  const activePoints = useMemo(() => points.filter(p => p.status === 'Active'), [points]);

  const submitResult = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body: Record<string, unknown> = { pointId: form.pointId, method: form.method, occupancy: form.occupancy, sampledOn: form.sampledOn, count: form.count };
      if (viable) {
        Object.assign(body, { mediaLot: form.mediaLot, incubationStartedAt: toInstant(form.incubationStartedAt), incubationEndedAt: toInstant(form.incubationEndedAt) });
        if (form.incubationConditions) body.incubationConditions = form.incubationConditions;
        if (form.organism) body.organism = form.organism;
      }
      const r = await apiFetch<EmResultRow & { impactedBatches: string[] }>('/em/results', { body });
      if (r.status === 'Action') toast.error(`Action level exceeded: excursion ${r.excursionId} and deviation ${r.deviationId} opened${r.impactedBatches.length ? `; batches affected: ${r.impactedBatches.join(', ')}` : ''}.`);
      else if (r.status === 'Alert') toast.info(`Alert level exceeded. Result ${r.id} is recorded.`);
      else toast.success(`Result ${r.id} recorded: Pass.`);
      setForm({ ...emptyResult, pointId: form.pointId, method: form.method, occupancy: form.occupancy });
      await load();
    } catch (err) { fail(err, 'The result was not recorded.'); }
  };

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correcting) return;
    try {
      const r = await apiFetch<EmResultRow>(`/em/results/${correcting.id}`, { method: 'PUT', body: { count: correcting.newCount, reason: correcting.reason, expectedVersion: correcting.version } });
      toast.success(`Result ${r.id} corrected (version ${r.version}): ${r.status}.`);
      setCorrecting(null);
      await load();
    } catch (err) { fail(err, 'The correction was not saved.'); }
  };

  const identify = (r: EmResultRow) => setAsking({
    title: `Identify the organism on ${r.id}`, label: 'Organism', minLength: 1,
    submit: async (organism) => {
      try {
        await apiFetch(`/em/results/${r.id}/identification`, { body: { organism, expectedVersion: r.version } });
        toast.success(`Organism recorded on ${r.id}.`);
        setAsking(null);
        await load();
      } catch (err) { fail(err, 'The identification was not saved.'); }
    },
  });

  const submitPoint = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await apiFetch<EmPoint>('/em/points', { body: pointForm });
      toast.success(`Sampling point ${p.code} added.`);
      setPointForm({ code: '', room: '', description: '', grade: '' });
      await load();
    } catch (err) { fail(err, 'The sampling point was not added.'); }
  };

  const retirePoint = (p: EmPoint) => setAsking({
    title: `Retire sampling point ${p.code}`, label: 'Reason (at least 5 characters)', minLength: 5,
    submit: async (reason) => {
      try {
        await apiFetch(`/em/points/${p.id}/retire`, { body: { reason, expectedVersion: p.version } });
        toast.success(`Sampling point ${p.code} retired.`);
        setAsking(null);
        await load();
      } catch (err) { fail(err, 'The sampling point was not retired.'); }
    },
  });

  const submitProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body: Record<string, unknown> = { grade: profileForm.grade, method: profileForm.method, occupancy: profileForm.occupancy, actionLimit: profileForm.actionLimit, source: profileForm.source };
      if (profileForm.alertLimit !== '') body.alertLimit = profileForm.alertLimit;
      if (profileForm.isoClass) body.isoClass = profileForm.isoClass;
      const p = await apiFetch<EmProfile>('/em/limit-profiles', { body });
      toast.success(`Limit profile ${p.id} drafted. Another member of QA approves it.`);
      setProfileForm({ ...profileForm, alertLimit: '', actionLimit: '', source: '' });
      await load();
    } catch (err) { fail(err, 'The limit profile was not drafted.'); }
  };

  const approve = async (password: string, reason?: string, totpCode?: string) => {
    if (!approving) return;
    try {
      await apiFetch(`/em/limit-profiles/${approving.id}/approve`, { body: { password, ...(totpCode ? { totpCode } : {}), ...(reason ? { reason } : {}), expectedVersion: approving.version }, replay: 'never' });
      toast.success(`Limit profile ${approving.id} approved; it now judges ${approving.grade}, ${approving.method}, ${approving.occupancy}.`);
      setApproving(null);
      await load();
    } catch (err) {
      fail(err, 'The limit profile was not approved.');
      throw err; // the dialog shows it too and stays open
    }
  };

  const submitRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const w = await apiFetch<BatchRoom & { linkedDeviations: string[] }>('/em/batch-rooms', { body: roomForm });
      toast.success(`Batch window recorded${w.linkedDeviations.length ? `; deviations now linked to the batch: ${w.linkedDeviations.join(', ')}` : ''}.`);
      setRoomForm({ productBatchId: '', room: '', fromDate: '', toDate: '' });
      await load();
    } catch (err) { fail(err, 'The batch window was not recorded.'); }
  };

  const acknowledge = (t: EmTrend) => setAsking({
    title: `Acknowledge trend ${t.id}`, label: 'QA review (at least 5 characters)', minLength: 5,
    submit: async (acknowledgement) => {
      try {
        await apiFetch(`/em/trends/${t.id}/acknowledge`, { body: { acknowledgement, expectedVersion: t.version } });
        toast.success(`Trend ${t.id} acknowledged.`);
        setAsking(null);
        await load();
      } catch (err) { fail(err, 'The trend was not acknowledged.'); }
    },
  });

  const evaluate = async () => {
    try {
      const r = await apiFetch<{ evaluated: number; flagged: unknown[] }>('/em/trends/evaluate', { body: {} });
      toast.success(`${r.evaluated} results evaluated; ${r.flagged.length} new adverse trend(s).`);
      await load();
    } catch (err) { fail(err, 'The trends were not evaluated.'); }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
      <div className="px-6 pt-4 border-b border-slate-200 bg-slate-50 flex gap-1 flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`px-3 py-2 text-sm rounded-t-lg ${tab === t.key ? 'bg-white border border-b-0 border-slate-200 font-semibold' : 'text-slate-600'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'results' && (
        <div>
          <form onSubmit={submitResult} className="p-6 border-b border-slate-200 flex flex-wrap gap-3 items-end">
            <h3 className="w-full text-base font-semibold flex items-center gap-2"><Wind className="w-4 h-4" /> Record a result</h3>
            <select required className={input} value={form.pointId} onChange={e => setForm({ ...form, pointId: e.target.value })}>
              <option value="">Sampling point</option>
              {activePoints.map(p => <option key={p.id} value={p.id}>{p.code} ({p.room}, {p.grade})</option>)}
            </select>
            <select className={input} value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>{EM_METHODS.map(m => <option key={m}>{m}</option>)}</select>
            <select className={input} value={form.occupancy} onChange={e => setForm({ ...form, occupancy: e.target.value })}>{OCCUPANCY_STATES.map(o => <option key={o}>{o}</option>)}</select>
            <label className="text-xs text-slate-600">Sampled on<input required type="date" className={`${input} block`} value={form.sampledOn} onChange={e => setForm({ ...form, sampledOn: e.target.value })} /></label>
            <input required inputMode="numeric" placeholder={viable ? 'Count (CFU)' : 'Count (particles/m3)'} className={`${input} w-36`} value={form.count} onChange={e => setForm({ ...form, count: e.target.value })} />
            {viable && (
              <>
                <input required placeholder="Media lot" className={`${input} w-36`} value={form.mediaLot} onChange={e => setForm({ ...form, mediaLot: e.target.value })} />
                <label className="text-xs text-slate-600">Incubation start<input required type="datetime-local" className={`${input} block`} value={form.incubationStartedAt} onChange={e => setForm({ ...form, incubationStartedAt: e.target.value })} /></label>
                <label className="text-xs text-slate-600">Incubation end<input required type="datetime-local" className={`${input} block`} value={form.incubationEndedAt} onChange={e => setForm({ ...form, incubationEndedAt: e.target.value })} /></label>
                <input placeholder="Incubation conditions" className={`${input} w-48`} value={form.incubationConditions} onChange={e => setForm({ ...form, incubationConditions: e.target.value })} />
                <input placeholder="Organism (if identified)" className={`${input} w-48`} value={form.organism} onChange={e => setForm({ ...form, organism: e.target.value })} />
              </>
            )}
            <button type="submit" className={primary}><Plus className="w-4 h-4" /> Record</button>
            <p className="w-full text-xs text-slate-500">The status, the limits and the unit are the server's: the result is judged against the approved limit profile of the point's grade, the method and the occupancy state.</p>
          </form>
          <div className="overflow-auto"><ResultTable results={results} canCorrect={canCorrect} onCorrect={r => setCorrecting({ ...r, newCount: String(r.count), reason: '' })} onIdentify={identify} /></div>
        </div>
      )}

      {tab === 'trends' && (
        <div className="p-6 space-y-6">
          <section>
            <h3 className="text-base font-semibold flex items-center gap-2 mb-2"><Grid3x3 className="w-4 h-4" /> Worst result per point and week</h3>
            <HeatGrid data={heat} />
          </section>
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold">Adverse trends</h3>
              {canManage && <button className={button} onClick={evaluate}>Evaluate now</button>}
            </div>
            {trends.length === 0 ? <p className="text-sm text-slate-500">No adverse trend has been flagged.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {trends.map(t => (
                  <li key={t.id} className="py-2 flex gap-3 items-start">
                    <span className={`px-2 py-0.5 rounded text-xs border ${t.status === 'Open' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-slate-50 border-slate-200'}`}>{t.status}</span>
                    <div className="flex-1"><span className="font-semibold">{TREND_RULES[t.rule]?.label ?? t.rule}</span> at {t.pointCode} ({t.room}): {t.detail}
                      {t.acknowledgement && <span className="block text-xs text-slate-500">QA: {t.acknowledgement}</span>}</div>
                    {canManage && t.status === 'Open' && <button className={button} onClick={() => acknowledge(t)}>Acknowledge</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'points' && (
        <div className="p-6 space-y-4">
          {canManage && (
            <form onSubmit={submitPoint} className="flex flex-wrap gap-3 items-end">
              <input required placeholder="Code" className={`${input} w-32`} value={pointForm.code} onChange={e => setPointForm({ ...pointForm, code: e.target.value })} />
              <input required placeholder="Room" className={`${input} w-40`} value={pointForm.room} onChange={e => setPointForm({ ...pointForm, room: e.target.value })} />
              <input required placeholder="Description (where exactly)" className={`${input} flex-1`} value={pointForm.description} onChange={e => setPointForm({ ...pointForm, description: e.target.value })} />
              <select required className={input} value={pointForm.grade} onChange={e => setPointForm({ ...pointForm, grade: e.target.value })}>
                <option value="">Grade</option>{CLEANROOM_GRADES.map(g => <option key={g}>{g}</option>)}
              </select>
              <button type="submit" className={primary}><MapPin className="w-4 h-4" /> Add point</button>
            </form>
          )}
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Code', 'Room', 'Description', 'Grade', 'Status', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {points.map(p => (
                <tr key={p.id} className={p.status === 'Retired' ? 'text-slate-400' : ''}>
                  <td className="px-3 py-2 font-semibold">{p.code}</td><td className="px-3 py-2">{p.room}</td><td className="px-3 py-2">{p.description}</td>
                  <td className="px-3 py-2">{p.grade}</td><td className="px-3 py-2">{p.status}</td>
                  <td className="px-3 py-2">{canManage && p.status === 'Active' && <button className={button} onClick={() => retirePoint(p)}>Retire</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'limits' && (
        <div className="p-6 space-y-4">
          {canManage && (
            <form onSubmit={submitProfile} className="flex flex-wrap gap-3 items-end">
              <select required className={input} value={profileForm.grade} onChange={e => setProfileForm({ ...profileForm, grade: e.target.value })}>
                <option value="">Grade</option>{CLEANROOM_GRADES.map(g => <option key={g}>{g}</option>)}
              </select>
              <select className={input} value={profileForm.method} onChange={e => setProfileForm({ ...profileForm, method: e.target.value })}>{EM_METHODS.map(m => <option key={m}>{m}</option>)}</select>
              <select className={input} value={profileForm.occupancy} onChange={e => setProfileForm({ ...profileForm, occupancy: e.target.value })}>{OCCUPANCY_STATES.map(o => <option key={o}>{o}</option>)}</select>
              <select className={input} value={profileForm.isoClass} onChange={e => setProfileForm({ ...profileForm, isoClass: e.target.value })}>
                <option value="">ISO class{isViable(profileForm.method) ? ' (optional)' : ''}</option>{ISO_CLASSES.map(c => <option key={c}>{c}</option>)}
              </select>
              <input inputMode="numeric" placeholder="Alert limit (optional)" className={`${input} w-40`} value={profileForm.alertLimit} onChange={e => setProfileForm({ ...profileForm, alertLimit: e.target.value })} />
              <input required inputMode="numeric" placeholder="Action limit" className={`${input} w-32`} value={profileForm.actionLimit} onChange={e => setProfileForm({ ...profileForm, actionLimit: e.target.value })} />
              <input required placeholder="Source (document and section)" className={`${input} flex-1`} value={profileForm.source} onChange={e => setProfileForm({ ...profileForm, source: e.target.value })} />
              <button type="submit" className={primary}><Plus className="w-4 h-4" /> Draft</button>
              <p className="w-full text-xs text-slate-500">A draft judges nothing. It is approved with an e-signature by a member of QA who did not write it; the approval retires the profile it replaces.</p>
            </form>
          )}
          <div className="overflow-auto"><ProfileTable profiles={profiles} canManage={canManage} onApprove={setApproving} /></div>
        </div>
      )}

      {tab === 'batches' && (
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600">The environmental results of a batch are those of the sampling points in the rooms it was in, sampled inside these windows. An action-level result in a room on a day a batch was there links its deviation to the batch.</p>
          {canManage && (
            <form onSubmit={submitRoom} className="flex flex-wrap gap-3 items-end">
              <input required placeholder="Batch id (master data)" className={`${input} w-48`} value={roomForm.productBatchId} onChange={e => setRoomForm({ ...roomForm, productBatchId: e.target.value })} />
              <select required className={input} value={roomForm.room} onChange={e => setRoomForm({ ...roomForm, room: e.target.value })}>
                <option value="">Room</option>{[...new Set(points.map(p => p.room))].map(r => <option key={r}>{r}</option>)}
              </select>
              <label className="text-xs text-slate-600">From<input required type="date" className={`${input} block`} value={roomForm.fromDate} onChange={e => setRoomForm({ ...roomForm, fromDate: e.target.value })} /></label>
              <label className="text-xs text-slate-600">To<input required type="date" className={`${input} block`} value={roomForm.toDate} onChange={e => setRoomForm({ ...roomForm, toDate: e.target.value })} /></label>
              <button type="submit" className={primary}><Plus className="w-4 h-4" /> Record window</button>
            </form>
          )}
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Batch', 'Product', 'Room', 'From', 'To'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {batchRooms.map(w => <tr key={w.id}><td className="px-3 py-2 font-semibold">{w.batchNo}</td><td className="px-3 py-2">{w.productName}</td><td className="px-3 py-2">{w.room}</td><td className="px-3 py-2 font-mono">{w.fromDate}</td><td className="px-3 py-2 font-mono">{w.toDate}</td></tr>)}
            </tbody>
          </table>
          {batchRooms.length === 0 && <p className="text-sm text-slate-500">No batch window recorded.</p>}
        </div>
      )}

      {tab === 'legacy' && (
        <div className="p-6">
          <p className="text-sm text-slate-600 mb-3">Records made before the programme (free-text location, judged against the earlier limits table). They are kept as they were recorded and are not attributed to any batch.</p>
          <table className="w-full text-start text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Record', 'Location', 'Grade', 'Sample type', 'Date', 'Viable', 'Non-viable', 'Status'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {legacy.map(r => (
                <tr key={r.id}><td className="px-3 py-2 font-mono">{r.id}</td><td className="px-3 py-2">{r.location}</td><td className="px-3 py-2">{r.grade}</td><td className="px-3 py-2">{r.sampleType ?? '—'}</td>
                  <td className="px-3 py-2 font-mono">{r.date}</td><td className="px-3 py-2 font-mono">{r.viableCount}</td><td className="px-3 py-2 font-mono">{r.nonViableCount}</td><td className="px-3 py-2"><StatusBadge status={r.status} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {correcting && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitCorrection} className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3">
            <h3 className="font-semibold">Correct result {correcting.id} (version {correcting.version})</h3>
            <label className="block text-sm">Count ({correcting.unit})<input required inputMode="numeric" className={`${input} w-full`} value={correcting.newCount} onChange={e => setCorrecting({ ...correcting, newCount: e.target.value })} /></label>
            <label className="block text-sm">Reason for the correction<textarea required minLength={5} className={`${input} w-full`} value={correcting.reason} onChange={e => setCorrecting({ ...correcting, reason: e.target.value })} placeholder="e.g. Recount of the plate by a second analyst" /></label>
            <p className="text-xs text-slate-500">The status is judged again against the approved limit. An excursion that was opened stays open.</p>
            <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setCorrecting(null)}>Cancel</button><button type="submit" className={primary}>Save correction</button></div>
          </form>
        </div>
      )}

      {asking && <TextDialog title={asking.title} label={asking.label} minLength={asking.minLength} onCancel={() => setAsking(null)} onSubmit={asking.submit} />}

      {approving && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode={EM_LIMIT_APPROVAL}
          action="limit profile approval"
          entityName={`${approving.id}: ${approving.grade}, ${approving.method}, ${approving.occupancy}, action ${approving.actionLimit}`}
          recordVersion={approving.version}
          onClose={() => setApproving(null)}
          onSign={approve}
        />
      )}
    </div>
  );
}
