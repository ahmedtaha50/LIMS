import { formatDateTime } from '../lib/format';
import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';
import { Search, Filter, ShieldAlert, Plus, Check, Settings2, XCircle, AlertTriangle } from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { Instrument } from '../types';
import { formatDate } from '../lib/utils';
import { calibrationState } from '../lib/validations/instruments';

/** One line of an instrument's usage log (GET /api/instruments/:id/usage-log, roadmap M21). */
export interface UsageEntry { id: string; event: string; at: string; fileName: string | null; sampleId: string | null; userName: string }

/** What an instrument produced: files captured from it and values accepted into results, newest first. */
export function UsageLog({ entries }: { entries: UsageEntry[] }) {
  if (entries.length === 0) return <p className="text-xs text-slate-600">No data has been captured from this instrument yet.</p>;
  return (
    <ul className="text-xs text-slate-700 space-y-1" aria-label="Usage log">
      {entries.map(e => (
        <li key={e.id}>{formatDateTime(e.at)}: {e.event === 'DataCaptured' ? 'file captured' : 'value accepted'}
          {e.fileName ? ` (${e.fileName})` : ''}{e.sampleId ? `, sample ${e.sampleId}` : ''}, {e.userName}</li>
      ))}
    </ul>
  );
}

/** Who signs a calibration; the server enforces the same rule (routes/instruments.ts). */
const CALIBRATION_ROLES = ['QA', 'Admin'];

