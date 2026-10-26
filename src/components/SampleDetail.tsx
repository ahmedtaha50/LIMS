import { formatDateTime } from '../lib/format';
import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';
import { ArrowLeft, Lock, Check, X, ShieldAlert, DownloadCloud, BookOpen, Copy, Save, ShieldCheck, Fingerprint } from 'lucide-react';
import { formatDate } from '../lib/utils';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { SignatureVerdict } from './SignatureBlock';
import { RecordHistory } from './RecordHistory';
import { RESULT_ENTRY_ROLES } from '../lib/constants/results';
import { apiFetch, errorMessage } from '../lib/api';
import { ResultGrid, type ResultRow } from './ResultGrid';
import { AttachmentPanel } from './AttachmentPanel';
import { ReviewChecklist } from './ReviewChecklist';
import { CoaPanel } from './CoaPanel';
import { SampleMaterialsPanel } from './Reagents';
import { CustodyPanel } from './Custody';

// The result row, its limit text and the server's evaluation live with the result grid (roadmap M19); re-exported for older importers.
export { formatResultLimit, ResultEvaluation, type ResultRow } from './ResultGrid';

/** The certification line of the Certificate of Analysis. ALL TESTS PASSED only when every result is entered and none is OOS. */
export function coaCertification(results: readonly ResultRow[]): { pass: boolean; text: string } {
  if (results.some(r => r.isOos)) return { pass: false, text: 'CERTIFICATION OF RESULTS: CONTAINS OOS RESULTS' };
  if (results.length === 0 || results.some(r => r.value === null || r.value === undefined || r.value === '')) {
    return { pass: false, text: 'CERTIFICATION OF RESULTS: INCOMPLETE - NOT ALL RESULTS ENTERED' };
  }
  return { pass: true, text: 'CERTIFICATION OF RESULTS: ALL TESTS PASSED' };
}

