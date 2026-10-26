import React, { useState, useEffect } from 'react';
import { Activity, TrendingUp, X } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, BarChart, Bar, LabelList } from 'recharts';
import { BarChart2, AlertTriangle } from 'lucide-react';
import { ComplianceOverviewWidget } from './ComplianceOverviewWidget';
import { DueReviewsCard } from './PeriodicReviews';
import { apiFetch } from '../lib/api';
import { useToast } from './ui/Toast';
import { localizedError, t, useLang } from '../i18n';
import { formatDate, formatNumber } from '../lib/format';


// ---- key figures (roadmap M34): the server decides which tiles a role sees; the list behind a tile is the same query as its count ----

export interface KpiTile { key: string; label: string; hint: string; severity: 'bad' | 'warn' | 'info'; view: string; count: number }
export interface KpiFacts { lastChainVerification: { at: string; outcome: string } | null; lastBackup: { at: string; outcome: string; verified: boolean } | null }
export interface KpiResponse { role: string; generatedAt: string; tiles: KpiTile[]; facts: KpiFacts | null }
export interface DrillResponse { key: string; label: string; view: string; total: number; shown: number; rows: Array<{ id: string; label: string; detail: string; at: string | null }> }
export interface TatResponse {
  window: { from: string; to: string }; completed: number; approved: number; withDueDate: number; onTime: number; onTimePct: number | null;
  medianHours: number | null; p90Hours: number | null;
  open: { total: number; overdue: number; withoutDueDate: number };
  aging: Array<{ bucket: string; n: number }>;
  oosRate: Array<{ parameter: string; results: number; oos: number; ratePct: number | null }>;
  rightFirstTime: { approved: number; firstTime: number; pct: number | null };
}

const TONE: Record<KpiTile['severity'], string> = { bad: 'border-red-300 bg-red-50 text-red-800', warn: 'border-amber-300 bg-amber-50 text-amber-900', info: 'border-slate-200 bg-white text-slate-800' };
const toneOf = (t: KpiTile) => (t.count === 0 ? 'border-emerald-200 bg-emerald-50/50 text-emerald-900' : TONE[t.severity]);

export const formatHours = (h: number | null) => (h === null ? t('dash.na') : h < 48 ? t('dash.hours', { n: formatNumber(h.toFixed(1)) }) : t('dash.daysShort', { n: formatNumber((h / 24).toFixed(1)) }));
const formatWhen = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

export function KpiTiles({ data, selected, onSelect }: { data: KpiResponse; selected: string | null; onSelect: (key: string) => void }) {
  if (data.tiles.length === 0) return <p className="text-sm text-slate-500">{t('dash.noKeyFigures', { role: data.role })}</p>;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" role="list" aria-label={t('dash.keyFiguresFor', { role: data.role })}>
      {data.tiles.map(tile => (
        <button key={tile.key} type="button" role="listitem" aria-pressed={selected === tile.key} onClick={() => onSelect(tile.key)} title={tile.hint}
          className={`text-start p-4 rounded-2xl border shadow-sm hover:shadow-md transition-all ${toneOf(tile)} ${selected === tile.key ? 'ring-2 ring-indigo-500' : ''}`}>
          <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{tile.label}</p>
          <p className="text-4xl font-black mt-1">{formatNumber(tile.count)}</p>
          <p className="text-xs mt-2 opacity-80">{tile.count === 0 ? t('dash.nothingOpen') : t('dash.showList')}</p>
        </button>
      ))}
    </div>
  );
}

