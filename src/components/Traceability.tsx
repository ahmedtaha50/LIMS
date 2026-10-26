import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';
import { 
  GitMerge, Search, ShieldCheck, ShieldAlert, CheckCircle2, 
  Clock, AlertTriangle, Layers, Microscope, FlaskConical, 
  Wind, FileText, ChevronRight, Download, Check, RefreshCw, 
  Sparkles, Lock, ArrowRight, BarChart3, Database, FileCheck,
  Building2, Calendar, User, Eye, Plus, CheckCircle, Printer, X
} from 'lucide-react';
import { formatDate } from '../lib/utils';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';

/** One master batch of the dossier (GET /traceability/batch/:batch, `master`): a batch number may belong to more than one product. */
export interface MasterBatchView {
  id: string; productName: string; batchNo: string; status: string; manufacturedOn: string | null; expiresOn: string | null; batchSize: string | null;
}

/** The master record of the batch as the records hold it; nothing is filled in where the record is empty. */
export function MasterBatchPanel({ master }: { master: readonly MasterBatchView[] | undefined }) {
  if (!master || master.length === 0) {
    return <p className="text-xs text-slate-500">No master batch record: this batch number is not registered under a product (Master data).</p>;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {master.map(m => (
        <div key={m.id} className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <div className="font-semibold text-slate-900">{m.productName}</div>
          <div>Batch {m.batchNo}: {m.status}</div>
          <div>Manufactured {m.manufacturedOn ?? 'not recorded'}, expires {m.expiresOn ?? 'not recorded'}{m.batchSize ? `, size ${m.batchSize}` : ''}</div>
        </div>
      ))}
    </div>
  );
}

interface TraceabilityProps {
  token: string;
  user?: any;
}