export function SampleDetail({ sampleId, token, user, onBack }: { sampleId: string, token: string, user: any, onBack: () => void }) {
  const [data, setData] = useState<{ sample: any, results: any[], notebook?: any[], signatures?: any[], oos?: any[] } | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [isSigningNote, setIsSigningNote] = useState(false);
  const [instruments, setInstruments] = useState<any[]>([]);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  
  const [sigAction, setSigAction] = useState<{ action: string, meaning: string, meaningCode: string } | null>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [newTemplateTitle, setNewTemplateTitle] = useState('');
  
  const [verifyingSig, setVerifyingSig] = useState<any | null>(null);
  const [sigVerificationData, setSigVerificationData] = useState<any | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const { toast } = useToast();

  
  const handleGenerateReport = async () => {
    setIsGeneratingPdf(true);
    toast('Queuing PDF generation...', 'success');
    try {
      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sampleId })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to generate report (HTTP ${res.status})`);
      }
      const { jobId } = await res.json();
      
      // Poll for status
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/reports/status/${jobId}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const statusData = await statusRes.json();
          if (statusData.status === 'completed') {
            clearInterval(interval);
            setIsGeneratingPdf(false);
            toast('Report generated successfully!', 'success');
            
            // Download the base64 string as a PDF
            const link = document.createElement('a');
            link.href = statusData.result;
            link.download = `CoA-${sampleId}.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          } else if (statusData.status === 'failed') {
            clearInterval(interval);
            setIsGeneratingPdf(false);
            toast('Failed to generate report: ' + statusData.error, 'error');
          }
        } catch(e) {
          clearInterval(interval);
          setIsGeneratingPdf(false);
        }
      }, 2000);
    } catch (e: any) {
      toast(e.message, 'error');
      setIsGeneratingPdf(false);
    }
  };

  
  const handleAddNote = async (password: string) => {
    try {
      const res = await fetch(`/api/samples/${sampleId}/notebook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: noteContent, password })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to add observation');
      }
      toast('Observation signed and added to Lab Notebook', 'success');
      setNoteContent('');
      setIsSigningNote(false);
      loadData();
    } catch (e: any) {
      toast(e.message, 'error');
      throw e; // Allows ElectronicSignatureModal to catch and show in-modal error!
    }
  };

  const loadData = async () => {
    try {
      const res = await fetch(`/api/samples/${sampleId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Not found');
      setData(await res.json());
    } catch {
      toast('Failed to load sample details', 'error');
      onBack();
    }
  };

  useEffect(() => { loadData(); loadTemplates(); loadInstruments(); }, [sampleId]);

  const loadInstruments = async () => {
    try {
      const res = await fetch('/api/instruments', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Instruments could not be loaded (HTTP ${res.status})`);
      setInstruments(await res.json());
    } catch (e: any) {
      toast(e.message || 'Instruments could not be loaded', 'error');
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/notebook-templates', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setTemplates(await res.json());
    } catch (e) {
      console.error('Failed to load templates');
    }
  };

  const handleSaveTemplate = async () => {
    if (!newTemplateTitle.trim() || !noteContent.trim()) {
      toast('Title and content are required', 'error');
      return;
    }
    try {
      const res = await fetch('/api/notebook-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: newTemplateTitle, content: noteContent })
      });
      if (res.ok) {
        toast('Template saved', 'success');
        setNewTemplateTitle('');
        loadTemplates();
      } else {
        throw new Error('Failed to save template');
      }
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };


  /** "Open investigation" on an OOS row that has none open (POST /oos: the parameter and the date are the server's). */
  const handleOpenInvestigation = async (row: ResultRow) => {
    try {
      const opened = await apiFetch<{ id: string }>('/oos', { method: 'POST', body: { sampleId, resultId: row.id } });
      toast.success(`Investigation ${opened.id} opened for ${row.parameter}.`);
      await loadData();
    } catch (e) {
      toast.error(errorMessage(e, `The investigation for ${row.parameter} could not be opened.`));
    }
  };

  const handleTransition = async (action: string, password?: string, reason?: string, totpCode?: string) => {
    try {
      const payload = {
        action,
        expectedVersion: data?.sample.version,
        password,
        reason: reason || undefined,
        totpCode: totpCode || undefined
      };
      const res = await fetch(`/api/samples/${sampleId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      toast(`State transitioned successfully`, 'success');
      setSigAction(null);
      loadData();
    } catch (e: any) {
      toast(e.message, 'error');
      throw e; // Rethrow to display inside ElectronicSignatureModal!
    }
  };

  const handleVerifySignature = async (sig: any) => {
    setVerifyingSig(sig);
    setIsVerifying(true);
    try {
      const res = await fetch(`/api/signatures/verify/${sig.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Verification failed');
      const result = await res.json();
      setSigVerificationData(result);
    } catch (e: any) {
      toast(e.message || 'Signature verification failed', 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  if (!data) return <div className="p-8">Loading...</div>;

  const { sample, results } = data;
  const isLocked = sample.state === 'Approved' || sample.state === 'Rejected';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="p-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
          <ArrowLeft className="rtl:-scale-x-100 w-5 h-5 text-slate-600" />
        </button>
        <h2 className="text-2xl font-bold text-slate-900">{sample.id}</h2>
        <span className="px-3 py-1 bg-slate-900 text-white text-xs font-semibold rounded-full uppercase tracking-wider ms-auto">
          {sample.state}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Sample Details</h3>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-slate-500 font-medium">Material</dt>
              <dd className="text-slate-900 font-semibold">{sample.material}</dd>
            </div>
            <div>
              <dt className="text-slate-500 font-medium">Batch</dt>
              <dd className="text-slate-900 font-mono">{sample.batch}</dd>
            </div>
            <div>
              <dt className="text-slate-500 font-medium">Logged By</dt>
              <dd className="text-slate-900">{sample.createdBy}</dd>
            </div>
            <div>
              <dt className="text-slate-500 font-medium">Logged On</dt>
              <dd className="text-slate-900">{formatDate(sample.createdAt)}</dd>
            </div>
          </dl>

          {/* Workflow Actions */}
          <div className="mt-8 pt-6 border-t border-slate-200 space-y-3">
            {sample.state === 'Logged' && ['Analyst', 'Admin'].includes(user.role) && (
              <button onClick={() => handleTransition('submit')} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-medium transition-colors">
                Begin Testing
              </button>
            )}
            {sample.state === 'Testing' && ['Analyst', 'Admin'].includes(user.role) && (
              <button onClick={() => setSigAction({ action: 'review', meaning: 'Review & Verification of Analytical Results', meaningCode: 'SUBMIT_FOR_REVIEW' })} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-medium transition-colors">
                Submit for Review
              </button>
            )}
            {sample.state === 'Pending Review' && ['QA', 'Admin', 'Reviewer'].includes(user.role) && (
              <>
                <button onClick={() => setSigAction({ action: 'approve', meaning: 'Approval (Release Disposition)', meaningCode: 'APPROVAL' })} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" /> Approve Disposition
                </button>
                <button onClick={() => setSigAction({ action: 'reject', meaning: 'Rejection (Return / Quarantine)', meaningCode: 'REJECTION' })} className="w-full bg-red-50 text-red-700 border border-red-200 py-2 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors flex items-center justify-center gap-2">
                  <ShieldAlert className="w-4 h-4" /> Reject & Return
                </button>
              </>
            )}
          </div>
        </div>

        <div className="md:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Test Results</h3>
            {isLocked && <div className="flex items-center gap-2 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded border border-amber-200"><Lock className="w-3 h-3"/> Record Locked</div>}
          </div>
          
          <div className="flex-1">
            {/* The bench workbench (roadmap M19): every parameter in one grid, saved together; the server evaluates and audits each value. */}
            <ResultGrid
              sampleId={sample.id}
              rows={results}
              instruments={instruments}
              investigations={data.oos ?? []}
              editable={sample.state === 'Testing' && RESULT_ENTRY_ROLES.includes(user.role)}
              onReload={loadData}
              onOpenInvestigation={handleOpenInvestigation}
            />
          </div>
        </div>
      </div>
      {/* Reagent lots, standards and solutions used for each result (r2-reagents, roadmap M30): expired, quarantined and rejected
          material is offered disabled with the server's reason; the result guard refuses a save while a linked lot may not be used. */}
      <SampleMaterialsPanel sampleId={sample.id} results={results.map((r: any) => ({ id: r.id, parameter: r.parameter }))}
        editable={sample.state === 'Testing' && RESULT_ENTRY_ROLES.includes(user.role)} onChanged={loadData} />

      {/* Custody (r2-custody-labels, roadmap M29): receipt and its deviation, containers and aliquots, ledger, retains, labels. */}
      <div className="mt-6"><CustodyPanel sampleId={sample.id} user={user} token={token} onChanged={loadData} /></div>
      {/* Raw data and review (r2-raw-data, roadmap M20): files kept by sha256, the result history and the server-evaluated checklist. */}
      <AttachmentPanel sampleId={sample.id} results={results.map((r: any) => ({ id: r.id, parameter: r.parameter }))}
        canUpload={['Logged', 'Testing'].includes(sample.state) && ['Analyst', 'Admin'].includes(user.role)} onChanged={loadData} />
      {/* The Certificate of Analysis (r2-coa-reports, roadmap M25): issued, numbered and signed on the server; never composed here. */}
      {(sample.state === 'Approved' || sample.state === 'Rejected') && <CoaPanel sampleId={sample.id} token={token} />}
      {sample.state !== 'Logged' && (
        <ReviewChecklist refreshKey={`${sample.version}:${results.map((r: any) => r.version).join('.')}`} sampleId={sample.id} user={user} token={token} onChanged={loadData} />
      )}


      {/* Lab Notebook Section */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-6">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-indigo-600" />
          <h3 className="font-bold text-slate-800">Lab Notebook (Chronological Observations)</h3>
        </div>
        
        <div className="p-6 bg-slate-50/50">
          {data.notebook && data.notebook.length > 0 ? (
            <div className="space-y-4 mb-6">
              {data.notebook.map((note: any) => (
                <div key={note.id} className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm relative">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">
                    <span className="text-indigo-600 font-bold">{note.enteredBy}</span>
                    <span>•</span>
                    <span>{formatDateTime(note.enteredAt)}</span>
                    <span>•</span>
                    <span className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100"><Check className="w-3 h-3"/> E-Signed</span>
                  </div>
                  <p className="text-slate-800 text-sm whitespace-pre-wrap font-mono leading-relaxed">{note.content}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-slate-500 text-sm italic">
              No observations recorded yet.
            </div>
          )}

          {!isLocked && ['Analyst', 'Admin'].includes(user.role) && (
            <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex justify-between items-center mb-2">
                <label className="block text-sm font-bold text-slate-700">New Observation</label>
                <button onClick={() => setIsTemplateModalOpen(true)} className="text-sm flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-semibold bg-indigo-50 px-3 py-1 rounded">
                  <Copy className="w-3.5 h-3.5" /> Template Library
                </button>
              </div>
              
              {isTemplateModalOpen && (
                <div className="mb-4 p-4 border border-slate-200 rounded-lg bg-slate-50">
                  <div className="flex justify-between items-center mb-3">
                    <h4 className="font-bold text-slate-700">Notebook Templates</h4>
                    <button onClick={() => setIsTemplateModalOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                  </div>
                  
                  {templates.length > 0 ? (
                    <div className="space-y-2 mb-4 max-h-40 overflow-y-auto">
                      {templates.map(tpl => (
                        <div key={tpl.id} className="flex justify-between items-center bg-white p-2 border border-slate-200 rounded shadow-sm hover:border-indigo-300">
                          <span className="text-sm font-medium text-slate-700 truncate me-2">{tpl.title}</span>
                          <button 
                            onClick={() => { setNoteContent(tpl.content); setIsTemplateModalOpen(false); toast('Template loaded', 'success'); }}
                            className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded font-bold hover:bg-indigo-200"
                          >
                            Use
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 italic mb-4">No templates found.</p>
                  )}
                  
                  <div className="pt-3 border-t border-slate-200">
                    <p className="text-xs font-semibold text-slate-500 mb-2 uppercase">Save Current as Template</p>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        placeholder="Template Title" 
                        value={newTemplateTitle} 
                        onChange={e => setNewTemplateTitle(e.target.value)} 
                        className="flex-1 px-3 py-1.5 border border-slate-300 rounded text-sm"
                      />
                      <button 
                        onClick={handleSaveTemplate}
                        disabled={!noteContent.trim() || !newTemplateTitle.trim()}
                        className="bg-emerald-600 text-white px-3 py-1.5 rounded text-sm font-bold flex items-center gap-1 hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" /> Save
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <textarea 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 min-h-[100px] resize-y text-sm font-mono"
                placeholder="Log analytical steps, visual observations, or deviations during testing..."
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
              />
              <div className="flex justify-end mt-3">
                <button 
                  onClick={() => setIsSigningNote(true)}
                  disabled={noteContent.trim().length === 0}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  <Lock className="w-4 h-4" /> Sign & Save Observation
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 21 CFR Part 11 Electronic Signatures Log */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-6">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="font-bold text-slate-800 text-sm">21 CFR Part 11 Electronic Signature Vault</h3>
              <p className="text-xs text-slate-500">Immutable, cryptographically chained records & audit links</p>
            </div>
          </div>
          <span className="text-xs font-mono bg-blue-50 text-blue-700 px-2.5 py-1 rounded border border-blue-200 font-semibold">
            {data?.signatures?.length || 0} Signed Events
          </span>
        </div>

        <div className="p-6">
          {data?.signatures && data.signatures.length > 0 ? (
            <div className="space-y-4">
              {data.signatures.map((sig: any) => (
                <div key={sig.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-slate-50 transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-200/80">
                    <div className="flex items-center gap-2">
                      <span className="p-1.5 bg-emerald-100 text-emerald-800 rounded-lg">
                        <ShieldCheck className="w-4 h-4" />
                      </span>
                      <div>
                        <span className="text-sm font-bold text-slate-900">{sig.printedName || sig.signerId}</span>
                        <span className="text-xs text-slate-500 ms-2">({sig.signerRole || 'Authorized Signer'})</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-800 text-xs font-semibold rounded border border-blue-200">
                        {sig.meaning}
                      </span>
                      <button
                        onClick={() => handleVerifySignature(sig)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-medium transition-colors flex items-center gap-1 shadow-xs"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                        <span>Verify Seal</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-600 mt-3">
                    <div>
                      <span className="text-slate-400 block">Execution Timestamp:</span>
                      <span className="font-medium text-slate-800">{formatDateTime(sig.timestamp)}</span>
                      <span className="text-[10px] text-slate-400 font-mono block">{new Date(sig.timestamp).toISOString()}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Bound Record Version:</span>
                      <span className="font-mono font-semibold text-slate-800">Version #{sig.recordVersion}</span>
                      <span className="text-[10px] text-slate-400 block">Audit Ref: {sig.auditEntryId}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Cryptographic Hash (SHA-256):</span>
                      <span className="font-mono text-[11px] text-slate-600 truncate block max-w-full" title={sig.contentHash}>
                        {sig.contentHash}
                      </span>
                    </div>
                  </div>

                  {sig.reason && (
                    <div className="mt-2.5 pt-2 border-t border-slate-100 text-xs">
                      <span className="font-semibold text-slate-500">Reason / Remark: </span>
                      <span className="text-slate-700 italic">"{sig.reason}"</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-slate-500 text-sm italic">
              No formal electronic signatures executed on this sample yet.
            </div>
          )}
        </div>
      </div>

      {/* History tab (r1-audit's RecordHistory): Admin, QA and Reviewer read the audit trail of the sample and its results. */}
      {['Admin', 'QA', 'Reviewer'].includes(user.role) && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 mt-6">
          <RecordHistory token={token} entity="Sample" entityId={sample.id} related={results.map((r: any) => ({ entity: 'Result', entityId: r.id }))} />
        </div>
      )}

      {isSigningNote && (
        <ElectronicSignatureModal 
          user={user} 
          action="sign_note"
          meaning="Authorship & Integrity of Analytical Observations (21 CFR Part 11)"
          entityName={`Lab Observation: Sample ${sampleId}`}
          recordVersion={sample.version}
          onClose={() => setIsSigningNote(false)}
          onSign={async (pwd) => {
            await handleAddNote(pwd);
          }}
        />
      )}

      {sigAction && (
        <ElectronicSignatureModal 
          user={user} 
          action={sigAction.action}
          meaning={sigAction.meaning}
          meaningCode={sigAction.meaningCode}
          token={token}
          entityName={`Sample: ${sample.id} (${sample.material} - Batch: ${sample.batch})`}
          recordVersion={sample.version}
          requiresReason={sigAction.action === 'reject'}
          defaultReason={sigAction.action === 'reject' ? 'Out-of-specification or analytical deviation noted upon review.' : ''}
          onClose={() => setSigAction(null)}
          onSign={async (pwd, reason, totpCode) => {
            await handleTransition(sigAction.action, pwd, reason, totpCode);
          }}
        />
      )}

      {/* Signature Verification Certificate Modal */}
      {verifyingSig && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm">21 CFR Part 11 Cryptographic Verification</h3>
              </div>
              <button 
                onClick={() => { setVerifyingSig(null); setSigVerificationData(null); }} 
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              {isVerifying ? (
                <div className="py-8 text-center text-slate-500 space-y-2">
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-xs">Verifying cryptographic hash chain integrity...</p>
                </div>
              ) : sigVerificationData ? (
                <>
                  <SignatureVerdict result={sigVerificationData} />

                  <div className="space-y-2 text-xs">
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Signer:</span>
                        <span className="font-bold text-slate-800">{sigVerificationData.signature.signerName} ({sigVerificationData.signature.signerRole})</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Meaning:</span>
                        <span className="font-semibold text-blue-700">{sigVerificationData.signature.meaning}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Timestamp:</span>
                        <span className="font-mono text-slate-700">{new Date(sigVerificationData.signature.timestamp).toISOString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Record Version:</span>
                        <span className="font-mono text-slate-700">v{sigVerificationData.signature.recordVersion}</span>
                      </div>
                    </div>

                    {/* Shown only for a signature that verified: the claims below are true only then. */}
                    {sigVerificationData.valid === true && (
                    <div className="p-3 bg-blue-50/60 border border-blue-100 rounded-lg text-[11px] space-y-1">
                      <div className="font-bold text-blue-900 mb-1">ALCOA+ Regulatory Compliance Assessment:</div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Attributable: Signer verified
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Legible: Audit reference chained
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Contemporaneous: Server verified timestamp
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Original: Genesis audit sequence verified
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Accurate: Hash matches bit-for-bit
                      </div>
                    </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-center py-4 text-xs text-red-600">
                  Failed to load verification evidence.
                </div>
              )}

              <div className="pt-2">
                <button
                  onClick={() => { setVerifyingSig(null); setSigVerificationData(null); }}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs rounded-lg transition-colors"
                >
                  Close Verification Report
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