export function DrillPanel({ drill, onClose, onOpen }: { drill: DrillResponse; onClose: () => void; onOpen?: (view: string) => void }) {
  return (
    <section className="mt-4 bg-white rounded-2xl border border-slate-200 shadow-sm p-5" aria-label={t('dash.listLabel', { label: drill.label })}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-base font-bold text-slate-800">{drill.label} <span className="font-mono text-slate-500">({formatNumber(drill.total)})</span></h3>
        <div className="flex items-center gap-2">
          {onOpen && <button type="button" onClick={() => onOpen(drill.view)} className="text-sm font-semibold text-indigo-700 hover:text-indigo-900">{t('dash.openScreen')}</button>}
          <button type="button" onClick={onClose} aria-label={t('dash.closeList')} className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
      </div>
      {drill.rows.length === 0 ? <p className="text-sm text-slate-500">{t('dash.listEmpty')}</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-start text-xs uppercase tracking-wider text-slate-500"><th className="py-1 pe-3">{t('dash.col.record')}</th><th className="py-1 pe-3">{t('dash.col.what')}</th><th className="py-1 pe-3">{t('dash.col.detail')}</th><th className="py-1">{t('dash.col.date')}</th></tr></thead>
          <tbody>
            {drill.rows.map(r => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-1.5 pe-3 font-mono text-xs"><bdi dir="ltr">{r.id}</bdi></td><td className="py-1.5 pe-3">{r.label}</td><td className="py-1.5 pe-3 text-slate-600">{r.detail}</td>
                <td className="py-1.5 text-slate-600">{r.at ? (r.at.length > 10 ? formatWhen(r.at) : r.at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {drill.total > drill.shown && <p className="text-xs text-slate-500 mt-2">{t('dash.showing', { shown: formatNumber(drill.shown), total: formatNumber(drill.total) })}</p>}
    </section>
  );
}

export function TatPanel({ data }: { data: TatResponse }) {
  const days = Math.round((Date.parse(data.window.to) - Date.parse(data.window.from)) / 86_400_000);
  return (
    <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100" aria-label={t('dash.tat.title')}>
      <h3 className="text-lg font-bold text-slate-800">{t('dash.tat.title')}</h3>
      <p className="text-xs text-slate-500 mt-1">{t('dash.tat.intro', { days: formatNumber(days) })}</p>
      {data.completed === 0 ? (
        <p className="mt-4 text-sm text-slate-500 border border-dashed border-slate-200 rounded-xl p-4">{t('dash.tat.none')}</p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div><dt className="text-xs text-slate-500">{t('dash.tat.finished')}</dt><dd className="text-2xl font-black">{formatNumber(data.completed)}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('dash.tat.onTime')}</dt><dd className="text-2xl font-black">{data.onTimePct === null ? t('dash.na') : `${formatNumber(data.onTimePct)}%`}</dd>
            <dd className="text-xs text-slate-500">{t('dash.tat.onTimeOf', { onTime: formatNumber(data.onTime), withDueDate: formatNumber(data.withDueDate) })}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('dash.tat.median')}</dt><dd className="text-2xl font-black">{formatHours(data.medianHours)}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('dash.tat.p90')}</dt><dd className="text-2xl font-black">{formatHours(data.p90Hours)}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('dash.tat.rft')}</dt><dd className="text-2xl font-black">{data.rightFirstTime.pct === null ? t('dash.na') : `${formatNumber(data.rightFirstTime.pct)}%`}</dd>
            <dd className="text-xs text-slate-500">{t('dash.tat.rftOf', { firstTime: formatNumber(data.rightFirstTime.firstTime), approved: formatNumber(data.rightFirstTime.approved) })}</dd></div>
        </dl>
      )}
      <h4 className="mt-6 text-sm font-bold text-slate-700">{t('dash.tat.aging', { total: formatNumber(data.open.total), overdue: formatNumber(data.open.overdue), without: data.open.withoutDueDate > 0 ? t('dash.tat.withoutDue', { n: formatNumber(data.open.withoutDueDate) }) : '' })}</h4>
      <ul className="mt-2 grid grid-cols-5 gap-2 text-center text-xs">
        {data.aging.map(a => <li key={a.bucket} className="rounded-lg bg-slate-50 border border-slate-200 p-2"><div className="text-lg font-bold">{formatNumber(a.n)}</div>{a.bucket}</li>)}
      </ul>
      <h4 className="mt-6 text-sm font-bold text-slate-700">{t('dash.tat.oosRate')}</h4>
      {data.oosRate.length === 0 ? <p className="text-sm text-slate-500 mt-1">{t('dash.tat.noResults')}</p> : (
        <table className="w-full text-sm mt-1"><tbody>
          {data.oosRate.map(r => <tr key={r.parameter} className="border-t border-slate-100"><td className="py-1">{r.parameter}</td><td className="py-1 font-mono text-end">{t('dash.tat.oosOf', { oos: formatNumber(r.oos), results: formatNumber(r.results) })}</td><td className="py-1 font-mono text-end w-16">{r.ratePct === null ? t('dash.na') : `${formatNumber(r.ratePct)}%`}</td></tr>)}
        </tbody></table>
      )}
    </section>
  );
}

export function FactsPanel({ facts }: { facts: KpiFacts }) {
  return (
    <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100" aria-label={t('dash.facts.title')}>
      <h3 className="text-lg font-bold text-slate-800">{t('dash.facts.title')}</h3>
      <p className="text-xs text-slate-500 mt-1">{t('dash.facts.help')}</p>
      <dl className="mt-3 text-sm space-y-2">
        <div><dt className="text-xs text-slate-500">{t('dash.facts.chain')}</dt>
          <dd>{facts.lastChainVerification ? t('dash.facts.result', { when: formatWhen(facts.lastChainVerification.at), outcome: facts.lastChainVerification.outcome }) : t('dash.facts.none')}</dd></div>
        <div><dt className="text-xs text-slate-500">{t('dash.facts.backup')}</dt>
          <dd>{facts.lastBackup ? `${t('dash.facts.result', { when: formatWhen(facts.lastBackup.at), outcome: facts.lastBackup.outcome })}${facts.lastBackup.verified ? t('dash.facts.verified') : t('dash.facts.notVerified')}` : t('dash.facts.none')}</dd></div>
      </dl>
    </section>
  );
}

export function Dashboard({ token, onNavigate }: { token: string, onNavigate?: (view: string) => void }) {
  useLang();
  const [stats, setStats] = useState<any>({
    activeOos: 0,
    overdueOos: 0,
    overdueInstruments: 0,
    pendingReviews: 0,
    trendData: [],
    oosChartData: [],
    reagentsActive: 0,
    reagentsExpired: 0,
    workloadData: [],
    upcomingCalibrations: [],
    complianceOverview: null
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [kpi, setKpi] = useState<KpiResponse | null>(null);
  const [tat, setTat] = useState<TatResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillResponse | null>(null);
  const { toast } = useToast();

  // apiFetch checks res.ok and handles an expired session; a failed load is shown, never replaced by zeros.
  useEffect(() => {
    let cancelled = false;
    apiFetch<any>('/dashboard')
      .then(data => { if (!cancelled) { setStats(data); setLoadError(null); } })
      .catch(err => {
        if (cancelled) return;
        const message = localizedError(err, 'dash.loadFailed');
        setLoadError(message);
        toast(message, 'error');
      });
    // The key figures and the turnaround statistics load apart from the dashboard: a failure of one is shown, and does not blank the other.
    apiFetch<KpiResponse>('/metrics/kpi')
      .then(d => { if (!cancelled) setKpi(d); })
      .catch(err => { if (!cancelled) toast(localizedError(err, 'dash.kpiFailed'), 'error'); });
    apiFetch<TatResponse>('/metrics/tat')
      .then(d => { if (!cancelled) setTat(d); })
      .catch(err => { if (!cancelled) toast(localizedError(err, 'dash.tatFailed'), 'error'); });
    return () => { cancelled = true; };
  }, [token]);

  const openTile = (key: string) => {
    if (selected === key) { setSelected(null); setDrill(null); return; }
    setSelected(key);
    setDrill(null);
    apiFetch<DrillResponse>(`/metrics/kpi/${encodeURIComponent(key)}`)
      .then(d => setDrill(d))
      .catch(err => { setSelected(null); toast(localizedError(err, 'dash.drillFailed'), 'error'); });
  };

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
            <Activity className="w-8 h-8 text-indigo-600" aria-hidden="true" /> {t('dash.title')}
          </h2>
          <p className="text-slate-500 mt-1">{t('dash.subtitle')}</p>
        </div>
      </div>

      {loadError && (
        <div role="alert" className="mb-8 bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" aria-hidden="true" /> {loadError} {t('dash.notCurrent')}
        </div>
      )}
      
      
      {stats.upcomingCalibrations && stats.upcomingCalibrations.length > 0 && (
        <div className="mb-8 bg-amber-50 border-s-4 border-amber-500 p-4 rounded-e-lg shadow-sm">
          <div className="flex items-start">
            <AlertTriangle className="w-6 h-6 text-amber-500 me-3 mt-0.5" />
            <div>
              <h3 className="text-amber-800 font-bold">{t('dash.upcoming.title')}</h3>
              <p className="text-amber-700 text-sm mt-1">
                {t('dash.upcoming.body')}
              </p>
              <ul className="mt-3 space-y-2">
                {stats.upcomingCalibrations.map((inst: any) => (
                  <li key={inst.id} className="text-sm font-medium text-amber-900 bg-amber-100/50 px-3 py-2 rounded flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                    <span>{inst.name} (<bdi dir="ltr">{inst.id}</bdi>)</span>
                    <span className="text-amber-600/80 mx-2">|</span>
                    <span>{t('dash.upcoming.due', { date: formatDate(String(inst.calibrationDueDate).slice(0, 10)) })}{inst.daysRemaining === 0 ? t('dash.upcoming.today') : t('dash.upcoming.days', { n: formatNumber(inst.daysRemaining) })}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Key figures of the role (roadmap M34): each tile opens the list it counts */}
      <div className="mb-8">
        {kpi ? <KpiTiles data={kpi} selected={selected} onSelect={openTile} /> : <p className="text-sm text-slate-500">{t('dash.loadingKpi')}</p>}
        {selected && !drill && <p className="mt-4 text-sm text-slate-500">{t('dash.loadingList')}</p>}
        {drill && <DrillPanel drill={drill} onClose={() => { setSelected(null); setDrill(null); }} onOpen={onNavigate} />}
      </div>

      {(tat || kpi?.facts) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-2">{tat && <TatPanel data={tat} />}</div>
          <div>{kpi?.facts && <FactsPanel facts={kpi.facts} />}</div>
        </div>
      )}

      <div className="mb-8"><DueReviewsCard data={stats.periodicReviewsDue} /></div>

      {/* GxP Compliance Overview Widget (Recharts Tri-Pillars Surveillance) */}
      <ComplianceOverviewWidget 
        overviewData={stats.complianceOverview} 
        onNavigate={onNavigate} 
      />

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Trend Area Chart */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-500" aria-hidden="true" /> {t('dash.trend.title')}
              </h3>
              <p className="text-xs text-slate-500 mt-1">{t('dash.trend.sub')}</p>
            </div>
          </div>
          <div className="h-72 w-full" dir="ltr">
            {stats.trendData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-xl">
                {t('dash.trend.empty')}
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSamples" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorOos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                <Tooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  itemStyle={{ fontSize: '13px', fontWeight: 'bold' }}
                />
                <Area type="monotone" dataKey="samples" name={t('dash.trend.samples')} stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorSamples)" />
                <Area type="monotone" dataKey="oos" name={t('dash.trend.oos')} stroke="#ef4444" strokeWidth={3} fillOpacity={1} fill="url(#colorOos)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* OOS Distribution Pie Chart */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h3 className="text-lg font-bold text-slate-800 mb-2">{t('dash.oosDist.title')}</h3>
          <p className="text-xs text-slate-500 mb-4">{t('dash.oosDist.sub')}</p>
          <div className="h-64 w-full" dir="ltr">
            {stats.oosChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-xl">
                {t('dash.oosDist.empty')}
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.oosChartData}
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  stroke="none"
                >
                  {stats.oosChartData.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  itemStyle={{ fontSize: '13px', fontWeight: 'bold' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px' }}/>
              </PieChart>
            </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>

      {/* Workload Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* Action Required Bar Chart */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <BarChart2 className="w-5 h-5 text-indigo-500" aria-hidden="true" /> {t('dash.workload.title')}
              </h3>
              <p className="text-xs text-slate-500 mt-1">{t('dash.workload.sub')}</p>
            </div>
          </div>
          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.workloadData} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
                <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 13, fill: '#475569', fontWeight: 600 }} width={120} />
                <Tooltip 
                  cursor={{fill: '#f8fafc'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={40}>
                  {stats.workloadData?.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                  <LabelList dataKey="count" position="right" fill="#64748b" fontSize={14} fontWeight="bold" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

