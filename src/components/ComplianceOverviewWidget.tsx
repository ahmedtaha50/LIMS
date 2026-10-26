import { formatDate } from '../lib/format';
import React, { useState } from 'react';
import { 
  ShieldCheck, 
  AlertTriangle, 
  AlertCircle, 
  Clock, 
  GraduationCap, 
  PenTool, 
  FileCheck, 
  Wrench, 
  ChevronRight, 
  ArrowUpRight,
  Layers,
  Filter,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Cell, 
  LabelList, 
  PieChart, 
  Pie, 
  Legend, 
  ReferenceLine 
} from 'recharts';

interface ComplianceOverviewWidgetProps {
  overviewData: any;
  onNavigate?: (view: string) => void;
}

export function ComplianceOverviewWidget({ overviewData, onNavigate }: ComplianceOverviewWidgetProps) {
  const [activeTab, setActiveTab] = useState<'all' | 'approvals' | 'calibrations' | 'training'>('all');

  if (!overviewData) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm animate-pulse mb-8">
        <div className="h-6 bg-slate-200 rounded w-1/3 mb-4"></div>
        <div className="h-64 bg-slate-100 rounded w-full"></div>
      </div>
    );
  }

  const {
    // No score exists: the server sends counts and the time they were computed.
    scoreBasis = '',
    generatedAt = null,
    pendingApprovals = { total: 0, items: [], chartData: [] },
    calibrations = { totalInstruments: 0, overdueCount: 0, criticalCount: 0, approachingCount: 0, compliantCount: 0, tiersChartData: [], timeline: [], items: [] },
    training = { compliancePct: null, totalItems: 0, completedCount: 0, overdueCount: 0, pendingCount: 0, chartData: [], moduleChartData: [], overdueItems: [] }
  } = overviewData;

  // Custom Recharts Tooltip for high clarity
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const dataPoint = payload[0].payload;
      return (
        <div className="bg-slate-900/95 backdrop-blur text-white text-xs p-3 rounded-lg shadow-xl border border-slate-800 z-50">
          <p className="font-semibold text-slate-200 mb-1 border-b border-slate-700/60 pb-1">
            {dataPoint.fullName || dataPoint.fullModule || dataPoint.name || label}
          </p>
          {dataPoint.days !== undefined && (
            <p className="flex justify-between gap-4 py-0.5">
              <span className="text-slate-400">Horizon:</span>
              <span className={`font-mono font-bold ${dataPoint.days < 0 ? 'text-red-400' : dataPoint.days <= 7 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {dataPoint.days < 0 ? `${Math.abs(dataPoint.days)} days overdue` : `${dataPoint.days} days remaining`}
              </span>
            </p>
          )}
          {dataPoint.count !== undefined && (
            <p className="flex justify-between gap-4 py-0.5">
              <span className="text-slate-400">Total Records:</span>
              <span className="font-mono font-bold text-white">{dataPoint.count}</span>
            </p>
          )}
          {dataPoint.completed !== undefined && (
            <p className="flex justify-between gap-4 py-0.5">
              <span className="text-slate-400">Qualified:</span>
              <span className="font-mono font-bold text-emerald-400">{dataPoint.completed}</span>
            </p>
          )}
          {dataPoint.overdue !== undefined && dataPoint.overdue > 0 && (
            <p className="flex justify-between gap-4 py-0.5">
              <span className="text-slate-400">Overdue:</span>
              <span className="font-mono font-bold text-rose-400">{dataPoint.overdue}</span>
            </p>
          )}
          {dataPoint.status && (
            <p className="flex justify-between gap-4 py-0.5">
              <span className="text-slate-400">Status:</span>
              <span className="font-medium text-slate-300">{dataPoint.status}</span>
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden mb-8">
      {/* Header Banner */}
      <div className="px-6 py-5 border-b border-slate-200/80 bg-gradient-to-r from-slate-50 via-white to-slate-50/50 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-blue-600/10 rounded-lg text-blue-700">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 tracking-tight">
              Compliance Overview
            </h3>
            {generatedAt && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded border text-slate-600 bg-slate-50 border-slate-200">
                As of {String(generatedAt).slice(0, 16).replace('T', ' ')} UTC
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Open approvals, equipment calibrations and personnel training, from the records in this system.
          </p>
          {scoreBasis && <p className="text-[11px] text-slate-400 mt-1 max-w-2xl">{scoreBasis}</p>}
        </div>

        {/* Pillar Filter Tabs */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs font-medium self-start md:self-auto">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              activeTab === 'all' 
                ? 'bg-white text-slate-900 font-semibold shadow-xs' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5" /> All Pillars
          </button>
          <button
            onClick={() => setActiveTab('approvals')}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              activeTab === 'approvals' 
                ? 'bg-white text-blue-700 font-semibold shadow-xs' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <PenTool className="w-3.5 h-3.5" /> Approvals
            {pendingApprovals.total > 0 && (
              <span className="bg-amber-100 text-amber-800 font-mono px-1.5 py-0.2 rounded text-[11px] font-bold">
                {pendingApprovals.total}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('calibrations')}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              activeTab === 'calibrations' 
                ? 'bg-white text-indigo-700 font-semibold shadow-xs' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" /> Calibrations
            {(calibrations.overdueCount > 0 || calibrations.criticalCount > 0) && (
              <span className="bg-rose-100 text-rose-800 font-mono px-1.5 py-0.2 rounded text-[11px] font-bold">
                {calibrations.overdueCount + calibrations.criticalCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('training')}
            className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 ${
              activeTab === 'training' 
                ? 'bg-white text-emerald-700 font-semibold shadow-xs' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <GraduationCap className="w-3.5 h-3.5" /> Training
            {training.overdueCount > 0 && (
              <span className="bg-rose-100 text-rose-800 font-mono px-1.5 py-0.2 rounded text-[11px] font-bold">
                {training.overdueCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Tri-Pillar KPI Indicators Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200 bg-slate-50/50 border-b border-slate-200 text-xs">
        {/* Pillar 1 KPI */}
        <div 
          onClick={() => setActiveTab('approvals')}
          className="p-4 hover:bg-slate-50 cursor-pointer transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${pendingApprovals.total > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              <PenTool className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">Pending Approvals</p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-xl font-bold font-mono text-slate-900">{pendingApprovals.total}</span>
                <span className="text-slate-500">records awaiting signoff</span>
              </div>
            </div>
          </div>
          <ChevronRight className="rtl:-scale-x-100 w-4 h-4 text-slate-400" />
        </div>

        {/* Pillar 2 KPI */}
        <div 
          onClick={() => setActiveTab('calibrations')}
          className="p-4 hover:bg-slate-50 cursor-pointer transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${calibrations.overdueCount > 0 ? 'bg-rose-100 text-rose-700' : calibrations.criticalCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">Upcoming Calibrations</p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-xl font-bold font-mono text-slate-900">
                  {calibrations.criticalCount + calibrations.approachingCount}
                </span>
                <span className="text-slate-500">
                  due in ≤30d {calibrations.overdueCount > 0 && <strong className="text-rose-600">({calibrations.overdueCount} overdue)</strong>}
                </span>
              </div>
            </div>
          </div>
          <ChevronRight className="rtl:-scale-x-100 w-4 h-4 text-slate-400" />
        </div>

        {/* Pillar 3 KPI */}
        <div 
          onClick={() => setActiveTab('training')}
          className="p-4 hover:bg-slate-50 cursor-pointer transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${training.overdueCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
              <GraduationCap className="w-4 h-4" />
            </div>
            <div>
              <p className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">Overdue Training</p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-xl font-bold font-mono text-slate-900">{training.overdueCount}</span>
                <span className="text-slate-500">modules past validity ({training.compliancePct === null ? 'no training records' : `${training.compliancePct}% qualified`})</span>
              </div>
            </div>
          </div>
          <ChevronRight className="rtl:-scale-x-100 w-4 h-4 text-slate-400" />
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="p-6">
        {/* ================= TAB 1: ALL PILLARS OVERVIEW ================= */}
        {activeTab === 'all' && (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Chart 1: Pending Approvals by Category */}
              <div className="bg-slate-50/70 border border-slate-200 rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <PenTool className="w-4 h-4 text-blue-600" />
                    <h4 className="text-sm font-bold text-slate-800">Pending Approvals</h4>
                  </div>
                  {onNavigate && (
                    <button 
                      onClick={() => onNavigate('samples')}
                      className="text-blue-600 hover:text-blue-700 text-xs font-semibold flex items-center gap-0.5"
                    >
                      View All <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-3">Records waiting for a signature, by record type.</p>
                <div className="h-48 w-full mt-auto">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pendingApprovals.chartData} margin={{ top: 15, right: 10, left: -25, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} interval={0} />
                      <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {pendingApprovals.chartData?.map((entry: any, index: number) => (
                          <Cell key={`ap-${index}`} fill={entry.fill || '#3b82f6'} />
                        ))}
                        <LabelList dataKey="count" position="top" fill="#475569" fontSize={11} fontWeight="bold" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Chart 2: Upcoming Calibrations by Urgency Tier */}
              <div className="bg-slate-50/70 border border-slate-200 rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-indigo-600" />
                    <h4 className="text-sm font-bold text-slate-800">Calibration Urgency</h4>
                  </div>
                  {onNavigate && (
                    <button 
                      onClick={() => onNavigate('instruments')}
                      className="text-indigo-600 hover:text-indigo-700 text-xs font-semibold flex items-center gap-0.5"
                    >
                      Fleet <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-3">Calibration timeline and equipment lockouts.</p>
                <div className="h-48 w-full mt-auto">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={calibrations.tiersChartData} margin={{ top: 15, right: 10, left: -25, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="tier" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                      <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {calibrations.tiersChartData?.map((entry: any, index: number) => (
                          <Cell key={`tier-${index}`} fill={entry.fill} />
                        ))}
                        <LabelList dataKey="count" position="top" fill="#475569" fontSize={11} fontWeight="bold" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Chart 3: Personnel Training Status */}
              <div className="bg-slate-50/70 border border-slate-200 rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <GraduationCap className="w-4 h-4 text-emerald-600" />
                    <h4 className="text-sm font-bold text-slate-800">Training Qualification</h4>
                  </div>
                  {onNavigate && (
                    <button 
                      onClick={() => onNavigate('training')}
                      className="text-emerald-600 hover:text-emerald-700 text-xs font-semibold flex items-center gap-0.5"
                    >
                      Matrix <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-3">EU GMP Ch. 2 Analyst compliance and annual certifications.</p>
                <div className="h-48 w-full relative mt-auto">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={training.chartData}
                        innerRadius={45}
                        outerRadius={65}
                        paddingAngle={4}
                        dataKey="count"
                        stroke="none"
                      >
                        {training.chartData?.map((entry: any, index: number) => (
                          <Cell key={`tr-${index}`} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                      <Legend 
                        verticalAlign="bottom" 
                        height={28} 
                        iconType="circle" 
                        wrapperStyle={{ fontSize: '11px', color: '#64748b' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Donut Center Metric */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-7">
                    <span className="text-lg font-extrabold font-mono text-slate-900">{training.compliancePct === null ? '–' : `${training.compliancePct}%`}</span>
                    <span className="text-[10px] text-slate-400 font-semibold uppercase">Valid</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Priority Action Queue */}
            <div className="mt-6 border-t border-slate-200 pt-5">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 text-amber-500" /> High-Priority Compliance Items
                </h4>
                <span className="text-xs text-slate-400">Items requiring immediate action to prevent GxP audit deviations</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Approvals Action Item */}
                <div className="p-3 bg-white border border-slate-200 rounded-lg flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                        Approvals Queue
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        {pendingApprovals.total} Pending
                      </span>
                    </div>
                    <p className="text-xs font-medium text-slate-800 mt-2 line-clamp-2">
                      {pendingApprovals.items && pendingApprovals.items[0] 
                        ? pendingApprovals.items[0].title 
                        : 'All analytical approvals up to date'}
                    </p>
                  </div>
                  {pendingApprovals.items && pendingApprovals.items[0] && onNavigate && (
                    <button
                      onClick={() => onNavigate(pendingApprovals.items[0].actionView || 'samples')}
                      className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1 self-start"
                    >
                      Review &amp; Sign <ChevronRight className="rtl:-scale-x-100 w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Calibrations Action Item */}
                <div className="p-3 bg-white border border-slate-200 rounded-lg flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                        calibrations.overdueCount > 0 
                          ? 'text-rose-700 bg-rose-50 border-rose-200' 
                          : 'text-amber-700 bg-amber-50 border-amber-200'
                      }`}>
                        Equipment calibration
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        {calibrations.items && calibrations.items[0] ? `${calibrations.items[0].daysRemaining}d horizon` : 'Compliant'}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-slate-800 mt-2 line-clamp-2">
                      {calibrations.items && calibrations.items[0] 
                        ? `${calibrations.items[0].name} (${calibrations.items[0].daysRemaining < 0 ? 'OVERDUE' : `Due in ${calibrations.items[0].daysRemaining} days`})`
                        : 'All analytical equipment calibrated and active'}
                    </p>
                  </div>
                  {onNavigate && (
                    <button
                      onClick={() => onNavigate('instruments')}
                      className="mt-3 text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 self-start"
                    >
                      Calibration Schedule <ChevronRight className="rtl:-scale-x-100 w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Training Action Item */}
                <div className="p-3 bg-white border border-slate-200 rounded-lg flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                        training.overdueCount > 0 
                          ? 'text-rose-700 bg-rose-50 border-rose-200' 
                          : 'text-emerald-700 bg-emerald-50 border-emerald-200'
                      }`}>
                        Personnel Training
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        {training.overdueCount} Overdue
                      </span>
                    </div>
                    <p className="text-xs font-medium text-slate-800 mt-2 line-clamp-2">
                      {training.overdueItems && training.overdueItems[0] 
                        ? `${training.overdueItems[0].userName}: ${training.overdueItems[0].moduleName}` 
                        : 'All analyst qualifications active and up to date'}
                    </p>
                  </div>
                  {onNavigate && (
                    <button
                      onClick={() => onNavigate('training')}
                      className="mt-3 text-xs font-semibold text-emerald-600 hover:text-emerald-800 flex items-center gap-1 self-start"
                    >
                      Authorize Retraining <ChevronRight className="rtl:-scale-x-100 w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 2: PENDING APPROVALS DEEP DIVE ================= */}
        {activeTab === 'approvals' && (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Recharts Bar Chart Breakdown */}
              <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2 mb-1">
                  <PenTool className="w-4 h-4 text-blue-600" /> Electronic Signatures Pending
                </h4>
                <p className="text-xs text-slate-500 mb-4">
                  Records waiting in author or review queues for a signature.
                </p>

                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pendingApprovals.chartData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                      <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} width={110} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={26}>
                        {pendingApprovals.chartData?.map((entry: any, index: number) => (
                          <Cell key={`bar-${index}`} fill={entry.fill} />
                        ))}
                        <LabelList dataKey="count" position="right" fill="#64748b" fontSize={12} fontWeight="bold" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Right: Detailed List of Pending Approvals */}
              <div className="lg:col-span-7">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Pending Approval Records ({pendingApprovals.items?.length || 0})
                  </h4>
                  <span className="text-xs text-slate-500">Sorted by urgency</span>
                </div>

                {(!pendingApprovals.items || pendingApprovals.items.length === 0) ? (
                  <div className="p-8 text-center bg-slate-50 rounded-xl border border-slate-200 text-slate-500 text-sm">
                    <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                    All records are approved and locked. No pending e-signatures.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {pendingApprovals.items.map((item: any) => (
                      <div 
                        key={item.id}
                        className="p-3.5 bg-white border border-slate-200 rounded-xl flex items-center justify-between gap-4 hover:border-slate-300 transition-all shadow-xs"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-slate-900">{item.id}</span>
                            <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                              {item.category}
                            </span>
                            {item.urgency === 'Critical' && (
                              <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-1.5 py-0.2 rounded border border-rose-200">
                                CRITICAL
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-slate-800 mt-1 truncate">{item.title}</p>
                          <div className="flex items-center gap-3 text-xs text-slate-500 mt-1 font-mono">
                            {item.batch && <span>Batch: {item.batch}</span>}
                            <span>•</span>
                            <span>Raised: {formatDate(item.date)}</span>
                          </div>
                        </div>

                        {onNavigate && (
                          <button
                            onClick={() => onNavigate(item.actionView || 'samples')}
                            className="shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors"
                          >
                            Sign &amp; Review <ArrowUpRight className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 3: INSTRUMENT CALIBRATIONS DEEP DIVE ================= */}
        {activeTab === 'calibrations' && (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Recharts Horizon Timeline */}
              <div className="lg:col-span-6 bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-indigo-600" /> Calibration Days Remaining Horizon
                  </h4>
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Days remaining before the calibration due date passes and the instrument is locked from testing.
                </p>

                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart 
                      data={calibrations.timeline} 
                      margin={{ top: 15, right: 15, left: -20, bottom: 25 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis 
                        dataKey="id" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fontSize: 10, fill: '#475569', fontWeight: 600 }}
                        angle={-20}
                        textAnchor="end"
                      />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <ReferenceLine y={0} stroke="#ef4444" strokeWidth={2} strokeDasharray="3 3" label={{ value: 'Lockout', fill: '#ef4444', fontSize: 10, position: 'insideTopLeft' }} />
                      <ReferenceLine y={7} stroke="#f97316" strokeDasharray="2 2" />
                      <ReferenceLine y={30} stroke="#eab308" strokeDasharray="2 2" />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="days" radius={[4, 4, 0, 0]}>
                        {calibrations.timeline?.map((entry: any, index: number) => (
                          <Cell key={`tl-${index}`} fill={entry.fill} />
                        ))}
                        <LabelList dataKey="days" position="top" fill="#475569" fontSize={11} fontWeight="bold" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 px-2 pt-2 border-t border-slate-200">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500"></span> Overdue (&lt;0d)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500"></span> Critical (≤7d)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> Approaching (8-30d)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Compliant (&gt;30d)</span>
                </div>
              </div>

              {/* Right: Instrument Fleet Status Table */}
              <div className="lg:col-span-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Qualified Instruments Fleet ({calibrations.items?.length || 0})
                  </h4>
                  {onNavigate && (
                    <button
                      onClick={() => onNavigate('instruments')}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                    >
                      Manage Instruments <ExternalLink className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="w-full text-start text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="px-3 py-2.5">ID / Name</th>
                        <th className="px-3 py-2.5">Type</th>
                        <th className="px-3 py-2.5">Due Date</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-3 py-2.5 text-end">Horizon</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {calibrations.items?.map((inst: any) => (
                        <tr key={inst.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-3 py-2.5">
                            <span className="font-mono font-bold text-slate-900 block">{inst.id}</span>
                            <span className="text-slate-500 text-[11px] truncate max-w-[140px] block">{inst.name}</span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600 font-medium">{inst.type}</td>
                          <td className="px-3 py-2.5 font-mono text-slate-700">{inst.calibrationDueDate}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              inst.urgency === 'Overdue' 
                                ? 'bg-rose-50 text-rose-700 border-rose-200' 
                                : inst.urgency === 'Critical'
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : inst.urgency === 'Approaching'
                                ? 'bg-yellow-50 text-yellow-800 border-yellow-200'
                                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            }`}>
                              {inst.urgency}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-end font-mono font-bold">
                            <span className={inst.daysRemaining < 0 ? 'text-rose-600' : inst.daysRemaining <= 7 ? 'text-amber-600' : 'text-slate-700'}>
                              {inst.daysRemaining < 0 ? `${Math.abs(inst.daysRemaining)}d overdue` : `${inst.daysRemaining}d`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 4: OVERDUE TRAINING DEEP DIVE ================= */}
        {activeTab === 'training' && (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Recharts Module Distribution */}
              <div className="lg:col-span-6 bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <GraduationCap className="w-4 h-4 text-emerald-600" /> Training Compliance by GxP Module
                  </h4>
                  <span className="text-xs font-mono text-slate-500">EU GMP Chapter 2</span>
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Qualified vs. overdue certifications across required pharmaceutical analytical procedures.
                </p>

                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart 
                      data={training.moduleChartData} 
                      layout="vertical"
                      margin={{ top: 5, right: 25, left: 10, bottom: 5 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                      <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis dataKey="module" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#475569', fontWeight: 600 }} width={130} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="completed" name="Qualified" fill="#10b981" stackId="a" radius={[0, 0, 0, 0]} barSize={20} />
                      <Bar dataKey="overdue" name="Overdue" fill="#ef4444" stackId="a" radius={[0, 4, 4, 0]} barSize={20} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 px-2 pt-2 border-t border-slate-200">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500"></span> Certified &amp; Qualified</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500"></span> Overdue Retraining Required</span>
                </div>
              </div>

              {/* Right: Overdue Training Items Table */}
              <div className="lg:col-span-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Overdue Training Actions ({training.overdueItems?.length || 0})
                  </h4>
                  {onNavigate && (
                    <button
                      onClick={() => onNavigate('training')}
                      className="text-xs font-semibold text-emerald-600 hover:text-emerald-800 flex items-center gap-1"
                    >
                      Open Training Portal <ExternalLink className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {(!training.overdueItems || training.overdueItems.length === 0) ? (
                  <div className="p-8 text-center bg-slate-50 rounded-xl border border-slate-200 text-slate-500 text-sm">
                    <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                    All personnel certifications are compliant and up to date.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {training.overdueItems.map((item: any) => (
                      <div 
                        key={item.id}
                        className="p-3.5 bg-white border border-rose-200 rounded-xl flex items-center justify-between gap-4 shadow-xs"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-xs text-slate-900">{item.userName}</span>
                            <span className="text-[11px] font-mono text-slate-500">({item.userRole})</span>
                            <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                              OVERDUE
                            </span>
                          </div>
                          <p className="text-xs font-semibold text-slate-800 mt-1">{item.moduleName}</p>
                          <p className="text-[11px] text-rose-600 mt-0.5 font-medium">
                            Annual retraining interval exceeded. Analyst signature privileges restricted.
                          </p>
                        </div>

                        {onNavigate && (
                          <button
                            onClick={() => onNavigate('training')}
                            className="shrink-0 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors"
                          >
                            Certify <ArrowUpRight className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