export function Instruments({ token, user }: { token: string, user: any }) {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [calibrationDueDate, setCalibrationDueDate] = useState('');
  const [lastCalibrationDate, setLastCalibrationDate] = useState('');
  const [calibratingInst, setCalibratingInst] = useState<any>(null);
  const [newDueDate, setNewDueDate] = useState('');
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageEntry[]>([]);

  const { toast } = useToast();

  
  const fetchInstruments = () => {
    fetch('/api/instruments', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setInstruments(data);
        setLoading(false);
      })
      .catch(err => {
        toast(err.message || 'Failed to fetch instruments', 'error');
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchInstruments();
  }, []);

  const toggleUsage = async (id: string) => {
    if (usageFor === id) { setUsageFor(null); return; }
    try {
      const res = await fetch(`/api/instruments/${id}/usage-log`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The usage log could not be loaded (HTTP ${res.status}).`);
      setUsage(data);
      setUsageFor(id);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, type, calibrationDueDate, lastCalibrationDate })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      setName(''); setType(''); setCalibrationDueDate(''); setLastCalibrationDate('');
      toast('Instrument Added', 'success');
      fetchInstruments();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };


  
  // The modal shows the server's error and stays open when the signature is refused (it rethrows).
  const handleCalibrate = async (password: string, _reason?: string, totpCode?: string) => {
    if (!calibratingInst) return;
    if (!newDueDate) {
      const message = 'Enter the new calibration due date.';
      toast(message, 'error');
      throw new Error(message);
    }
    const res = await fetch(`/api/instruments/${calibratingInst.id}/calibrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ newDueDate, password, ...(totpCode ? { totpCode } : {}) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || `Calibration was not recorded (HTTP ${res.status}).`, 'error');
      throw new Error(data.error || 'Calibration was not recorded.');
    }
    toast('Calibration signed and recorded', 'success');
    for (const w of data.warnings ?? []) toast(w, 'info');
    setCalibratingInst(null);
    setNewDueDate('');
    fetchInstruments();
  };

  const canCalibrate = CALIBRATION_ROLES.includes(user?.role);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'Out of Service': return 'bg-red-100 text-red-800 border-red-200';
      case 'In Calibration': return 'bg-amber-100 text-amber-800 border-amber-200';
      default: return 'bg-slate-100 text-slate-800 border-slate-200';
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-slate-50">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="w-5 h-5 absolute start-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search instruments..." 
              className="ps-10 pe-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64"
            />
          </div>
          <button className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
            <Filter className="w-4 h-4" /> Filter
          </button>
        </div>
      </div>

      
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 mb-6 mx-6 mt-6">
        <h3 className="text-lg font-semibold mb-4">Register New Instrument</h3>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-4">
          <input type="text" placeholder="Instrument Name" required value={name} onChange={e => setName(e.target.value)} className="flex-1 px-4 py-2 border rounded-lg border-slate-300 min-w-[200px]" />
          <input type="text" placeholder="Type (e.g. HPLC, GC)" required value={type} onChange={e => setType(e.target.value)} className="flex-1 px-4 py-2 border rounded-lg border-slate-300 min-w-[150px]" />
          <label className="flex flex-col text-xs text-slate-500 flex-1 min-w-[150px]">Last calibration (certificate)
            <input type="date" required value={lastCalibrationDate} onChange={e => setLastCalibrationDate(e.target.value)} className="px-4 py-2 border rounded-lg border-slate-300 text-sm text-slate-900" />
          </label>
          <label className="flex flex-col text-xs text-slate-500 flex-1 min-w-[150px]">Calibration due
            <input type="date" required value={calibrationDueDate} onChange={e => setCalibrationDueDate(e.target.value)} className="px-4 py-2 border rounded-lg border-slate-300 text-sm text-slate-900" />
          </label>
          <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg flex items-center gap-2 whitespace-nowrap">
            <Plus className="w-4 h-4" /> Add Instrument
          </button>
        </form>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {instruments.map((inst: any) => {
            // Current through the end of the due date (UTC), the same rule as the server.
            const { expired: isOverdue, daysRemaining } = calibrationState(inst.calibrationDueDate);
            return (
              <div key={inst.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2">{inst.id}</h3>
                    <p className="text-sm text-slate-500 font-medium">{inst.type}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${getStatusColor(inst.status)}`}>
                      {inst.status}
                    </span>
                    {canCalibrate && inst.status !== 'Retired' && (
                      <button onClick={() => { setCalibratingInst(inst); setNewDueDate(''); }} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium bg-blue-50 px-2 py-1 rounded border border-blue-200">
                        <Settings2 className="w-3 h-3" /> Log Cal
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">Last Cal:</span>
                    <span className="font-medium text-slate-700">{String(inst.lastCalibrationDate).slice(0, 10)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">Next Due:</span>
                    <span className={`font-bold ${isOverdue ? 'text-red-600' : daysRemaining <= 30 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {String(inst.calibrationDueDate).slice(0, 10)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">Calibrations recorded:</span>
                    <span className="font-medium text-slate-700">{inst.calibrations?.length ?? 0}</span>
                  </div>
                  
                  <button type="button" onClick={() => toggleUsage(inst.id)} aria-expanded={usageFor === inst.id} className="text-xs text-blue-700 hover:text-blue-900 font-medium self-start">
                    {usageFor === inst.id ? 'Hide usage log' : 'Usage log'}
                  </button>
                  {usageFor === inst.id && <UsageLog entries={usage} />}

                  {isOverdue && (
                    <div className="mt-2 bg-red-50 text-red-700 text-xs px-2 py-1.5 rounded font-bold flex items-center gap-1.5 border border-red-200">
                      <XCircle className="w-3.5 h-3.5" /> OVERDUE - DO NOT USE
                    </div>
                  )}
                  {!isOverdue && daysRemaining <= 30 && (
                    <div className="mt-2 bg-amber-50 text-amber-700 text-xs px-2 py-1.5 rounded font-bold flex items-center gap-1.5 border border-amber-200">
                      <AlertTriangle className="w-3.5 h-3.5" /> Due within 30 days
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {calibratingInst && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode="CALIBRATION"
          action="calibrate"
          entityName={`${calibratingInst.name} (${calibratingInst.id})`}
          recordVersion={calibratingInst.version}
          onClose={() => setCalibratingInst(null)}
          onSign={handleCalibrate}
        >
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1">New calibration due date</label>
            <input type="date" required value={newDueDate} onChange={e => setNewDueDate(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            <p className="text-xs text-slate-500 mt-1">The calibration is recorded as performed today; the due date must be after today.
              {calibratingInst.status === 'Out of Service' && ' This instrument stays Out of Service after the calibration.'}</p>
          </div>
        </ElectronicSignatureModal>
      )}
    </div>
  );
}
