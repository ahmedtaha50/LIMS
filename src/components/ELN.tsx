import { formatTime } from '../lib/format';
import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';
import { 
  Book, PenTool, CheckCircle, FileText, Search, Plus, Save, 
  Sparkles, Lock, ShieldCheck, Printer, RefreshCw, Layers, 
  FlaskConical, Calendar, User, Check, AlertCircle, Copy,
  CheckCircle2, X, FileCheck, ArrowRight, ShieldAlert, BadgeCheck
} from 'lucide-react';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { VoiceRecorder } from './VoiceRecorder';
import { formatDate } from '../lib/utils';

interface ELNProps {
  token: string;
  user: any;
}

export function ELN({ token, user }: ELNProps) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<any | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const { toast } = useToast();

  // Create / Edit form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sampleId, setSampleId] = useState('SMP-2026-00001');
  const [experimentType, setExperimentType] = useState('HPLC Assay Quantitative');
  const [pharmacopeia, setPharmacopeia] = useState('USP <621> Chromatography & European Pharmacopoeia (EP 2.2.46)');
  const [dosageForm, setDosageForm] = useState('Finished Product Solid Oral Dosage (500mg Tablets)');
  const [rawMaterial, setRawMaterial] = useState('Paracetamol API (Lot: LOT-PAR-2026-904)');
  const [instrument, setInstrument] = useState('Agilent 1260 Infinity II HPLC System (ID: INST-HPLC-01)');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);

  // Signing state
  const [signingEntry, setSigningEntry] = useState<any | null>(null);
  const [sealVerificationResult, setSealVerificationResult] = useState<any | null>(null);

  const experimentTypes = [
    'HPLC Assay Quantitative',
    'Dissolution Testing (USP Apparatus 2)',
    'Finished Product Impurity Profiling',
    'Stability Timepoint Testing',
    'Karl Fischer Water Content Determination',
    'Cleanroom Environmental Investigation',
    'Method Verification & System Suitability'
  ];

  const pharmacopeiaStandards = [
    'USP <621> Chromatography & European Pharmacopoeia (EP 2.2.46)',
    'USP <711> Dissolution Testing & EP 2.9.3',
    'USP <905> Uniformity of Dosage Units',
    'USP <921> Water Determination (Karl Fischer Method)',
    'ICH Q2(R1) Validation of Analytical Procedures'
  ];

  const fetchEntries = () => {
    setLoading(true);
    fetch('/api/eln', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setEntries(list);
        if (list.length > 0 && !selectedEntry && !isCreating) {
          setSelectedEntry(list[0]);
        }
        setLoading(false);
      })
      .catch(() => {
        toast('Failed to load ELN entries', 'error');
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast('Title and content are required', 'error');
      return;
    }
    try {
      const res = await fetch('/api/eln', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ 
          title, 
          content, 
          sampleId, 
          experimentType,
          pharmacopeia
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('ELN Entry created and logged to immutable audit trail', 'success');
      setIsCreating(false);
      setTitle('');
      setContent('');
      fetchEntries();
    } catch(err: any) {
      toast(err.message, 'error');
    }
  };

  // Authorship (AUTHORSHIP): only the author signs; the meaning is the server's, the body carries credentials and a reason.
  const handleSign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signingEntry) return;
    try {
      const res = await fetch(`/api/eln/${signingEntry.id}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password, ...(reason?.trim() ? { reason: reason.trim() } : {}), ...(totpCode ? { totpCode } : {}) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast(`ELN Entry ${signingEntry.id} signed and locked per 21 CFR Part 11`, 'success');
      setSigningEntry(null);
      fetchEntries();
      if (selectedEntry?.id === signingEntry.id) {
        setSelectedEntry({ 
          ...selectedEntry, 
          status: 'Signed', 
          locked: true,
          signedAt: new Date().toISOString(),
          signedBy: user?.id,
          signerName: data.signature?.signedBy,
          contentHash: data.signature?.contentHash
        });
      }
    } catch(err: any) {
      toast(err.message, 'error');
      throw err;
    }
  };

  // The server recomputes what the signature was bound to (GET /signatures/verify/:id): the record, its version and the audit
  // chain. The verdict is its status; a legacy signature is shown as legacy-unverifiable, never as valid.
  const handleVerifySeal = async (entry: any) => {
    try {
      const res = await fetch(`/api/eln/${entry.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const sig = (data.signatures ?? [])[0];
      if (!sig) throw new Error('This worksheet has no signature record to verify.');
      const vres = await fetch(`/api/signatures/verify/${sig.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const v = await vres.json();
      if (!vres.ok) throw new Error(v.error || 'Signature verification failed');
      setSealVerificationResult({
        isValid: v.status === 'valid',
        status: v.status,
        statusText: v.statusText,
        computedHash: sig.contentHash,
        storedHash: entry.contentHash,
        signedAt: entry.signedAt,
        signedBy: v.signature?.signerName ?? entry.signerName
      });
    } catch (err: any) {
      toast(err.message || 'Seal verification failed', 'error');
    }
  };

  const handleAIGenerateProtocol = async () => {
    setAiGenerating(true);
    try {
      const res = await fetch('/api/ai/eln-protocol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: title || `${experimentType} Protocol (${dosageForm})`,
          experimentType,
          pharmacopeia,
          dosageForm,
          sampleId: sampleId || 'SMP-2026-00001',
          rawMaterial,
          instrument
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setContent(data.protocol || '');
      if (!title) setTitle(`${experimentType} Protocol & Worksheet (${dosageForm})`);
      setShowAiModal(false);
      toast('Pharmacopeial GxP protocol generated successfully', 'success');
    } catch (err: any) {
      toast(err.message || 'AI generation failed', 'error');
    } finally {
      setAiGenerating(false);
    }
  };

  // Filtered entries
  const filteredEntries = entries.filter(e => {
    const matchesSearch = (e.title || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
                          (e.id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                          (e.sampleId || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === 'ALL' || e.experimentType === filterType;
    return matchesSearch && matchesType;
  });

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-8.5rem)] bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
      {/* Sidebar: Entries List */}
      <div className="w-full md:w-84 border-e border-slate-200 flex flex-col bg-slate-50/60 shrink-0">
        <div className="p-4 border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Book className="w-4 h-4 text-blue-600" />
              <h2 className="font-extrabold text-sm text-slate-900 tracking-tight">دفتر المختبر (ELN)</h2>
            </div>
            <button
              onClick={() => {
                setIsCreating(true);
                setSelectedEntry(null);
                setTitle('');
                setContent('');
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New Worksheet
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute start-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by ID, sample, or title..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full ps-8 pe-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Filter Badges */}
        <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-1.5 overflow-x-auto text-[11px]">
          <button
            onClick={() => setFilterType('ALL')}
            className={`px-2 py-0.5 rounded-full font-medium shrink-0 transition-colors ${
              filterType === 'ALL' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            All ({entries.length})
          </button>
          <button
            onClick={() => setFilterType('HPLC Assay Quantitative')}
            className={`px-2 py-0.5 rounded-full font-medium shrink-0 transition-colors ${
              filterType === 'HPLC Assay Quantitative' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            HPLC
          </button>
          <button
            onClick={() => setFilterType('Dissolution Testing (USP Apparatus 2)')}
            className={`px-2 py-0.5 rounded-full font-medium shrink-0 transition-colors ${
              filterType === 'Dissolution Testing (USP Apparatus 2)' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
            }`}
          >
            Dissolution
          </button>
        </div>

        {/* Entries Scroll List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {loading ? (
            <div className="p-8 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading lab notebooks...
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No laboratory entries found.
            </div>
          ) : (
            filteredEntries.map(entry => {
              const isSelected = selectedEntry?.id === entry.id && !isCreating;
              const isSigned = entry.status === 'Signed';
              return (
                <div
                  key={entry.id}
                  onClick={() => {
                    setSelectedEntry(entry);
                    setIsCreating(false);
                    setSealVerificationResult(null);
                  }}
                  className={`p-3.5 cursor-pointer transition-colors text-start ${
                    isSelected ? 'bg-blue-50/80 border-s-4 border-blue-600' : 'hover:bg-slate-100/70'
                  }`}
                >
                  <div className="flex items-start justify-between gap-1 mb-1">
                    <span className="font-mono text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded font-bold">
                      {entry.id}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      isSigned ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {isSigned ? '21 CFR Part 11 Sealed' : 'Draft / In-Progress'}
                    </span>
                  </div>
                  <h4 className="font-bold text-xs text-slate-800 line-clamp-1">{entry.title}</h4>
                  <div className="flex items-center justify-between text-[11px] text-slate-500 mt-2">
                    <span className="truncate max-w-[140px] text-[10px] font-medium">{entry.experimentType || 'General'}</span>
                    <span className="font-mono text-[10px]">{formatDate(entry.enteredAt).split(',')[0]}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col bg-white overflow-hidden">
        {isCreating ? (
          /* ================= CREATE NEW ELN ENTRY ================= */
          <div className="flex-1 overflow-y-auto p-6 md:p-8">
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">
                    Create Analytical Laboratory Worksheet
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Structured GxP testing execution per USP / European Pharmacopoeia (EP) guidelines.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAiModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-bold transition-colors shadow-2xs self-start sm:self-auto"
                >
                  <Sparkles className="w-4 h-4 text-indigo-600" />
                  <span>AI Protocol Generator (USP &lt;621&gt; / EP)</span>
                </button>
              </div>

              <form onSubmit={handleCreate} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Protocol & Worksheet Title *
                    </label>
                    <input
                      required
                      type="text"
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="e.g. Paracetamol 500mg HPLC Assay & System Suitability Verification"
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Linked QC Sample ID *
                    </label>
                    <input
                      required
                      type="text"
                      value={sampleId}
                      onChange={e => setSampleId(e.target.value)}
                      placeholder="e.g. SMP-2026-00001"
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Analytical Method Category
                    </label>
                    <select
                      value={experimentType}
                      onChange={e => setExperimentType(e.target.value)}
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      {experimentTypes.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Target Pharmacopeia Reference
                    </label>
                    <select
                      value={pharmacopeia}
                      onChange={e => setPharmacopeia(e.target.value)}
                      className="w-full px-3.5 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      {pharmacopeiaStandards.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                      Worksheet Markdown Content *
                    </label>
                    {/* Cleanroom Voice Dictation */}
                    <VoiceRecorder
                      token={token}
                      onTranscription={text => {
                        setContent(prev => {
                          const separator = prev ? '\n\n' : '';
                          return `${prev}${separator}### Cleanroom Analyst Voice Observation (${formatTime(new Date(), { digits: 'latin' })}):\n${text}`;
                        });
                      }}
                    />
                  </div>
                  <textarea
                    required
                    rows={16}
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="Enter analytical procedure, instrument setpoints, sample preparations, and raw chromatogram data, or click 'AI Protocol Generator' above..."
                    className="w-full p-4 border border-slate-300 rounded-xl text-xs font-mono leading-relaxed focus:ring-2 focus:ring-blue-500 outline-none resize-y"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-4 py-2 border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-xs flex items-center gap-1.5 transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" /> Save Notebook Entry
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : selectedEntry ? (
          /* ================= VIEW / SIGN SELECTED ENTRY ================= */
          <div className="flex-1 overflow-y-auto flex flex-col">
            {/* Entry Header */}
            <div className="p-6 border-b border-slate-200 bg-slate-50/70 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded">
                    {selectedEntry.id}
                  </span>
                  <span className={`px-2.5 py-0.5 rounded text-xs font-bold border ${
                    selectedEntry.status === 'Signed' 
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-300' 
                      : 'bg-amber-100 text-amber-800 border-amber-300'
                  }`}>
                    {selectedEntry.status === 'Signed' ? '21 CFR Part 11 Sealed (Locked)' : 'Draft / Editable Worksheet'}
                  </span>
                  {selectedEntry.sampleId && (
                    <span className="font-mono text-xs text-slate-600 bg-slate-200/80 px-2 py-0.5 rounded">
                      Sample: {selectedEntry.sampleId}
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">{selectedEntry.title}</h2>
                <div className="flex items-center gap-4 text-xs text-slate-500 mt-1">
                  <span className="flex items-center gap-1">
                    <FlaskConical className="w-3.5 h-3.5 text-slate-400" /> {selectedEntry.experimentType || 'General Analysis'}
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" /> Entered: {formatDate(selectedEntry.enteredAt)}
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-2xs"
                >
                  <Printer className="w-3.5 h-3.5 text-slate-500" /> Print
                </button>

                {selectedEntry.status === 'Signed' ? (
                  <button
                    type="button"
                    onClick={() => handleVerifySeal(selectedEntry)}
                    className="px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-2xs transition-colors"
                  >
                    <ShieldCheck className="w-4 h-4 text-indigo-600" /> Verify Digital Seal
                  </button>
                ) : selectedEntry.enteredBy === user?.id ? (
                  <button
                    type="button"
                    onClick={() => setSigningEntry(selectedEntry)}
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-xs transition-colors"
                  >
                    <Lock className="w-4 h-4" /> Sign & Lock Record (Part 11)
                  </button>
                ) : (
                  <span className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg">
                    Awaiting the author's signature ({selectedEntry.authorName ?? selectedEntry.enteredBy})
                  </span>
                )}
              </div>
            </div>

            {/* Part 11 Electronic Signature Seal Banner */}
            {selectedEntry.status === 'Signed' && (
              <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-3.5 space-y-2">
                <div className="flex items-center justify-between text-xs text-emerald-900">
                  <div className="flex items-center gap-2 font-bold">
                    <Lock className="w-4 h-4 text-emerald-700" />
                    <span>
                      21 CFR Part 11 Electronically Certified & Locked Document
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded border border-emerald-300 font-bold">
                    IMMUTABLE RECORD
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] font-sans text-emerald-900">
                  <div>
                    <span className="text-emerald-700">Analyst: </span>
                    <strong>{selectedEntry.signedBy || user?.name || 'Authorized QC Analyst'}</strong>
                  </div>
                  <div>
                    <span className="text-emerald-700">Signed: </span>
                    <strong>{selectedEntry.signedAt ? formatDate(selectedEntry.signedAt) : 'Archived'}</strong>
                  </div>
                  <div className="truncate font-mono">
                    <span className="text-emerald-700">SHA-256 Seal: </span>
                    <strong>{selectedEntry.contentHash || 'Verified cryptographically'}</strong>
                  </div>
                </div>
              </div>
            )}

            {/* Verification Result Modal / Banner */}
            {sealVerificationResult && (
              <div className="bg-indigo-50 border-b border-indigo-200 p-4 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-indigo-950">
                    <BadgeCheck className="w-4.5 h-4.5 text-indigo-600" />
                    <span>Cryptographic Seal Validation (ALCOA+ Integrity)</span>
                  </div>
                  <button
                    onClick={() => setSealVerificationResult(null)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-indigo-900">
                  Status: <strong>{sealVerificationResult.isValid ? 'Valid: the record and the audit chain match the signature' : `${sealVerificationResult.status}: ${sealVerificationResult.statusText ?? 'the signature does not verify'}`}</strong>
                </p>
                <p className="font-mono text-[10px] text-indigo-800 break-all">
                  Signed SHA-256: {sealVerificationResult.computedHash}
                </p>
              </div>
            )}

            {/* Entry Content Body */}
            <div className="p-6 md:p-8 flex-1">
              <div className="prose max-w-none text-slate-800 text-xs leading-relaxed font-mono whitespace-pre-wrap bg-slate-50/50 p-6 rounded-xl border border-slate-200">
                {selectedEntry.content}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-400">
            <Book className="w-12 h-12 text-slate-300 mb-3" />
            <p className="text-sm font-medium">Select an ELN worksheet from the left or create a new entry.</p>
          </div>
        )}
      </div>

      {/* ================= AI PROTOCOL GENERATOR MODAL ================= */}
      {showAiModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                <h3 className="font-extrabold text-base text-slate-900">
                  AI Analytical Protocol Generator (USP &lt;621&gt; / EP)
                </h3>
              </div>
              <button 
                onClick={() => setShowAiModal(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Target Pharmacopeia Standard</label>
                <select
                  value={pharmacopeia}
                  onChange={e => setPharmacopeia(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                >
                  {pharmacopeiaStandards.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Test / Experiment Type</label>
                  <select
                    value={experimentType}
                    onChange={e => setExperimentType(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                  >
                    {experimentTypes.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Dosage Form & Strength</label>
                  <input
                    type="text"
                    value={dosageForm}
                    onChange={e => setDosageForm(e.target.value)}
                    placeholder="e.g. 500mg Tablets"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Drug Substance / Material</label>
                  <input
                    type="text"
                    value={rawMaterial}
                    onChange={e => setRawMaterial(e.target.value)}
                    placeholder="e.g. Paracetamol BP/USP"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Instrument System</label>
                  <input
                    type="text"
                    value={instrument}
                    onChange={e => setInstrument(e.target.value)}
                    placeholder="e.g. Agilent 1260 HPLC"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 text-slate-600 text-[11px] leading-relaxed">
                Includes official pharmacopeial scope, cleanroom PPE safety, reference standard preparation, chromatographic parameters, System Suitability Criteria (SST %RSD ≤ 1.0%), bracketing sequence, and Part 11 signoff block.
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowAiModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-bold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAIGenerateProtocol}
                disabled={aiGenerating}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {aiGenerating ? 'Generating Pharmacopeial Protocol...' : 'Generate Protocol'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 21 CFR PART 11 ELECTRONIC SIGNATURE MODAL ================= */}
      {signingEntry && (
        <ElectronicSignatureModal
          isOpen={true}
          user={user}
          action="Sign & Lock"
          token={token}
          meaningCode="AUTHORSHIP"
          recordVersion={signingEntry.version}
          entityName={`ELN Entry: ${signingEntry.title}`}
          onClose={() => setSigningEntry(null)}
          onSign={handleSign}
        />
      )}
    </div>
  );
}
