// Trending screen (roadmap M39, r3-spc): control charts with rules and capability, signed control-limit baselines, out-of-trend alerts, and
// stability shelf-life estimates. Everything shown is ADVISORY: this screen changes no result and no disposition. The server computes the
// limits and the rules; the screen only draws them and asks for the reason and the e-signature of a baseline. What the screen offers
// (spc.manage) comes from GET /permissions/me; every failure is shown as the server's message.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, LineChart, ShieldCheck } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { ControlChart, type ChartLimits, type ChartPointData } from './ControlChart';
import { apiFetch, errorMessage } from '../lib/api';
import { SPC_BASELINE_APPROVAL } from '../server/stats/constants';

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1';

interface Product { id: string; code: string; name: string }
interface ParamRow { parameter: string; approved: number; unit: string | null }
interface SeriesPoint extends ChartPointData { index: number | null; unit: string | null; lower: number | null; upper: number | null }
interface SeriesResponse {
  advisory: string; product: Product; parameter: string;
  baseline: { id: string; revision: number; ruleSet: string; n: number; createdAt: string; reason: string; exclusions: number } | null;
  limits: (ChartLimits & { n: number; mrBar: number | null }) | null; limitsSource: 'baseline' | 'computed' | 'none'; provisional: boolean; ruleSet: string;
  points: SeriesPoint[]; violations: Array<{ index: number; rule: string }>;
  capability: { ok: true; value: { n: number; cp: number | null; cpk: number | null; pp: number | null; ppk: number | null } } | { ok: false; reason: string; message: string };
  specLimits: { lower: number | null; upper: number | null; changed: boolean };
  skippedNonNumeric: number; truncated: boolean; includesUnapproved: boolean;
}
interface Baseline { id: string; revision: number; status: string; ruleSet: string; n: number; cl: number; ucl: number; lcl: number; reason: string; createdBy: string; createdAt: string; exclusions: Array<{ resultId: string; reason: string }> }
interface Alert { id: string; parameter: string; batch: string; sampleId: string; resultId: string; rule: string; severity: string; value: number; z: number; detail: string; status: string; detectedAt: string; acknowledgement: string | null; version: number }
interface Group {
  studyId: string; batch: string; conditionCode: string; points: Array<{ month: number; value: number }>; lower: number | null; upper: number | null; limitsChanged: boolean;
  estimate: { ok: true; value: { n: number; fit: { slope: number; intercept: number; s: number; r2: number }; estimateMonths: number | null; predictionMonths: number | null; limiting: string | null; supportedMonths: number; extrapolationCapMonths: number; cappedByExtrapolation: boolean; failsAtStart: boolean } } | { ok: false; reason: string; message: string };
}
interface StabilityResponse { advisory: string; groups: Group[]; conditions: Array<{ conditionCode: string; supportedMonths: number | null; estimateMonths: number | null; limitingBatch: string | null; batches: number; estimated: number }> }

type Tab = 'chart' | 'alerts' | 'shelf';
const TABS: Array<{ key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'chart', label: 'Control chart', icon: LineChart }, { key: 'alerts', label: 'Out-of-trend alerts', icon: BellRing }, { key: 'shelf', label: 'Shelf-life estimate', icon: Activity },
];
const num = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? '—' : v.toFixed(d));