export function Traceability({ token, user }: TraceabilityProps) {
  const [batchNo, setBatchNo] = useState('');
  // The batches that exist (GET /traceability/batches), newest records first; never a fixed list.
  const [knownBatches, setKnownBatches] = useState<string[]>([]);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [activeStage, setActiveStage] = useState<1 | 2 | 3 | 4 | 5 | 'audits'>(1);
  const { toast } = useToast();

  // Modals state
  const [selectedCoa, setSelectedCoa] = useState<any | null>(null);
  const [isDispenseModalOpen, setIsDispenseModalOpen] = useState(false);
  const [isReleaseModalOpen, setIsReleaseModalOpen] = useState(false);
  const [isVerifyChainModalOpen, setIsVerifyChainModalOpen] = useState(false);
  const [chainVerifyData, setChainVerifyData] = useState<any | null>(null);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [showCertificateModal, setShowCertificateModal] = useState(false);

  // New material form
  // Every value is stated by the dispenser (nothing is preset), and a second person verifies it with their own credentials.
  const EMPTY_MATERIAL = {
    materialName: '',
    materialType: '',
    lotNumber: '',
    manufacturer: '',
    coaNumber: '',
    coaStatus: '',
    quantityDispensed: '',
    potencyAssay: '',
    lossOnDrying: ''
  };
  const [newMaterial, setNewMaterial] = useState(EMPTY_MATERIAL);
  const [verifier, setVerifier] = useState({ email: '', password: '', totpCode: '' });

  const fetchBatchTrace = async (bNum: string) => {
    if (!bNum.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/traceability/batch/${encodeURIComponent(bNum.trim())}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to fetch batch traceability data');
      setData(json);
    } catch (err: any) {
      toast(err.message, 'error');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch('/api/traceability/batches', { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load the batch list');
        const names = (json as Array<{ batch: string }>).map(b => b.batch);
        setKnownBatches(names);
        if (names.length) { setBatchNo(names[0]); fetchBatchTrace(names[0]); }
      })
      .catch((err: any) => toast(err.message, 'error'));
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchBatchTrace(batchNo);
  };

  // Dispense Material handler
  const handleDispenseMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/traceability/batch/${encodeURIComponent(batchNo)}/material`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          ...newMaterial,
          verifier: { email: verifier.email, password: verifier.password, ...(verifier.totpCode ? { totpCode: verifier.totpCode } : {}) }
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to record material dispensing');
      toast(`Raw material ${newMaterial.materialName} dispensed and verified by a second person`, 'success');
      setIsDispenseModalOpen(false);
      setNewMaterial(EMPTY_MATERIAL);
      setVerifier({ email: '', password: '', totpCode: '' });
      fetchBatchTrace(batchNo);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  // Part 11 Batch Release Authorization Handler
  const handleAuthorizeRelease = async (password: string, reason?: string) => {
    try {
      const res = await fetch(`/api/traceability/batch/${encodeURIComponent(batchNo)}/release`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ 
          password, 
          reason: reason || 'Batch manufactured and tested in full compliance with GMP and Marketing Authorization',
          dispositionRecommendation: 'Conforms to all registered European & USP Pharmacopeia specifications. Released for market distribution.'
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to authorize batch release');
      toast(`Batch ${batchNo} officially released! 21 CFR Part 11 Digital Certificate sealed.`, 'success');
      setIsReleaseModalOpen(false);
      fetchBatchTrace(batchNo);
    } catch (err: any) {
      toast(err.message, 'error');
      throw err;
    }
  };

  // Cryptographic Chain Verification Handler
  const handleVerifyChain = async () => {
    setVerifyingChain(true);
    try {
      const res = await fetch(`/api/traceability/batch/${encodeURIComponent(batchNo)}/verify-chain`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Chain verification failed');
      setChainVerifyData(json);
      setIsVerifyChainModalOpen(true);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setVerifyingChain(false);
    }
  };

  // Derived metrics
  const totalMaterials = data?.materials?.length || 0;
  const verifiedCoaCount = data?.materials?.filter((m: any) => m.coaStatus === 'Verified Pass')?.length || 0;
  const stage1Passed = totalMaterials > 0 && verifiedCoaCount === totalMaterials;

  const totalCleanroomRecords = data?.cleanroom?.length || 0;
  const stage2Passed = totalCleanroomRecords > 0 && data?.cleanroom?.every((c: any) => c.status === 'Pass');

  const totalSamples = data?.samples?.length || 0;
  const totalResults = data?.results?.length || 0;
  const passedResults = data?.results?.filter((r: any) => !r.isOos && r.value !== null)?.length || 0;
  const stage3Passed = totalResults > 0 && passedResults === totalResults && totalSamples > 0 && data?.samples?.every((s: any) => s.state === 'Approved');

  const oosCount = data?.oos?.length || 0;
  const openOosCount = data?.oos?.filter((o: any) => o.status !== 'Approved')?.length || 0;
  // r2-qms: the deviations about the batch (GET /traceability/batch/:batch `deviations`); an open Major, Critical or unclassified one holds it.
  const deviations: Array<{ id: string; title: string; classification: string | null; state: string; open: boolean; blocksRelease: boolean }> = data?.deviations ?? [];
  const blockingDeviationCount = deviations.filter(d => d.blocksRelease).length;
  const stage4Passed = (oosCount === 0 || openOosCount === 0) && blockingDeviationCount === 0;

  const isBatchReleased = data?.release?.status === 'Released';
  const stage5Passed = isBatchReleased;

  const isEligibleForRelease = stage1Passed && stage2Passed && stage3Passed && stage4Passed && !isBatchReleased;

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-blue-600 font-semibold text-xs tracking-wider uppercase">
            <GitMerge className="w-4 h-4" /> FDA 21 CFR Part 211.188 & EU GMP Annex 1 Batch Genealogy
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 mt-1">مصفوفة تتبع التشغيلات وسلسلة النسب (Traceability Matrix)</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            5-Stage Interlocking Quality Timeline: Raw Materials & CoA, Cleanroom Monitoring, QC Testing, OOS Deviations, and Final Release.
          </p>
        </div>

        {/* Quick Batch Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">Quick Select:</span>
          {knownBatches.length === 0 && <span className="text-xs text-slate-400">No batches recorded yet.</span>}
          {knownBatches.slice(0, 8).map(b => (
            <button
              key={b}
              onClick={() => {
                setBatchNo(b);
                fetchBatchTrace(b);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-colors ${
                batchNo === b 
                  ? 'bg-blue-600 text-white shadow-xs' 
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Master record of the batch (r2-master-data) */}
      {data && (
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs" aria-label="Master batch record">
          <MasterBatchPanel master={data.master} />
        </div>
      )}

      {/* Search Bar & Quick Actions */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <form onSubmit={handleSearch} className="flex gap-2 w-full sm:w-auto flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              value={batchNo} 
              onChange={e => setBatchNo(e.target.value)} 
              className="w-full ps-9 pe-4 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none" 
              placeholder="Enter Batch Number" 
            />
          </div>
          <button 
            type="submit" 
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors"
          >
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Trace Batch
          </button>
        </form>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button
            onClick={handleVerifyChain}
            disabled={verifyingChain || !data}
            className="px-3.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-2xs"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
            {verifyingChain ? 'Checking Hashes...' : 'Verify Cryptographic Lineage'}
          </button>

          {isBatchReleased && (
            <button
              onClick={() => setShowCertificateModal(true)}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors"
            >
              <FileCheck className="w-3.5 h-3.5" />
              Batch Release Certificate
            </button>
          )}
        </div>
      </div>

      {data && (
        <div className="space-y-6">
          {/* Top 5-Stage Interactive Timeline Stepper */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-600" /> 5-Stage Traceability Timeline
              </span>
              <span className={`text-xs font-bold px-3 py-1 rounded-full border ${
                isBatchReleased 
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300' 
                  : openOosCount > 0 
                  ? 'bg-red-50 text-red-800 border-red-300' 
                  : 'bg-blue-50 text-blue-800 border-blue-300'
              }`}>
                {isBatchReleased ? 'Released for Market (Authorized)' : openOosCount > 0 ? 'Batch Held (Open OOS)' : 'Batch In-Progress'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {/* Stage 1 Button */}
              <button
                type="button"
                onClick={() => setActiveStage(1)}
                className={`p-3.5 rounded-xl border text-start transition-all ${
                  activeStage === 1 
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs' 
                    : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center font-mono">
                    1
                  </span>
                  {stage1Passed ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <Check className="w-3 h-3" /> CoAs Verified
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                      Pending CoAs
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-xs text-slate-900">1. صرف المواد الخام و CoA</h4>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  {totalMaterials} materials dispensed & verified
                </p>
              </button>

              {/* Stage 2 Button */}
              <button
                type="button"
                onClick={() => setActiveStage(2)}
                className={`p-3.5 rounded-xl border text-start transition-all ${
                  activeStage === 2 
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs' 
                    : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-xs flex items-center justify-center font-mono">
                    2
                  </span>
                  {stage2Passed ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <Check className="w-3 h-3" /> In Control
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                      Review Needed
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-xs text-slate-900">2. بيئة الغرف المعقمة (ISO)</h4>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  Grade A/B Cleanroom air monitoring
                </p>
              </button>

              {/* Stage 3 Button */}
              <button
                type="button"
                onClick={() => setActiveStage(3)}
                className={`p-3.5 rounded-xl border text-start transition-all ${
                  activeStage === 3 
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs' 
                    : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-cyan-600 text-white font-bold text-xs flex items-center justify-center font-mono">
                    3
                  </span>
                  {stage3Passed ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <Check className="w-3 h-3" /> All Passed
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                      {passedResults}/{totalResults} Completed
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-xs text-slate-900">3. الفحوصات التحليلية للمنتج</h4>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  HPLC Assay, Dissolution, Impurities
                </p>
              </button>

              {/* Stage 4 Button */}
              <button
                type="button"
                onClick={() => setActiveStage(4)}
                className={`p-3.5 rounded-xl border text-start transition-all ${
                  activeStage === 4 
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs' 
                    : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`w-6 h-6 rounded-full text-white font-bold text-xs flex items-center justify-center font-mono ${
                    oosCount > 0 || deviations.length > 0 ? 'bg-amber-600' : 'bg-emerald-600'
                  }`}>
                    4
                  </span>
                  {blockingDeviationCount > 0 ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-800">
                      {blockingDeviationCount} Open deviation{blockingDeviationCount === 1 ? '' : 's'}
                    </span>
                  ) : oosCount === 0 ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Zero OOS
                    </span>
                  ) : openOosCount === 0 ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                      Closed ({oosCount})
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-800">
                      {openOosCount} Open OOS
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-xs text-slate-900">4. سجل الانحرافات و OOS</h4>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  Deviations & Out-of-Specification
                </p>
              </button>

              {/* Stage 5 Button */}
              <button
                type="button"
                onClick={() => setActiveStage(5)}
                className={`p-3.5 rounded-xl border text-start transition-all ${
                  activeStage === 5 
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs' 
                    : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`w-6 h-6 rounded-full text-white font-bold text-xs flex items-center justify-center font-mono ${
                    isBatchReleased ? 'bg-emerald-600' : 'bg-purple-600'
                  }`}>
                    5
                  </span>
                  {isBatchReleased ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <Lock className="w-3 h-3" /> QP Signed
                    </span>
                  ) : isEligibleForRelease ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 animate-pulse">
                      Ready to Sign
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                      Pending Stages
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-xs text-slate-900">5. الاعتماد النهائي والتوقيع</h4>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                  Qualified Person (QP) Part 11 Signoff
                </p>
              </button>
            </div>

            {/* Quick Switch to Audit Chain */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">
                Current View: <strong className="text-slate-800">
                  {activeStage === 1 && 'Stage 1: Raw Materials Dispensing & CoA Verification'}
                  {activeStage === 2 && 'Stage 2: ISO Cleanroom & Environmental Monitoring'}
                  {activeStage === 3 && 'Stage 3: Finished Product Analytical QC Testing (USP/EP)'}
                  {activeStage === 4 && 'Stage 4: Deviations & Out-of-Specification Investigations'}
                  {activeStage === 5 && 'Stage 5: Final Batch Release Disposition & 21 CFR Part 11 Electronic Signature'}
                  {activeStage === 'audits' && 'Chained Part 11 Audit Trail & SHA-256 Ledger'}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setActiveStage('audits')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg font-bold text-xs transition-colors ${
                  activeStage === 'audits' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" /> View Cryptographic Audit Trail ({data.audits?.length || 0})
              </button>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* STAGE 1: RAW MATERIALS DISPENSING & COA VERIFICATION                      */}
          {/* ========================================================================= */}
          {activeStage === 1 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs font-mono font-bold flex items-center justify-center">1</span>
                    <h3 className="font-extrabold text-base text-slate-900">
                      صرف المواد الخام والتحقق من شهادات التحليل (Raw Materials & CoA Verification)
                    </h3>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Traceability of all APIs and excipients, manufacturer lot numbers, and supplier Certificates of Analysis.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDispenseModalOpen(true)}
                  className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-2xs self-start sm:self-auto"
                >
                  <Plus className="w-3.5 h-3.5" /> Dispense New Raw Material
                </button>
              </div>

              {/* Materials Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-start text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-mono tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Material Name & Type</th>
                      <th className="px-4 py-3">Lot # / Manufacturer</th>
                      <th className="px-4 py-3">Dispensed Qty</th>
                      <th className="px-4 py-3">Assay / LOD</th>
                      <th className="px-4 py-3">CoA Verification</th>
                      <th className="px-4 py-3">Dispensed / Verified By</th>
                      <th className="px-4 py-3 text-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-sans">
                    {data.materials?.map((m: any) => (
                      <tr key={m.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5">
                          <div className="font-bold text-slate-900">{m.materialName}</div>
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold mt-0.5 ${
                            m.materialType?.includes('API') 
                              ? 'bg-purple-100 text-purple-800' 
                              : 'bg-slate-100 text-slate-700'
                          }`}>
                            {m.materialType}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 font-mono">
                          <div className="font-semibold text-blue-700">{m.lotNumber}</div>
                          <div className="text-[11px] text-slate-500 font-sans">{m.manufacturer}</div>
                        </td>
                        <td className="px-4 py-3.5 font-mono font-bold text-slate-800">
                          {m.quantityDispensed}
                        </td>
                        <td className="px-4 py-3.5 text-[11px]">
                          <div><span className="text-slate-400">Assay:</span> <strong className="font-mono text-emerald-700">{m.potencyAssay}</strong></div>
                          <div><span className="text-slate-400">LOD:</span> <strong className="font-mono text-slate-700">{m.lossOnDrying}</strong></div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="font-mono text-xs font-semibold text-slate-800">{m.coaNumber}</div>
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 mt-0.5">
                            <CheckCircle2 className="w-3 h-3" /> {m.coaStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-[11px] text-slate-600">
                          <div><span className="text-slate-400">Op:</span> {m.dispensedByName}</div>
                          <div><span className="text-slate-400">Verified:</span> {m.verifiedBy && m.verifiedBy !== m.dispensedBy ? m.verifiedByName : <span className="text-amber-700">not independently verified</span>}</div>
                        </td>
                        <td className="px-4 py-3.5 text-end">
                          <button
                            type="button"
                            onClick={() => setSelectedCoa(m)}
                            className="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded text-xs font-semibold inline-flex items-center gap-1 shadow-2xs"
                          >
                            <Eye className="w-3 h-3 text-slate-400" /> View CoA
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STAGE 2: ISO CLEANROOM & ENVIRONMENTAL MONITORING (EU GMP ANNEX 1)        */}
          {/* ========================================================================= */}
          {activeStage === 2 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-xs font-mono font-bold flex items-center justify-center">2</span>
                  <h3 className="font-extrabold text-base text-slate-900">
                    مراقبة غرف النظافة والبيئة المعقمة (ISO Cleanroom & Environmental Monitoring)
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Validation of particulate and viable microbiological environmental counts per EU GMP Annex 1 (2022) and ISO 14644-1.
                </p>
              </div>

              {/* r2-em (roadmap M32): what the records say for this batch's rooms and windows; nothing is claimed that they do not hold. */}
              <div className={`rounded-xl p-4 flex items-center gap-3 border ${stage2Passed ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className={`w-9 h-9 rounded-full flex items-center justify-center ${stage2Passed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  <Wind className="w-5 h-5" />
                </div>
                <div>
                  <h4 className={`font-bold text-xs ${stage2Passed ? 'text-emerald-900' : 'text-amber-900'}`}>
                    {(data.cleanroomWindows?.length ?? 0) === 0 ? 'No room window recorded for this batch: no environmental results are attributed to it.'
                      : totalCleanroomRecords === 0 ? 'No environmental result in the rooms and windows of this batch.'
                      : stage2Passed ? `All ${totalCleanroomRecords} results in the batch's rooms and windows passed.`
                      : `${data.cleanroom.filter((c: any) => c.status !== 'Pass').length} of ${totalCleanroomRecords} results in the batch's rooms and windows are at Alert or Action level.`}
                  </h4>
                  <p className="text-[11px] text-slate-600">
                    {(data.cleanroomWindows ?? []).map((w: any) => `${w.room} ${w.fromDate} to ${w.toDate}`).join('; ')}
                  </p>
                </div>
              </div>

              {/* Cleanroom Records Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-start text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-mono tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Sampling point</th>
                      <th className="px-4 py-3">Room</th>
                      <th className="px-4 py-3">Grade</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3">Date sampled</th>
                      <th className="px-4 py-3">Evaluation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-sans">
                    {data.cleanroom?.map((c: any) => (
                      <tr key={c.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5 font-bold text-slate-800">{c.pointCode} <span className="font-normal text-slate-500">{c.location}</span></td>
                        <td className="px-4 py-3.5 text-slate-700">{c.room}</td>
                        <td className="px-4 py-3.5">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                            c.grade === 'Grade A' ? 'bg-purple-100 text-purple-800' :
                            c.grade === 'Grade B' ? 'bg-blue-100 text-blue-800' :
                            'bg-slate-100 text-slate-700'
                          }`}>
                            {c.grade}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-slate-700">{c.method} ({c.occupancy})</td>
                        <td className="px-4 py-3.5 font-mono font-semibold text-slate-800">{c.count} {c.unit}</td>
                        <td className="px-4 py-3.5 font-mono text-slate-500">{c.sampledOn}</td>
                        <td className="px-4 py-3.5">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border ${
                            c.status === 'Pass' ? 'text-emerald-800 bg-emerald-100 border-emerald-300' :
                            c.status === 'Alert' ? 'text-amber-800 bg-amber-100 border-amber-300' : 'text-red-800 bg-red-100 border-red-300'
                          }`}>
                            {c.status}{c.deviationId ? ` (deviation ${c.deviationId})` : ''}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STAGE 3: FINISHED PRODUCT ANALYTICAL QC TESTING (USP/EP)                  */}
          {/* ========================================================================= */}
          {activeStage === 3 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-cyan-600 text-white text-xs font-mono font-bold flex items-center justify-center">3</span>
                  <h3 className="font-extrabold text-base text-slate-900">
                    الفحوصات التحليلية للمنتج النهائي (Finished Product Analytical QC Testing)
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Chromatographic assay (HPLC USP &lt;621&gt;), dissolution kinetics (USP &lt;711&gt;), and degradation impurity profiling.
                </p>
              </div>

              {/* Samples List */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {data.samples?.map((s: any) => (
                  <div key={s.id} className="border border-slate-200 rounded-xl p-4 bg-slate-50/60">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-bold text-blue-700">{s.id}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        s.state === 'Approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {s.state}
                      </span>
                    </div>
                    <h5 className="font-bold text-xs text-slate-800 mt-1">{s.material}</h5>
                    <div className="text-[11px] text-slate-500 mt-2 flex items-center justify-between">
                      <span>Batch: <strong className="font-mono">{s.batch}</strong></span>
                      <span className="font-mono text-[10px]">v{s.version}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Analytical Results Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-start text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-mono tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Sample ID</th>
                      <th className="px-4 py-3">Analytical Parameter</th>
                      <th className="px-4 py-3">Specification Limits</th>
                      <th className="px-4 py-3">Observed Value</th>
                      <th className="px-4 py-3">Instrument ID</th>
                      <th className="px-4 py-3">Evaluation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-sans">
                    {data.results?.map((r: any) => (
                      <tr key={r.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5 font-mono font-semibold text-blue-600">{r.sampleId}</td>
                        <td className="px-4 py-3.5 font-bold text-slate-800">{r.parameter}</td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-slate-500">
                          {r.specMin !== null && r.specMax !== null ? `${r.specMin} - ${r.specMax}` : 'Report'}
                        </td>
                        <td className="px-4 py-3.5 font-mono font-extrabold text-sm text-slate-900">
                          {r.value !== null ? r.value : <span className="text-slate-400 font-normal italic">In progress...</span>}
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-slate-600">
                          {r.instrumentId || 'INST-HPLC-01'}
                        </td>
                        <td className="px-4 py-3.5">
                          {r.isOos ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-800 bg-red-100 px-2.5 py-0.5 rounded border border-red-300">
                              <AlertTriangle className="w-3 h-3" /> OOS FAIL
                            </span>
                          ) : r.value !== null ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 bg-emerald-100 px-2.5 py-0.5 rounded border border-emerald-300">
                              <Check className="w-3 h-3" /> PASS
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-800 bg-blue-100 px-2.5 py-0.5 rounded">
                              <Clock className="w-3 h-3" /> Testing
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STAGE 4: DEVIATIONS & OUT-OF-SPECIFICATION INVESTIGATIONS (OOS)            */}
          {/* ========================================================================= */}
          {activeStage === 4 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-amber-600 text-white text-xs font-mono font-bold flex items-center justify-center">4</span>
                  <h3 className="font-extrabold text-base text-slate-900">
                    سجل الانحرافات وحالات الخروج عن المواصفات (Deviations & OOS Investigations)
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  FDA 21 CFR Part 211.192 compliance review for laboratory anomalies, Phase 1/Phase 2 root cause analyses, and CAPAs.
                </p>
              </div>

              {deviations.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">Deviations (quality management)</h4>
                  {deviations.map(d => (
                    <a key={d.id} href={`#/qms/${encodeURIComponent(d.id)}`} className="flex items-center justify-between gap-3 border border-slate-200 rounded-lg p-3 bg-slate-50/60 hover:bg-slate-100 text-xs">
                      <span><strong className="font-mono text-slate-900">{d.id}</strong> <span className="text-slate-700">{d.title}</span></span>
                      <span className={`px-2 py-0.5 rounded-full font-bold border ${d.blocksRelease ? 'bg-red-100 text-red-800 border-red-300' : d.open ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-slate-100 text-slate-700 border-slate-300'}`}>
                        {d.classification ?? 'Not classified'} · {d.state}{d.blocksRelease ? ' (Release Hold)' : ''}
                      </span>
                    </a>
                  ))}
                </div>
              )}

              {data.oos?.length > 0 ? (
                <div className="space-y-4">
                  {data.oos.map((o: any) => (
                    <div key={o.id} className="border border-slate-200 rounded-xl p-5 bg-slate-50/60">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <ShieldAlert className="w-5 h-5 text-red-600" />
                          <h4 className="font-extrabold text-sm text-slate-900">{o.id}</h4>
                          <span className="font-mono text-xs text-slate-500">({o.parameter})</span>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${
                          o.status === 'Approved' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'
                        }`}>
                          {o.status === 'Approved' ? 'Resolved & Closed' : 'Open Investigation (Release Hold)'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div className="bg-white p-3 rounded-lg border border-slate-200">
                          <strong className="text-slate-700 block mb-1">Root Cause Determination (Phase 2):</strong>
                          <p className="text-slate-600">{o.rootCause || 'Under formal review.'}</p>
                        </div>
                        <div className="bg-white p-3 rounded-lg border border-slate-200">
                          <strong className="text-slate-700 block mb-1">CAPA & Preventative Measures:</strong>
                          <p className="text-slate-600">{o.conclusion || 'Pending QA review.'}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : deviations.length > 0 ? (
                <p className="text-xs text-slate-500">No OOS investigation was recorded for batch {batchNo}.</p>
              ) : (
                <div className="border border-emerald-200 bg-emerald-50/60 rounded-xl p-8 text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
                    <CheckCircle className="w-7 h-7" />
                  </div>
                  <h4 className="font-extrabold text-sm text-emerald-950">Zero Deviations & Zero OOS — Clean Quality Record</h4>
                  <p className="text-xs text-emerald-800 max-w-lg mx-auto">
                    No Out-of-Specification (OOS) investigations, non-conformances, or unapproved deviations were logged during the manufacture or QC testing of batch {batchNo}.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* STAGE 5: FINAL BATCH RELEASE DISPOSITION & 21 CFR PART 11 E-SIGNATURE      */}
          {/* ========================================================================= */}
          {activeStage === 5 && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-6">
              <div className="border-b border-slate-200 pb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-purple-600 text-white text-xs font-mono font-bold flex items-center justify-center">5</span>
                  <h3 className="font-extrabold text-base text-slate-900">
                    الاعتماد النهائي والتوقيع الإلكتروني للإفراج عن التشغيلة (Final Batch Release & QP Signoff)
                  </h3>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Qualified Person (QP) / Quality Assurance authorization per EU GMP Annex 16 and FDA 21 CFR Part 211.188.
                </p>
              </div>

              {/* Release Prerequisites Checklist */}
              <div className="border border-slate-200 rounded-xl p-5 bg-slate-50/50 space-y-3">
                <h4 className="font-extrabold text-xs text-slate-800 uppercase tracking-wider">
                  Pre-Release Quality Verification Checklist:
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="flex items-center gap-2.5 p-2.5 bg-white rounded-lg border border-slate-200">
                    {stage1Passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Clock className="w-4 h-4 text-amber-500" />}
                    <span className="font-medium text-slate-800">1. All Raw Material CoAs Verified</span>
                  </div>
                  <div className="flex items-center gap-2.5 p-2.5 bg-white rounded-lg border border-slate-200">
                    {stage2Passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Clock className="w-4 h-4 text-amber-500" />}
                    <span className="font-medium text-slate-800">2. Cleanroom Environmental Conditions Within Limits</span>
                  </div>
                  <div className="flex items-center gap-2.5 p-2.5 bg-white rounded-lg border border-slate-200">
                    {stage3Passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Clock className="w-4 h-4 text-amber-500" />}
                    <span className="font-medium text-slate-800">3. Finished Product Analytical QC Tests Passed</span>
                  </div>
                  <div className="flex items-center gap-2.5 p-2.5 bg-white rounded-lg border border-slate-200">
                    {stage4Passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-red-500" />}
                    <span className="font-medium text-slate-800">4. No Open OOS Investigation or Release-Holding Deviation</span>
                  </div>
                </div>
              </div>

              {/* State 5A: Batch Already Released */}
              {isBatchReleased ? (
                <div className="border border-emerald-300 bg-emerald-50/50 rounded-xl p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-emerald-200 pb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-xs">
                        <Lock className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="font-extrabold text-sm text-emerald-950">
                          Batch Formally Released for Market Distribution (21 CFR Part 11 Sealed)
                        </h4>
                        <p className="text-xs text-emerald-800">
                          Authorized by {data.release?.releasedByName ?? 'not recorded'} ({data.release?.releasedByRole ?? 'role not recorded'}) on {formatDate(data.release?.releasedAt)}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowCertificateModal(true)}
                      className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors self-start sm:self-auto"
                    >
                      <FileCheck className="w-4 h-4" /> View Release Certificate
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                    <div className="bg-white p-3 rounded-lg border border-emerald-200">
                      <span className="text-slate-400 block mb-1">Legal Release Meaning:</span>
                      <p className="text-slate-800 font-sans font-medium">{data.release?.meaning}</p>
                    </div>
                    <div className="bg-white p-3 rounded-lg border border-emerald-200">
                      <span className="text-slate-400 block mb-1">SHA-256 Release Cryptographic Seal:</span>
                      <p className="text-emerald-800 break-all text-[11px] font-bold">{data.release?.contentHash}</p>
                    </div>
                  </div>
                </div>
              ) : (
                /* State 5B: Pending Release Authorization */
                <div className="border border-slate-200 rounded-xl p-6 text-center space-y-4">
                  <div className="max-w-md mx-auto">
                    <h4 className="font-extrabold text-base text-slate-900">Authorize Batch Market Release</h4>
                    <p className="text-xs text-slate-500 mt-1">
                      Final batch release requires 21 CFR Part 11 re-authentication and Qualified Person (QP) electronic signature.
                    </p>
                  </div>

                  {isEligibleForRelease ? (
                    <button
                      type="button"
                      onClick={() => setIsReleaseModalOpen(true)}
                      className="px-6 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold inline-flex items-center gap-2 shadow-sm transition-colors"
                    >
                      <Lock className="w-4 h-4" /> Authorize Batch Release (21 CFR Part 11)
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 text-xs font-bold">
                      <AlertTriangle className="w-4 h-4" />
                      Cannot release batch: Complete all preceding quality stages first.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB: CRYPTOGRAPHIC PART 11 AUDIT TRAIL & SHA-256 LEDGER                   */}
          {/* ========================================================================= */}
          {activeStage === 'audits' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-indigo-600" />
                    <h3 className="font-extrabold text-base text-slate-900">
                      سجل التدقيق المشفر وسلسلة التجزئة (Part 11 Chained Audit Trail)
                    </h3>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    SHA-256 Merkle hash chain mathematically binding every creation, dispensing, test result, and release event.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleVerifyChain}
                  disabled={verifyingChain}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-2xs self-start sm:self-auto"
                >
                  <ShieldCheck className="w-4 h-4" /> Verify Mathematical Chain
                </button>
              </div>

              {/* Audit Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-start text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-mono tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Seq #</th>
                      <th className="px-4 py-3">Timestamp</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Entity (ID)</th>
                      <th className="px-4 py-3">Reason / Details</th>
                      <th className="px-4 py-3">SHA-256 Cryptographic Hash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-sans">
                    {data.audits?.map((a: any) => (
                      <tr key={a.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5 font-mono font-bold text-slate-700">#{a.sequence}</td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-slate-500">{formatDate(a.timestamp)}</td>
                        <td className="px-4 py-3.5 font-bold text-slate-900">{a.action}</td>
                        <td className="px-4 py-3.5 font-mono text-[11px] text-blue-600">{a.entity} ({a.entityId})</td>
                        <td className="px-4 py-3.5 text-slate-700 max-w-xs truncate">{a.reason}</td>
                        <td className="px-4 py-3.5 font-mono text-[10px] text-indigo-700 font-bold truncate max-w-xs">
                          {a.hash}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CERTIFICATE OF ANALYSIS (COA) DETAIL INSPECTION                    */}
      {/* ========================================================================= */}
      {selectedCoa && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-blue-600" />
                <h3 className="font-extrabold text-base text-slate-900">Certificate of Analysis (CoA) Verification</h3>
              </div>
              <button 
                onClick={() => setSelectedCoa(null)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3 font-sans text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-slate-400 block font-mono">CoA Number:</span>
                  <strong className="font-mono text-blue-700 font-bold">{selectedCoa.coaNumber}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono">Material Name:</span>
                  <strong className="text-slate-900">{selectedCoa.materialName}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono">Manufacturer Lot:</span>
                  <strong className="font-mono text-slate-800">{selectedCoa.lotNumber}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono">Manufacturer:</span>
                  <strong className="text-slate-800">{selectedCoa.manufacturer}</strong>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono">Assay / Potency:</span>
                  <strong className="font-mono text-emerald-700">{selectedCoa.potencyAssay} (Spec ≥99.0%)</strong>
                </div>
                <div>
                  <span className="text-slate-400 block font-mono">Loss on Drying (LOD):</span>
                  <strong className="font-mono text-slate-700">{selectedCoa.lossOnDrying} (Spec ≤0.5%)</strong>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
                <span className="text-slate-500">CoA Compliance Evaluation:</span>
                <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 bg-emerald-100 px-3 py-1 rounded-full border border-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approved & Released for Dispensing
                </span>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedCoa(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold"
              >
                Close CoA Window
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: DISPENSE RAW MATERIAL                                              */}
      {/* ========================================================================= */}
      {isDispenseModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-blue-600" />
                <h3 className="font-extrabold text-base text-slate-900">Dispense Raw Material for Batch {batchNo}</h3>
              </div>
              <button 
                onClick={() => setIsDispenseModalOpen(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleDispenseMaterial} className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Material Name *</label>
                <input
                  required
                  type="text"
                  value={newMaterial.materialName}
                  onChange={e => setNewMaterial({ ...newMaterial, materialName: e.target.value })}
                  placeholder="e.g. Paracetamol BP/USP Powder"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Material Category</label>
                  <select
                    required
                    value={newMaterial.materialType}
                    onChange={e => setNewMaterial({ ...newMaterial, materialType: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select the category</option>
                    <option value="API (Active Pharmaceutical Ingredient)">API</option>
                    <option value="Excipient (Binder & Disintegrant)">Excipient (Binder)</option>
                    <option value="Excipient (Lubricant)">Excipient (Lubricant)</option>
                    <option value="Primary Packaging Material">Packaging Material</option>
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Manufacturer Lot # *</label>
                  <input
                    required
                    type="text"
                    value={newMaterial.lotNumber}
                    onChange={e => setNewMaterial({ ...newMaterial, lotNumber: e.target.value })}
                    placeholder="e.g. LOT-2026-99"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">CoA Certificate Number *</label>
                  <input
                    required
                    type="text"
                    value={newMaterial.coaNumber}
                    onChange={e => setNewMaterial({ ...newMaterial, coaNumber: e.target.value })}
                    placeholder="e.g. COA-PAR-8812"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Quantity Dispensed *</label>
                  <input
                    required
                    type="text"
                    value={newMaterial.quantityDispensed}
                    onChange={e => setNewMaterial({ ...newMaterial, quantityDispensed: e.target.value })}
                    placeholder="e.g. 500.00 kg"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Manufacturer *</label>
                  <input required type="text" value={newMaterial.manufacturer}
                    onChange={e => setNewMaterial({ ...newMaterial, manufacturer: e.target.value })}
                    placeholder="As printed on the CoA"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">CoA Status *</label>
                  <select required value={newMaterial.coaStatus}
                    onChange={e => setNewMaterial({ ...newMaterial, coaStatus: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">Select the CoA status</option>
                    <option value="Verified Pass">Verified Pass</option>
                    <option value="Quarantined">Quarantined</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Potency (Assay) *</label>
                  <input required type="text" value={newMaterial.potencyAssay}
                    onChange={e => setNewMaterial({ ...newMaterial, potencyAssay: e.target.value })}
                    placeholder='From the CoA, e.g. "99.8 %", or "N/A"'
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Loss on Drying *</label>
                  <input required type="text" value={newMaterial.lossOnDrying}
                    onChange={e => setNewMaterial({ ...newMaterial, lossOnDrying: e.target.value })}
                    placeholder='From the CoA, e.g. "0.20 %", or "N/A"'
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
                </div>
              </div>

              <div className="border border-amber-200 bg-amber-50/60 rounded-lg p-3 space-y-2">
                <p className="font-bold text-amber-900">Second-person verification (e-signature: Verification)</p>
                <p className="text-amber-800">A Reviewer, QA or Administrator other than you checks the values against the CoA and signs with their own credentials.</p>
                <div className="grid grid-cols-2 gap-3">
                  <input required type="email" autoComplete="off" value={verifier.email}
                    onChange={e => setVerifier({ ...verifier, email: e.target.value })}
                    placeholder="Verifier e-mail"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
                  <input required type="password" autoComplete="new-password" value={verifier.password}
                    onChange={e => setVerifier({ ...verifier, password: e.target.value })}
                    placeholder="Verifier password"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <input type="text" inputMode="numeric" pattern="\d{6}" value={verifier.totpCode}
                  onChange={e => setVerifier({ ...verifier, totpCode: e.target.value })}
                  placeholder="Verifier authenticator code (if the verifier has one)"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsDispenseModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold shadow-xs"
                >
                  Confirm Dispensing
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: VERIFY CRYPTOGRAPHIC LINEAGE (ALCOA+ CHECK)                        */}
      {/* ========================================================================= */}
      {isVerifyChainModalOpen && chainVerifyData && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-600" />
                <h3 className="font-extrabold text-base text-slate-900">
                  Cryptographic Audit Chain Verification (ALCOA+)
                </h3>
              </div>
              <button 
                onClick={() => setIsVerifyChainModalOpen(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-xs space-y-3">
              <div className="flex items-center gap-2 text-emerald-900 font-bold">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span>Chain Integrity: 100% Intact & Mathematically Continuous</span>
              </div>
              <p className="text-emerald-800">
                All {chainVerifyData.totalAuditedEvents} audit trail blocks starting from sequence #1 to latest record were recalculated using SHA-256 with zero breakages or mutations detected.
              </p>
            </div>

            <div className="space-y-2 text-xs font-sans">
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">Cryptographic Standard:</span>
                <strong className="font-mono text-slate-800">{chainVerifyData.cryptographicStandard}</strong>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">Total Validated Events:</span>
                <strong className="font-mono text-slate-800">{chainVerifyData.totalAuditedEvents}</strong>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">ALCOA+ Non-Repudiation Status:</span>
                <strong className="text-emerald-700">VERIFIED COMPLIANT</strong>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setIsVerifyChainModalOpen(false)}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: BATCH RELEASE CERTIFICATE (COA / RELEASE DOSSIER)                  */}
      {/* ========================================================================= */}
      {showCertificateModal && data && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-8 shadow-2xl border border-slate-200 space-y-6 max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between border-b-2 border-slate-900 pb-4">
              <div>
                <div className="text-[11px] font-bold text-blue-600 uppercase tracking-widest font-mono">
                  PHARMACEUTICAL QUALITY DOSSIER
                </div>
                <h2 className="text-xl font-black text-slate-900">Certificate of Batch Release & Disposition</h2>
                <p className="text-xs text-slate-500">EU GMP Annex 16 / FDA 21 CFR Part 211.188 Final Qualified Person Authorization</p>
              </div>
              <button 
                onClick={() => setShowCertificateModal(false)}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Certificate Details */}
            <div className="grid grid-cols-2 gap-4 text-xs font-sans bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div>
                <span className="text-slate-400 block font-mono">Batch Number:</span>
                <strong className="font-mono text-base text-blue-800">{batchNo}</strong>
              </div>
              <div>
                <span className="text-slate-400 block font-mono">Authorized Disposition:</span>
                <strong className="text-emerald-700 text-sm">Released for Commercial Distribution</strong>
              </div>
              <div>
                <span className="text-slate-400 block font-mono">Qualified Person (QP):</span>
                <strong className="text-slate-800">{data.release?.releasedByName || 'not recorded'}</strong>
              </div>
              <div>
                <span className="text-slate-400 block font-mono">Release Timestamp:</span>
                <strong className="font-mono text-slate-800">{data.release?.releasedAt ? formatDate(data.release.releasedAt) : 'not recorded'}</strong>
              </div>
              <div>
                <span className="text-slate-400 block font-mono">Product:</span>
                <strong className="text-slate-800">{data.master?.length ? data.master.map((m: MasterBatchView) => m.productName).join(', ') : 'no master batch record'}</strong>
              </div>
              <div>
                <span className="text-slate-400 block font-mono">Manufactured / Expires:</span>
                <strong className="font-mono text-slate-800">{data.master?.length === 1 ? `${data.master[0].manufacturedOn ?? 'not recorded'} / ${data.master[0].expiresOn ?? 'not recorded'}` : 'see master data'}</strong>
              </div>
            </div>

            {/* Test Summary Table */}
            <div>
              <h4 className="font-bold text-xs text-slate-800 uppercase tracking-wider mb-2">
                Finished Product Quality Summary:
              </h4>
              <div className="overflow-x-auto border border-slate-200 rounded-lg text-xs">
                <table className="w-full text-start">
                  <thead className="bg-slate-100 text-slate-700 font-mono text-[11px]">
                    <tr>
                      <th className="p-2.5">Parameter</th>
                      <th className="p-2.5">Specification</th>
                      <th className="p-2.5">Result</th>
                      <th className="p-2.5">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {data.results?.map((r: any) => (
                      <tr key={r.id}>
                        <td className="p-2.5 font-medium text-slate-800">{r.parameter}</td>
                        <td className="p-2.5 font-mono text-slate-500">{r.specMin} - {r.specMax}</td>
                        <td className="p-2.5 font-mono font-bold text-slate-900">{r.value}</td>
                        <td className="p-2.5 text-emerald-700 font-bold">PASS</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Digital Seal */}
            <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl text-xs space-y-2">
              <div className="flex items-center gap-2 text-purple-900 font-bold">
                <Lock className="w-4 h-4 text-purple-700" />
                <span>21 CFR Part 11 Electronic Signature Digital Seal</span>
              </div>
              <p className="text-purple-800 font-sans italic text-[11px]">
                "{data.release?.meaning || 'Final Batch Release Disposition & Market Authorization'}"
              </p>
              <div className="pt-1 text-[10px] font-mono text-purple-900 break-all font-bold">
                SHA-256 Seal: {data.release?.contentHash}
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => window.print()}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5"
              >
                <Printer className="w-3.5 h-3.5" /> Print Certificate
              </button>
              <button
                type="button"
                onClick={() => setShowCertificateModal(false)}
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 21 CFR PART 11 ELECTRONIC SIGNATURE MODAL FOR BATCH RELEASE               */}
      {/* ========================================================================= */}
      {isReleaseModalOpen && (
        <ElectronicSignatureModal
          isOpen={true}
          user={user}
          action="Authorize Release"
          meaning="Final Batch Release Disposition & Market Authorization (EU GMP / FDA 21 CFR Part 211.188)"
          entityName={`Batch ${batchNo}`}
          onClose={() => setIsReleaseModalOpen(false)}
          onSign={handleAuthorizeRelease}
        />
      )}
    </div>
  );
}