export function Trending({ token, user }: { token: string; user: any }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('chart');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [params, setParams] = useState<ParamRow[]>([]);
  const [parameter, setParameter] = useState('');
  const [includeUnapproved, setIncludeUnapproved] = useState(false);
  const [ruleSet, setRuleSet] = useState<'' | 'nelson' | 'westgard'>('');
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [history, setHistory] = useState<Baseline[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [stability, setStability] = useState<StabilityResponse | null>(null);
  const [exclude, setExclude] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [signing, setSigning] = useState(false);
  const [noting, setNoting] = useState<Alert | null>(null);
  const [note, setNote] = useState('');
  const canManage = permissions.includes('spc.manage');

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
    apiFetch<Product[]>('/products').then(setProducts).catch(err => fail(err, 'The products could not be loaded.'));
  }, [fail]);

  useEffect(() => {
    setParams([]); setParameter(''); setSeries(null); setStability(null);
    if (!productId) return;
    apiFetch<{ parameters: ParamRow[] }>(`/trending/parameters?productId=${encodeURIComponent(productId)}`).then(r => setParams(r.parameters)).catch(err => fail(err, 'The parameters could not be loaded.'));
  }, [productId, fail]);

  const loadSeries = useCallback(async () => {
    if (!productId || !parameter) return;
    const q = `productId=${encodeURIComponent(productId)}&parameter=${encodeURIComponent(parameter)}`;
    try {
      const [s, b] = await Promise.all([
        apiFetch<SeriesResponse>(`/trending/series?${q}${includeUnapproved ? '&includeUnapproved=true' : ''}${ruleSet ? `&ruleSet=${ruleSet}` : ''}`),
        apiFetch<Baseline[]>(`/trending/baselines?${q}`),
      ]);
      setSeries(s); setHistory(b); setExclude({});
    } catch (err) { fail(err, 'The chart could not be loaded.'); }
  }, [productId, parameter, includeUnapproved, ruleSet, fail]);

  const loadAlerts = useCallback(async () => {
    try { setAlerts(await apiFetch<Alert[]>(`/trending/alerts${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`)); } catch (err) { fail(err, 'The alerts could not be loaded.'); }
  }, [productId, fail]);

  const loadStability = useCallback(async () => {
    if (!productId || !parameter) return;
    try { setStability(await apiFetch<StabilityResponse>(`/stability-trend?productId=${encodeURIComponent(productId)}&parameter=${encodeURIComponent(parameter)}`)); } catch (err) { fail(err, 'The shelf-life estimate could not be loaded.'); }
  }, [productId, parameter, fail]);

  useEffect(() => { void loadSeries(); }, [loadSeries]);
  useEffect(() => { if (tab === 'alerts') void loadAlerts(); }, [tab, loadAlerts]);
  useEffect(() => { if (tab === 'shelf') void loadStability(); }, [tab, loadStability]);

  const violating = useMemo(() => (series?.points ?? []).filter(p => p.violations.length > 0), [series]);
  const excludedCount = Object.keys(exclude).length;
  const exclusionsValid = (Object.values(exclude) as string[]).every(r => r.trim().length >= 5);
  const currentRevision = history.find(b => b.status === 'Approved')?.revision ?? 0;

  const sign = async (password: string, signReason?: string, totpCode?: string) => {
    try {
      const r = await apiFetch<{ baseline: Baseline }>('/trending/baselines', {
        body: {
          productId, parameter, ruleSet: series?.ruleSet ?? 'nelson', expectedRevision: currentRevision, reason: signReason || reason, password, ...(totpCode ? { totpCode } : {}),
          exclusions: (Object.entries(exclude) as Array<[string, string]>).map(([resultId, why]) => ({ resultId, reason: why.trim() })),
        },
        replay: 'never',
      });
      toast.success(`Control limits for ${parameter} set (revision ${r.baseline.revision}, ${r.baseline.n} results).`);
      setSigning(false); setReason('');
      await loadSeries();
    } catch (err) { fail(err, 'The baseline was not set.'); throw err; }
  };

  const evaluate = async () => {
    try {
      const r = await apiFetch<{ baselines: number; raised: string[] }>('/trending/alerts/evaluate', { body: {} });
      toast.success(r.raised.length ? `${r.raised.length} new out-of-trend alert(s) from ${r.baselines} baseline(s).` : `No new alerts from ${r.baselines} baseline(s).`);
      await loadAlerts();
    } catch (err) { fail(err, 'The alerts were not evaluated.'); }
  };

  const acknowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noting) return;
    try {
      await apiFetch(`/trending/alerts/${noting.id}/acknowledge`, { body: { note: note.trim(), expectedVersion: noting.version } });
      toast.success(`Alert ${noting.id} acknowledged.`);
      setNoting(null); setNote('');
      await loadAlerts();
    } catch (err) { fail(err, 'The alert was not acknowledged.'); }
  };

  const cap = series?.capability;
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-bold text-slate-900">Trending</h2>
        <p className="text-sm text-slate-600">Advisory only: nothing on this page changes a result, a specification or a batch disposition. Charts use approved results, in the order they were entered.</p>
      </header>

      <div className="flex flex-wrap gap-3 items-end bg-white border border-slate-200 rounded-xl p-4">
        <label className="text-sm">Product
          <select className={`${input} block min-w-56`} value={productId} onChange={e => setProductId(e.target.value)}>
            <option value="">Choose a product…</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.code}: {p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Parameter
          <select className={`${input} block min-w-48`} value={parameter} onChange={e => setParameter(e.target.value)} disabled={!productId}>
            <option value="">{productId && params.length === 0 ? 'No numeric approved results' : 'Choose a parameter…'}</option>
            {params.map(p => <option key={p.parameter} value={p.parameter}>{p.parameter} ({p.approved})</option>)}
          </select>
        </label>
        <label className="text-sm">Rules
          <select className={`${input} block`} value={ruleSet} onChange={e => setRuleSet(e.target.value as '' | 'nelson' | 'westgard')}>
            <option value="">Baseline's (default Nelson)</option><option value="nelson">Nelson / Western Electric</option><option value="westgard">Westgard</option>
          </select>
        </label>
        <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={includeUnapproved} onChange={e => setIncludeUnapproved(e.target.checked)} /> Also show results not yet approved (hollow, not used)</label>
      </div>

      <nav className="flex gap-1 border-b border-slate-200" aria-label="Trending views">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-2 ${tab === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}><Icon className="w-4 h-4" />{label}</button>
        ))}
      </nav>

      {tab === 'chart' && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
          {!series && <p className="text-sm text-slate-500">Choose a product and a parameter.</p>}
          {series && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
                <Tile label="Limits from" value={series.limitsSource === 'baseline' ? `baseline rev ${series.baseline?.revision}` : series.limitsSource === 'computed' ? 'these results' : 'none'} />
                <Tile label="Results" value={String(series.points.filter(p => p.approved).length)} />
                <Tile label="Centre line" value={num(series.limits?.cl)} />
                <Tile label="UCL / LCL" value={series.limits ? `${num(series.limits.ucl)} / ${num(series.limits.lcl)}` : '—'} />
                <Tile label="Cpk" value={cap?.ok ? num(cap.value.cpk, 2) : 'not reported'} hint={cap && !cap.ok ? cap.message : cap?.ok ? `Ppk ${num(cap.value.ppk, 2)} (n=${cap.value.n})` : undefined} />
                <Tile label="Rule hits" value={String(series.violations.length)} />
              </div>
              {series.provisional && <p role="status" className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2">Provisional limits: computed from fewer than 20 approved results, they are not a baseline.</p>}
              {series.specLimits.changed && <p role="status" className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2">The specification limits changed over this period; capability uses the results judged against the latest limits.</p>}
              {series.skippedNonNumeric > 0 && <p className="text-sm text-slate-600">{series.skippedNonNumeric} result(s) are not plain numbers (for example a qualifier such as &lt;0.1) and are not plotted.</p>}
              {series.truncated && <p className="text-sm text-slate-600">Only the most recent results are shown; narrow the window to see earlier ones.</p>}
              <ControlChart points={series.points} limits={series.limits} spec={series.specLimits} unit={series.points[0]?.unit} title={`${series.product.name}, ${series.parameter}`} />

              {violating.length > 0 && (
                <div>
                  <h3 className="font-semibold text-sm mb-1">Rule hits</h3>
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2">Sample</th><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Value</th><th className="px-3 py-2">Rule</th>{canManage && <th className="px-3 py-2">Exclude from a new baseline</th>}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {violating.map(p => (
                        <tr key={p.resultId}>
                          <td className="px-3 py-2 font-mono"><a className="text-blue-700 underline" href={`#/samples/${p.sampleId}`}>{p.sampleId}</a></td><td className="px-3 py-2">{p.batch}</td>
                          <td className="px-3 py-2 font-mono">{p.value} ({num(p.z, 2)} σ)</td>
                          <td className="px-3 py-2">{p.violations.map(v => `${v.rule}: ${v.label}`).join('; ')}</td>
                          {canManage && (
                            <td className="px-3 py-2">
                              <label className="flex items-center gap-2"><input type="checkbox" checked={p.resultId in exclude} onChange={e => setExclude(prev => { const n = { ...prev }; if (e.target.checked) n[p.resultId] = ''; else delete n[p.resultId]; return n; })} /> exclude</label>
                              {p.resultId in exclude && <input aria-label={`Reason to exclude ${p.resultId}`} className={`${input} w-full mt-1`} placeholder="Why (e.g. DEV-12, wrong diluent)" value={exclude[p.resultId]} onChange={e => setExclude(prev => ({ ...prev, [p.resultId]: e.target.value }))} />}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {canManage && (
                <div className="border-t border-slate-200 pt-3 space-y-2">
                  <h3 className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Set control limits (baseline)</h3>
                  <p className="text-xs text-slate-600">The server computes the limits from the approved results ({series.points.filter(p => p.approved).length - excludedCount} after exclusions; at least 20 are needed), keeps the ids and a hash of the values, and the signature binds you to the new revision. The previous revision is superseded, not edited.</p>
                  <label className="block text-sm">Reason<input className={`${input} w-full`} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Limits from the first 30 commercial batches after process validation" /></label>
                  <button type="button" className={primary} disabled={reason.trim().length < 5 || !exclusionsValid} onClick={() => setSigning(true)}>Sign and set baseline…</button>
                  {!exclusionsValid && <p role="alert" className="text-xs text-red-700">Every exclusion needs its reason (at least 5 characters).</p>}
                </div>
              )}

              {history.length > 0 && (
                <div>
                  <h3 className="font-semibold text-sm mb-1">Baseline history</h3>
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-600"><tr>{['Rev', 'Status', 'Rules', 'n', 'CL', 'LCL', 'UCL', 'Exclusions', 'Reason', 'Set'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {history.map(b => (
                        <tr key={b.id} className={b.status === 'Superseded' ? 'text-slate-400' : ''}>
                          <td className="px-3 py-2">{b.revision}</td><td className="px-3 py-2">{b.status}</td><td className="px-3 py-2">{b.ruleSet}</td><td className="px-3 py-2">{b.n}</td>
                          <td className="px-3 py-2 font-mono">{num(b.cl)}</td><td className="px-3 py-2 font-mono">{num(b.lcl)}</td><td className="px-3 py-2 font-mono">{num(b.ucl)}</td>
                          <td className="px-3 py-2">{b.exclusions.length ? b.exclusions.map(x => `${x.resultId}: ${x.reason}`).join('; ') : 'none'}</td>
                          <td className="px-3 py-2 text-xs">{b.reason}</td><td className="px-3 py-2 text-xs">{new Date(b.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <details>
                <summary className="text-sm cursor-pointer text-slate-700">Results as a table</summary>
                <table className="w-full text-left text-sm mt-2">
                  <thead className="bg-slate-50 text-slate-600"><tr>{['#', 'Entered', 'Sample', 'Batch', 'Value', 'σ from CL', 'State', 'Rules'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {series.points.map((p, i) => (
                      <tr key={p.resultId}><td className="px-3 py-1">{i + 1}</td><td className="px-3 py-1 font-mono">{new Date(p.enteredAt).toLocaleString()}</td><td className="px-3 py-1 font-mono">{p.sampleId}</td><td className="px-3 py-1">{p.batch}</td>
                        <td className="px-3 py-1 font-mono">{p.value}</td><td className="px-3 py-1 font-mono">{num(p.z, 2)}</td><td className="px-3 py-1">{p.sampleState}</td><td className="px-3 py-1">{p.violations.map(v => v.rule).join(' ') || '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
        </section>
      )}

      {tab === 'alerts' && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">A signal against a signed baseline, raised for results entered after the baseline's data. It is a prompt to assess; acknowledge it with your assessment (open a deviation separately where warranted).</p>
            {canManage && <button type="button" className={button} onClick={evaluate}>Evaluate now</button>}
          </div>
          {alerts.length === 0 ? <p className="text-sm text-slate-500">No out-of-trend alerts.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr>{['Raised', 'Parameter', 'Sample / batch', 'Rule', 'Value', 'Status', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {alerts.map(a => (
                  <tr key={a.id}>
                    <td className="px-3 py-2 text-xs">{new Date(a.detectedAt).toLocaleString()}</td><td className="px-3 py-2">{a.parameter}</td>
                    <td className="px-3 py-2"><a className="text-blue-700 underline font-mono" href={`#/samples/${a.sampleId}`}>{a.sampleId}</a> / {a.batch}</td>
                    <td className="px-3 py-2"><span title={a.detail}>{a.rule} ({a.severity})</span></td><td className="px-3 py-2 font-mono">{a.value} ({num(a.z, 2)} σ)</td>
                    <td className="px-3 py-2">{a.status}{a.acknowledgement ? `: ${a.acknowledgement}` : ''}</td>
                    <td className="px-3 py-2">{canManage && a.status === 'Open' && <button type="button" className={button} onClick={() => { setNoting(a); setNote(''); }}>Acknowledge</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'shelf' && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-slate-600">Linear regression of the result on time (months) per batch and storage condition. The estimate is where the one-sided 95% confidence bound of the mean meets the specification limit (the ICH Q1E approach). It is not pooled across batches: the shortest supported figure per condition is the one to consider. It proposes nothing; setting a shelf life is a controlled decision.</p>
          {!stability && <p className="text-sm text-slate-500">Choose a product and a parameter.</p>}
          {stability && stability.groups.length === 0 && <p className="text-sm text-slate-500">No approved stability results for this parameter.</p>}
          {stability && stability.groups.length > 0 && (
            <>
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600"><tr>{['Condition', 'Batch', 'Points', 'Slope / month', 'Limits', 'Bound meets limit (months)', 'Prediction bound', 'Supported (whole months)'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {stability.groups.map(g => (
                    <tr key={`${g.conditionCode}-${g.studyId}`}>
                      <td className="px-3 py-2">{g.conditionCode}</td><td className="px-3 py-2">{g.batch}</td><td className="px-3 py-2">{g.points.length}</td>
                      {g.estimate.ok ? (
                        <>
                          <td className="px-3 py-2 font-mono">{num(g.estimate.value.fit.slope)}</td><td className="px-3 py-2 font-mono">{g.lower ?? '—'} to {g.upper ?? '—'}{g.limitsChanged ? ' (changed)' : ''}</td>
                          <td className="px-3 py-2 font-mono">{g.estimate.value.estimateMonths === null ? 'not reached' : num(g.estimate.value.estimateMonths, 1)}{g.estimate.value.failsAtStart ? ' (fails at time 0)' : ''}</td>
                          <td className="px-3 py-2 font-mono">{g.estimate.value.predictionMonths === null ? 'not reached' : num(g.estimate.value.predictionMonths, 1)}</td>
                          <td className="px-3 py-2 font-mono">{g.estimate.value.supportedMonths}{g.estimate.value.cappedByExtrapolation ? ` (capped at ${g.estimate.value.extrapolationCapMonths} by the extrapolation limit)` : ''}</td>
                        </>
                      ) : <td className="px-3 py-2 text-slate-600" colSpan={5}>No estimate: {g.estimate.message}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="text-sm space-y-1">
                {stability.conditions.map(c => <li key={c.conditionCode}><strong>{c.conditionCode}</strong>: {c.supportedMonths === null ? 'no batch has enough data for an estimate' : `shortest supported estimate ${c.supportedMonths} months (batch ${c.limitingBatch}; ${c.estimated} of ${c.batches} batch(es) estimated)`}</li>)}
              </ul>
            </>
          )}
        </section>
      )}

      {signing && (
        <ElectronicSignatureModal
          user={user} token={token} meaningCode={SPC_BASELINE_APPROVAL} action="control limit baseline"
          entityName={`${series?.product.name ?? ''}, ${parameter}: revision ${currentRevision + 1}`} recordVersion={1}
          defaultReason={reason} onClose={() => setSigning(false)} onSign={sign}
        />
      )}

      {noting && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
          <form onSubmit={acknowledge} className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3">
            <h3 className="font-semibold">Acknowledge {noting.id}</h3>
            <p className="text-xs text-slate-600">{noting.detail}</p>
            <label className="block text-sm">Your assessment<textarea required minLength={5} className={`${input} w-full`} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Column replaced; no impact on the batch; DEV-12 opened" /></label>
            <div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setNoting(null)}>Cancel</button><button type="submit" className={primary}>Acknowledge</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="border border-slate-200 rounded-lg p-2" title={hint}><div className="text-xs text-slate-500">{label}</div><div className="font-semibold font-mono">{value}</div>{hint && <div className="text-xs text-slate-500">{hint}</div>}</div>;
}
