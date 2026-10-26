import { formatDateTime } from '../lib/format';
import React, { useState, useEffect } from 'react';
import { useToast } from './ui/Toast';

import { ShieldAlert, Search, Filter, Microscope, User, FileText, Check, TrendingUp, BarChart2, Plus, Edit, Sparkles, BrainCircuit, Activity, AlertCircle, ChevronRight, ShieldCheck, Fingerprint, Lock, X } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { OOSInvestigation } from '../types';
import { formatDate } from '../lib/utils';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { SignatureVerdict } from './SignatureBlock';
import { OOS_PHASE_TRANSITIONS, isTerminalOosStatus, oosStage, type OosPhase } from '../lib/constants/oos';
import { OOS_RESULT_CHANGE_CODES } from '../lib/constants/results';
import { OOS_CLOSURE_DECISIONS, oosClosureProblems, phase2Reached, type OosClosureDecision } from '../lib/validations/oos';
import { VoiceRecorder } from './VoiceRecorder';

// ---- the OOS workflow (roadmap M26, r2-oos-workflow): due dates, tasks, assignable cause, retests, closure rule ---------------------

export interface OosTask { id: string; phase: string; title: string; status: string; finding: string | null; ownerId: string | null; dueDate: string | null; version: number; completedBy: string | null }
export interface OosRetestPlan { id: string; basis: string; justification: string; maxRetests: number; approvedBy: string; approvedAt: string }
export interface OosRetest { id: string; seq: number; value: string; isOos: boolean; analystId: string; recordedAt: string; reason: string }
export interface OosLinkedRecord { id: string; type?: string; title: string; state: string; classification?: string | null; relation: string }

/** GET /oos/:id. */
export interface OosDetail extends OOSInvestigation {
  dueDate: string | null;
  overdue: boolean;
  phase2StartedAt: string | null;
  assignableCauseCategory: string | null;
  assignableCause: string | null;
  assignableCauseBy: string | null;
  invalidatedBy: string | null;
  invalidatedAt: string | null;
  originalAnalystIds: string[];
  /** Everyone who has been the investigator (they may not sign its steps). */
  investigatorIds: string[];
  tasks: OosTask[];
  retestPlan: OosRetestPlan | null;
  retests: OosRetest[];
  deviations: OosLinkedRecord[];
  signatures?: Array<{ id: string; entityType: string; meaningCode: string; meaning: string; signerName: string | null; timestamp: string }>;
}

/** The due date of the current phase; Overdue only when the server says so. */
export function DueBadge({ dueDate, overdue }: { dueDate: string | null | undefined; overdue: boolean | undefined }) {
  if (!dueDate) return null;
  return overdue
    ? <span className="px-2 py-0.5 rounded-full text-xs font-semibold border bg-red-100 text-red-800 border-red-200">Overdue (due {dueDate})</span>
    : <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-100 text-slate-700 border-slate-200">Due {dueDate}</span>;
}

export function TaskList({ tasks, canEdit, onComplete }: { tasks: OosTask[]; canEdit: boolean; onComplete: (task: OosTask) => void }) {
  if (tasks.length === 0) return <p className="text-xs text-slate-500">No tasks yet. Apply a checklist or add a task.</p>;
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
      {tasks.map(t => (
        <li key={t.id} className="p-2.5 text-xs flex items-start justify-between gap-3">
          <div>
            <div className="font-medium text-slate-800">{t.title}</div>
            <div className="text-slate-500">{t.phase}{t.ownerId ? ` · ${t.ownerId}` : ''}{t.dueDate ? ` · due ${t.dueDate}` : ''}</div>
            {t.finding && <div className="mt-1 text-slate-700">Finding: {t.finding}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`px-2 py-0.5 rounded-full border ${t.status === 'Open' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>{t.status}</span>
            {canEdit && t.status === 'Open' && (
              <button type="button" onClick={() => onComplete(t)} className="px-2 py-0.5 bg-blue-600 text-white rounded">Complete</button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RetestSummary({ plan, retests }: { plan: OosRetestPlan | null; retests: OosRetest[] }) {
  if (!plan) return <p className="text-xs text-slate-500">No retest is authorised. QA signs a retest plan after confirming an assignable cause, or under the Phase II protocol.</p>;
  return (
    <div className="text-xs space-y-2">
      <div className="text-slate-700">
        <span className="font-semibold">{retests.length} of {plan.maxRetests} retests</span> · basis: {plan.basis} · authorised by {plan.approvedBy}
      </div>
      <div className="text-slate-500">Justification: {plan.justification}</div>
      {retests.length > 0 && (
        <ul className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {retests.map(r => (
            <li key={r.id} className="p-2 flex justify-between">
              <span>Retest {r.seq}: <span className="font-mono">{r.value}</span> by {r.analystId}</span>
              <span className={r.isOos ? 'text-red-700 font-semibold' : 'text-emerald-700 font-semibold'}>{r.isOos ? 'OOS' : 'Within specification'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The reasons the closure with `decision` would be refused for `signerId` (the server applies the same rule). */
export function closureProblems(detail: OosDetail, decision: OosClosureDecision, signerId: string): string[] {
  return oosClosureProblems(detail, decision, signerId).map(p => p.message);
}

/** The AI checklist: an optional suggestion, labelled as such. Nothing of it reaches the record unless the person copies it into the draft. */
export function AiSuggestionPanel({ result, onUse, onDismiss }: { result: any; onUse: () => void; onDismiss: () => void }) {
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-xl p-4 space-y-2">
      <div className="text-xs font-bold text-amber-900 uppercase tracking-wider">AI suggestion: not part of the record</div>
      <p className="text-xs text-amber-900">Generated by the AI assistant from the parameter and the notes. It is not an investigation finding. Review it, and record only what the investigation shows.</p>
      {result?.rootCauseConclusion && <p className="text-sm text-slate-800"><span className="font-semibold">Possible root cause:</span> {result.rootCauseConclusion}</p>}
      {(result?.correctiveActions?.length || result?.preventativeActions?.length) ? (
        <ul className="text-xs text-slate-700 list-disc ps-5">
          {(result.correctiveActions || []).map((a: string, i: number) => <li key={`c${i}`}>Corrective: {a}</li>)}
          {(result.preventativeActions || []).map((a: string, i: number) => <li key={`p${i}`}>Preventive: {a}</li>)}
        </ul>
      ) : null}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onDismiss} className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-700">Dismiss</button>
        <button type="button" onClick={onUse} className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold">Copy into the draft closure fields</button>
      </div>
    </div>
  );
}

const QA_ROLES = ['QA', 'Admin'];
const ENTRY_ROLES = ['Analyst', 'Admin'];

async function call<T = any>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

type PendingSign = { kind: 'confirm' } | { kind: 'plan'; justification: string; maxRetests: number };

/** The workflow of one investigation: due date, tasks, assignable cause and its confirmation, retest plan and retests, linked records. */
export function OosWorkflowPanel({ id, token, user, onClose, onChanged }: { id: string; token: string; user: any; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<OosDetail | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; title: string; phase: string; version: number; active: boolean }>>([]);
  const [templateId, setTemplateId] = useState('');
  const [newTask, setNewTask] = useState('');
  const [completing, setCompleting] = useState<{ task: OosTask; status: 'Done' | 'Not applicable'; finding: string } | null>(null);
  const [cause, setCause] = useState({ category: OOS_RESULT_CHANGE_CODES[0] as string, description: '' });
  const [planDraft, setPlanDraft] = useState({ justification: '', maxRetests: 1 });
  const [retestDraft, setRetestDraft] = useState({ value: '', reason: '' });
  const [signing, setSigning] = useState<PendingSign | null>(null);

  const load = async () => {
    try {
      setDetail(await call<OosDetail>(token, `/api/oos/${id}`));
      setTemplates(await call(token, '/api/oos/checklist-templates'));
    } catch (e: any) { toast(e.message || 'Failed to load the investigation', 'error'); }
  };
  useEffect(() => { load(); }, [id]);

  /** True when the step succeeded; on a refusal the server's message is shown and the caller keeps the draft for a correction. */
  const run = async (what: () => Promise<unknown>, done: string): Promise<boolean> => {
    try { await what(); toast(done, 'success'); await load(); onChanged(); return true; }
    catch (e: any) { toast(e.message, 'error'); return false; }
  };

  if (!detail) return null;
  const open = !isTerminalOosStatus(detail.status);
  const canApprove = QA_ROLES.includes(user?.role);
  const canEnter = ENTRY_ROLES.includes(user?.role);
  const inPhase1 = (detail.phase ?? 'Phase I') === 'Phase I';
  const usedRetests = detail.retests.length;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full overflow-hidden my-8" role="dialog" aria-label={`Investigation ${detail.id}`}>
        <div className="px-6 py-4 bg-slate-900 text-white flex justify-between items-center">
          <h3 className="font-semibold tracking-tight">Investigation {detail.id} · {detail.stage}</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-300 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto text-sm">
          <section className="flex flex-wrap items-center gap-3">
            <DueBadge dueDate={detail.dueDate} overdue={detail.overdue} />
            <span className="text-xs text-slate-600">Sample {detail.sampleId} · {detail.parameter} · investigator {detail.assignedTo || 'not assigned'} · original analyst {detail.originalAnalystIds.join(', ') || 'none recorded'}</span>
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Tasks</h4>
            <TaskList tasks={detail.tasks} canEdit={open} onComplete={task => setCompleting({ task, status: 'Done', finding: '' })} />
            {completing && (
              <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
                <div className="text-xs font-semibold">{completing.task.title}</div>
                <select className="px-2 py-1 border rounded text-xs" value={completing.status} onChange={e => setCompleting({ ...completing, status: e.target.value as any })}>
                  <option value="Done">Done</option><option value="Not applicable">Not applicable</option>
                </select>
                <textarea className="w-full px-2 py-1 border rounded text-xs h-16" placeholder="Finding: what was checked and what was found" value={completing.finding} onChange={e => setCompleting({ ...completing, finding: e.target.value })} />
                <div className="flex justify-end gap-2">
                  <button type="button" className="px-3 py-1 bg-white border rounded text-xs" onClick={() => setCompleting(null)}>Cancel</button>
                  <button type="button" className="px-3 py-1 bg-blue-600 text-white rounded text-xs" onClick={() => {
                    if (completing.finding.trim().length < 5) { toast('Record the finding (at least 5 characters) to complete the task.', 'error'); return; }
                    run(() => call(token, `/api/oos/${id}/tasks/${completing.task.id}`, 'PUT', { status: completing.status, finding: completing.finding, expectedVersion: completing.task.version }), 'Task completed')
                      .then(ok => { if (ok) setCompleting(null); });
                  }}>Save</button>
                </div>
              </div>
            )}
            {open && (
              <div className="flex flex-wrap gap-2 items-center">
                <select aria-label="Checklist" className="px-2 py-1 border rounded text-xs" value={templateId} onChange={e => setTemplateId(e.target.value)}>
                  <option value="">Apply a checklist...</option>
                  {templates.filter(t => t.active).map(t => <option key={t.id} value={t.id}>{t.title} (v{t.version})</option>)}
                </select>
                <button type="button" disabled={!templateId} className="px-3 py-1 bg-slate-800 text-white rounded text-xs disabled:opacity-50"
                  onClick={() => run(() => call(token, `/api/oos/${id}/tasks`, 'POST', { templateId }), 'Checklist applied')}>Apply</button>
                <input aria-label="New task" className="px-2 py-1 border rounded text-xs flex-1 min-w-[12rem]" placeholder="Add a task" value={newTask} onChange={e => setNewTask(e.target.value)} />
                <button type="button" disabled={newTask.trim().length < 3} className="px-3 py-1 bg-slate-800 text-white rounded text-xs disabled:opacity-50"
                  onClick={() => run(() => call(token, `/api/oos/${id}/tasks`, 'POST', { title: newTask }), 'Task added').then(ok => { if (ok) setNewTask(''); })}>Add</button>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Assignable cause (Phase I)</h4>
            {detail.assignableCause
              ? <p className="text-xs text-slate-800">[{detail.assignableCauseCategory}] {detail.assignableCause} <span className="text-slate-500">(recorded by {detail.assignableCauseBy})</span></p>
              : <p className="text-xs text-slate-500">No assignable cause recorded.</p>}
            {detail.invalidatedAt
              ? <p className="text-xs font-semibold text-emerald-800">Confirmed by QA ({detail.invalidatedBy}): the original result is invalidated.</p>
              : open && inPhase1 && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <select aria-label="Cause category" className="px-2 py-1 border rounded text-xs" value={cause.category} onChange={e => setCause({ ...cause, category: e.target.value })}>
                      {OOS_RESULT_CHANGE_CODES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input aria-label="Cause description" className="px-2 py-1 border rounded text-xs flex-1" placeholder="The cause and its evidence" value={cause.description} onChange={e => setCause({ ...cause, description: e.target.value })} />
                    <button type="button" className="px-3 py-1 bg-slate-800 text-white rounded text-xs"
                      onClick={() => {
                        if (cause.description.trim().length < 10) { toast('Describe the cause and its evidence (at least 10 characters).', 'error'); return; }
                        run(() => call(token, `/api/oos/${id}/assignable-cause`, 'PUT', { ...cause, expectedVersion: detail.version }), 'Assignable cause recorded');
                      }}>Record</button>
                  </div>
                  {detail.assignableCause && canApprove && (
                    <button type="button" className="px-3 py-1 bg-emerald-600 text-white rounded text-xs" onClick={() => setSigning({ kind: 'confirm' })}>Confirm cause and invalidate the result (sign)</button>
                  )}
                </div>
              )}
          </section>

          <section className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Retests</h4>
            <RetestSummary plan={detail.retestPlan} retests={detail.retests} />
            {open && !detail.retestPlan && canApprove && (detail.invalidatedAt || phase2Reached(detail)) && (
              <div className="flex gap-2 items-center">
                <input aria-label="Justification" className="px-2 py-1 border rounded text-xs flex-1" placeholder="Justification of the retests" value={planDraft.justification} onChange={e => setPlanDraft({ ...planDraft, justification: e.target.value })} />
                <input aria-label="Maximum retests" type="number" min={1} max={10} className="px-2 py-1 border rounded text-xs w-16" value={planDraft.maxRetests} onChange={e => setPlanDraft({ ...planDraft, maxRetests: Number(e.target.value) })} />
                <button type="button" className="px-3 py-1 bg-emerald-600 text-white rounded text-xs" onClick={() => {
                  if (planDraft.justification.trim().length < 10) { toast('Give the justification of the retests (at least 10 characters).', 'error'); return; }
                  setSigning({ kind: 'plan', ...planDraft });
                }}>Authorise retests (sign)</button>
              </div>
            )}
            {open && detail.retestPlan && usedRetests < detail.retestPlan.maxRetests && canEnter && (
              <div className="flex gap-2 items-center">
                <input aria-label="Retest value" className="px-2 py-1 border rounded text-xs w-28" placeholder="Value" value={retestDraft.value} onChange={e => setRetestDraft({ ...retestDraft, value: e.target.value })} />
                <input aria-label="Retest reason" className="px-2 py-1 border rounded text-xs flex-1" placeholder="Reason / reference" value={retestDraft.reason} onChange={e => setRetestDraft({ ...retestDraft, reason: e.target.value })} />
                <button type="button" className="px-3 py-1 bg-blue-600 text-white rounded text-xs" onClick={() =>
                  run(() => call(token, `/api/oos/${id}/retests`, 'POST', retestDraft), 'Retest recorded').then(ok => { if (ok) setRetestDraft({ value: '', reason: '' }); })}>Record retest</button>
              </div>
            )}
          </section>

          <section className="space-y-1">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">Linked quality records</h4>
            {detail.deviations.length === 0
              ? <p className="text-xs text-slate-500">None. A confirmed OOS opens a deviation on closure; others are linked from the QMS record.</p>
              : <ul className="text-xs">{detail.deviations.map(d => <li key={`${d.id}-${d.relation}`}><a className="text-blue-700 underline" href={`#/qms/${d.id}`}>{d.id}</a> · {d.title} · {d.state} ({d.relation})</li>)}</ul>}
          </section>
        </div>
      </div>
      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode={signing.kind === 'confirm' ? 'OOS_INVALIDATION' : 'OOS_RETEST_AUTHORISATION'}
          entityName={`OOS ${detail.id} (sample ${detail.sampleId}, ${detail.parameter})`}
          recordVersion={detail.version}
          requiresReason={signing.kind === 'confirm'}
          onClose={() => setSigning(null)}
          onSign={async (password, reason, totpCode) => {
            const creds = { password, ...(totpCode ? { totpCode } : {}), expectedVersion: detail.version };
            try {
              if (signing.kind === 'confirm') await call(token, `/api/oos/${id}/assignable-cause/confirm`, 'POST', { ...creds, reason: reason ?? '' });
              else await call(token, `/api/oos/${id}/retest-plan`, 'POST', { ...creds, justification: signing.justification, maxRetests: signing.maxRetests, ...(reason ? { reason } : {}) });
            } catch (e: any) { toast(e.message, 'error'); throw e; }
            toast(signing.kind === 'confirm' ? 'Assignable cause confirmed: original result invalidated' : 'Retests authorised', 'success');
            setSigning(null);
            await load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function OOSInvestigations({ token, user }: { token: string, user: any }) {
  const [investigations, setInvestigations] = useState<OOSInvestigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingOOS, setClosingOOS] = useState<OOSInvestigation | null>(null);
  const [creatingOOS, setCreatingOOS] = useState(false);
  const [editingOOS, setEditingOOS] = useState<OOSInvestigation | null>(null);
  const [newOOS, setNewOOS] = useState({ sampleId: '', resultId: '' });
  const [decision, setDecision] = useState('');
  const [editPhase, setEditPhase] = useState('');
  const [pendingSignature, setPendingSignature] = useState(false);
  const [rootCause, setRootCause] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<any>(null);
  const [selectedOOSForAI, setSelectedOOSForAI] = useState<OOSInvestigation | null>(null);
  const [verifyingSig, setVerifyingSig] = useState<any | null>(null);
  const [sigVerificationData, setSigVerificationData] = useState<any | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [closingDetail, setClosingDetail] = useState<OosDetail | null>(null);
  const { toast } = useToast();

  
  
  

  const fetchOOS = () => {
    fetch('/api/oos', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setInvestigations(data);
        setLoading(false);
      })
      .catch(err => {
        toast(err.message || 'Failed to fetch OOS records', 'error');
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchOOS();
  }, []);

  const handleCreateOOS = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/oos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(newOOS)
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast('OOS Created Successfully', 'success');
      setCreatingOOS(false);
      setNewOOS({ sampleId: '', resultId: '' });
      fetchOOS();
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const handleUpdateOOS = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingOOS) return;
    try {
      const res = await fetch(`/api/oos/${editingOOS.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // The status is never sent: it moves only with QA's closure signature. The phase moves forward only.
        body: JSON.stringify({
          assignedTo: editingOOS.assignedTo || null,
          ...(editPhase && editPhase !== (editingOOS as any).phase ? { phase: editPhase } : {}),
          expectedVersion: editingOOS.version
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast('OOS Updated Successfully', 'success');
      setEditingOOS(null);
      fetchOOS();
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const handleCloseOOS = async (password: string, reason?: string, totpCode?: string) => {
    if (!closingOOS) return;
    try {
      const res = await fetch(`/api/oos/${closingOOS.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ 
          rootCause, 
          conclusion: reason || conclusion, 
          decision,
          password,
          ...(totpCode ? { totpCode } : {}),
          expectedVersion: closingOOS.version
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      const closed = await res.json().catch(() => ({}));
      toast(closed?.deviationId ? `OOS investigation closed and signed; deviation ${closed.deviationId} opened` : 'OOS Investigation closed & electronically signed', 'success');
      setClosingOOS(null);
      setPendingSignature(false);
      fetchOOS();
    } catch (e: any) {
      toast(e.message, 'error');
      throw e; // Allows ElectronicSignatureModal to catch and show in-modal error!
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

  const runAICapaAnalysis = async (oos: OOSInvestigation) => {
    setSelectedOOSForAI(oos);
    setAiLoading(true);
    setAiResult(null);
    try {
      const res = await fetch('/api/ai/capa-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sampleId: oos.sampleId,
          resultId: oos.resultId,
          parameter: oos.parameter,
          value: 'OOS Result Value',
          notes: oos.rootCause || oos.conclusion
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAiResult(data);
      toast('AI Risk & CAPA Analysis Generated', 'success');
    } catch (e: any) {
      toast(e.message || 'AI analysis failed', 'error');
    } finally {
      setAiLoading(false);
    }
  };

  // The AI output is a suggestion (roadmap M26): it is copied into the draft fields of an open closure form only when the person asks,
  // and they are still edited and signed by that person. It never opens the closure by itself.
  const copyAiSuggestionIntoDraft = () => {
    if (!aiResult) return;
    if (!closingOOS) { toast('Open the closure form of the investigation first, then copy the suggestion into its draft.', 'info'); return; }
    setRootCause(aiResult.rootCauseConclusion || '');
    setConclusion([
      ...(aiResult.correctiveActions || []).map((a: string) => `Corrective: ${a}`),
      ...(aiResult.preventativeActions || []).map((a: string) => `Preventive: ${a}`),
    ].join('\n'));
    toast('AI suggestion copied into the draft: review and edit it before you sign.', 'info');
    setAiResult(null);
    setSelectedOOSForAI(null);
  };

  const openClosure = async (oos: OOSInvestigation) => {
    setClosingOOS(oos);
    setRootCause(oos.rootCause || '');
    setConclusion(oos.conclusion || '');
    setDecision('');
    setClosingDetail(null);
    try {
      const res = await fetch(`/api/oos/${oos.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setClosingDetail(data);
    } catch (e: any) { toast(e.message || 'Failed to load the investigation', 'error'); }
  };

  const getStatusColor = (stage: string) => {
    switch (stage) {
      case 'Phase I': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Phase II': return 'bg-red-100 text-red-800 border-red-200';
      case 'Pending QA': return 'bg-indigo-100 text-indigo-800 border-indigo-200';
      case 'Closed': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
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
              placeholder="Search investigations..." 
              className="ps-10 pe-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64"
            />
          </div>
          <button className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
            <Filter className="w-4 h-4" /> Filter
          </button>
          <button onClick={() => setCreatingOOS(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> New OOS
          </button>
        </div>
      </div>

      
      <div className="flex-1 overflow-auto p-6">
        {investigations.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {/* Trend Chart */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-4 uppercase tracking-wider">
                <TrendingUp className="w-4 h-4 text-indigo-500" /> OOS Frequency Trend
              </h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={
                    Object.entries(investigations.reduce((acc, oos) => {
                      const month = oos.dateRaised.substring(0, 7);
                      acc[month] = (acc[month] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>))
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, count]) => ({ date, count }))
                  }>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} />
                    <YAxis tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={3} dot={{ r: 4, fill: '#6366f1', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            
            {/* Analyst Chart */}
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-4 uppercase tracking-wider">
                <BarChart2 className="w-4 h-4 text-emerald-500" /> OOS by Analyst
              </h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={
                    Object.entries(investigations.reduce((acc, oos) => {
                      const analyst = oos.assignedTo || 'Unassigned';
                      acc[analyst] = (acc[analyst] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>))
                    .map(([name, count]) => ({ name, count }))
                  } layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                    <XAxis type="number" tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} allowDecimals={false} />
                    <YAxis dataKey="name" type="category" width={100} tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} cursor={{fill: '#f8fafc'}} />
                    <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} barSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-6">
          {investigations.map(oos => (

            <div key={oos.id} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col md:flex-row">
              <div className="bg-slate-50 p-6 border-b md:border-b-0 md:border-e border-slate-200 w-full md:w-1/3 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2">
                      <ShieldAlert className="w-5 h-5 text-red-600" /> {oos.id}
                    </h3>
                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${getStatusColor(oosStage(oos as any))}`}>
                        {oosStage(oos as any)}
                      </span>
                      {!isTerminalOosStatus(oos.status) && (
                        <button onClick={() => { setEditingOOS(oos); setEditPhase((oos as any).phase || ''); }} className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg">
                          <Edit className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-slate-500 mb-2">Sample: <span className="font-semibold text-blue-600">{oos.sampleId}</span></p>
                  {!isTerminalOosStatus(oos.status) && <div className="mb-3"><DueBadge dueDate={(oos as any).dueDate} overdue={(oos as any).overdue} /></div>}
                  
                  <div className="space-y-2 text-sm text-slate-700">
                    <div className="flex items-center gap-2"><Microscope className="w-4 h-4 text-slate-400"/> {oos.parameter}</div>
                    <div className="flex items-center gap-2"><User className="w-4 h-4 text-slate-400"/> {oos.assignedTo || 'Unassigned'}</div>
                    <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-slate-400"/> Raised: {formatDate(oos.dateRaised).split(',')[0]}</div>
                  </div>
                </div>
              </div>
              <div className="p-6 flex-1 flex flex-col">
                <h4 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-4">Investigation Details</h4>
                {isTerminalOosStatus(oos.status) ? (
                  <div className="space-y-4">
                    <div>
                      <span className="block text-xs font-medium text-slate-500 uppercase">Root Cause</span>
                      <p className="text-sm text-slate-900 mt-1">{oos.rootCause}</p>
                    </div>
                    <div>
                      <span className="block text-xs font-medium text-slate-500 uppercase">Conclusion / CAPA</span>
                      <p className="text-sm text-slate-900 mt-1">{oos.conclusion}</p>
                    </div>

                    {/* 21 CFR Part 11 Electronic Signature Stamp */}
                    <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-2 mt-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-900">
                          <ShieldCheck className="w-4 h-4 text-emerald-600" />
                          <span>21 CFR Part 11 Signed & Closed</span>
                        </div>
                        {oos.signature && (
                          <button
                            onClick={() => handleVerifySignature(oos.signature)}
                            className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[11px] font-semibold transition-colors flex items-center gap-1 shadow-xs"
                          >
                            <ShieldCheck className="w-3 h-3 text-emerald-300" /> Verify Seal
                          </button>
                        )}
                      </div>

                      <div className="text-xs text-slate-700 space-y-1">
                        <div className="flex justify-between">
                          <span className="text-slate-500">Signer:</span>
                          <span className="font-semibold text-slate-900">
                            {(oos as any).signature?.printedName || 'Signer not found'} ({(oos as any).signature?.signerRole || 'unknown role'})
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Meaning:</span>
                          <span className="font-medium text-blue-800">
                            {oos.signature?.meaning || 'OOS Closure & Disposition Approval'}
                          </span>
                        </div>
                        {oos.signature?.timestamp && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Execution Date:</span>
                            <span className="font-mono text-slate-700">
                              {formatDateTime(oos.signature.timestamp)}
                            </span>
                          </div>
                        )}
                        {oos.signature?.contentHash && (
                          <div className="pt-1 border-t border-emerald-200/60 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                            <span className="flex items-center gap-1">
                              <Fingerprint className="w-3 h-3 text-emerald-600" /> SHA-256 Seal:
                            </span>
                            <span className="truncate max-w-[140px]" title={oos.signature.contentHash}>
                              {oos.signature.contentHash}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col justify-center text-center text-slate-500">
                    <p className="mb-4 text-sm">Investigation is currently active. Root cause analysis pending.</p>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button 
                        onClick={() => runAICapaAnalysis(oos)}
                        disabled={aiLoading}
                        className="flex items-center gap-1.5 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-semibold transition-colors shadow-xs"
                      >
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                        {aiLoading && selectedOOSForAI?.id === oos.id ? 'Analyzing with AI...' : 'AI Risk & CAPA'}
                      </button>
                      <button onClick={() => setWorkflowId(oos.id)} className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold">
                        <Activity className="w-4 h-4" /> Workflow
                      </button>
                      {(user.role === 'QA' || user.role === 'Admin') && (
                        <button 
                          onClick={() => openClosure(oos)}
                          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors"
                        >
                          <Check className="w-4 h-4" /> Close & Sign
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {investigations.length === 0 && !loading && (
             <div className="text-center p-12 text-slate-500">
               No OOS Investigations found.
             </div>
          )}
        </div>
      </div>

      {pendingSignature && closingOOS && (
        <ElectronicSignatureModal
          user={user}
          action="close_oos"
          meaning="OOS Investigation Closure & Disposition Approval"
          meaningCode="OOS_CLOSURE"
          token={token}
          entityName={`OOS Record: ${closingOOS.id} (Sample: ${closingOOS.sampleId} - ${closingOOS.parameter})`}
          recordVersion={closingOOS.version}
          requiresReason={true}
          defaultReason={conclusion}
          onClose={() => setPendingSignature(false)}
          onSign={async (pwd, reason, totpCode) => {
            await handleCloseOOS(pwd, reason, totpCode);
          }}
        />
      )}
      {workflowId && <OosWorkflowPanel id={workflowId} token={token} user={user} onClose={() => setWorkflowId(null)} onChanged={fetchOOS} />}
      {closingOOS && !pendingSignature && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
             <div className="px-6 py-4 bg-slate-900 text-white">
               <h3 className="font-semibold tracking-tight">Approve Investigation {closingOOS.id}</h3>
             </div>
             <div className="p-6 space-y-4">
               <div className="bg-indigo-50/90 border border-indigo-200 rounded-lg p-3 flex items-center justify-between">
                 <div className="flex items-center gap-2">
                   <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
                   <span className="text-xs text-indigo-900 font-medium">Auto-generate FDA 6M Root Cause & CAPA</span>
                 </div>
                 <button
                   type="button"
                   onClick={() => runAICapaAnalysis(closingOOS)}
                   disabled={aiLoading}
                   className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold shrink-0 shadow-xs"
                 >
                   {aiLoading ? 'Analyzing...' : 'AI Assist'}
                 </button>
               </div>
               <div>
                 <div className="flex items-center justify-between mb-1">
                   <label className="block text-sm font-medium text-slate-700">Root Cause</label>
                   <VoiceRecorder onTranscription={(text) => setRootCause(prev => prev + (prev ? " " : "") + text)} token={token} />
                 </div>
                 <textarea 
                   className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 h-24 resize-none"
                   value={rootCause}
                   onChange={e => setRootCause(e.target.value)}
                   placeholder="Document root cause findings..."
                 />
               </div>
               <div>
                 
                 <div className="flex items-center justify-between mb-1">
                   <label className="block text-sm font-medium text-slate-700">Conclusion / Corrective Action (CAPA)</label>
                   <VoiceRecorder onTranscription={(text) => setConclusion(prev => prev + (prev ? " " : "") + text)} token={token} />
                   
                 </div>
                 <textarea 
 
                   className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 h-24 resize-none"
                   value={conclusion}
                   onChange={e => setConclusion(e.target.value)}
                   placeholder="Document corrective actions..."
                 />
               </div>
               <div>
                 <label className="block text-sm font-medium text-slate-700 mb-1">Decision</label>
                 <select className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value={decision} onChange={e => setDecision(e.target.value)}>
                   <option value="">Choose...</option>
                   {OOS_CLOSURE_DECISIONS.map(d => <option key={d} value={d}>{d}</option>)}
                 </select>
               </div>
               {decision && closingDetail && closureProblems(closingDetail, decision as OosClosureDecision, user.id).length > 0 && (
                 <ul className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 list-disc ps-6" role="alert">
                   {closureProblems(closingDetail, decision as OosClosureDecision, user.id).map(m => <li key={m}>{m}</li>)}
                 </ul>
               )}
               <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-slate-100">
                 <button onClick={() => setClosingOOS(null)} className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200">Cancel</button>
                 <button 
                   onClick={() => {
                     if (!rootCause || !conclusion) { toast('Please complete the root cause and the conclusion', 'error'); return; }
                     if (!decision) { toast(`Choose the decision: ${OOS_CLOSURE_DECISIONS.join(', ')}`, 'error'); return; }
                     const problems = closingDetail ? closureProblems(closingDetail, decision as OosClosureDecision, user.id) : [];
                     if (problems.length) { toast(problems[0], 'error'); return; }
                     setPendingSignature(true);
                   }} 
                   className="px-4 py-2 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700"
                 >Proceed to E-Signature</button>
               </div>
             </div>
          </div>
        </div>
      )}
      {creatingOOS && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
             <div className="px-6 py-4 bg-slate-900 text-white flex justify-between items-center">
               <h3 className="font-semibold tracking-tight">Log New OOS</h3>
             </div>
             <form onSubmit={handleCreateOOS} className="p-6 space-y-4">
               <div className="grid grid-cols-2 gap-4">
                 <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1">Sample ID</label>
                   <input required type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value={newOOS.sampleId} onChange={e => setNewOOS({...newOOS, sampleId: e.target.value})} />
                 </div>
                 <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1">Result ID</label>
                   <input required type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value={newOOS.resultId} onChange={e => setNewOOS({...newOOS, resultId: e.target.value})} />
                 </div>
               </div>
               <p className="text-xs text-slate-500">The parameter is taken from the result and the date raised is today (the server's date). An OOS result opens its investigation by itself.</p>
               <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-slate-100">
                 <button type="button" onClick={() => setCreatingOOS(false)} className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200">Cancel</button>
                 <button type="submit" className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700">Create</button>
               </div>
             </form>
          </div>
        </div>
      )}
      {editingOOS && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
             <div className="px-6 py-4 bg-slate-900 text-white flex justify-between items-center">
               <h3 className="font-semibold tracking-tight">Edit OOS {editingOOS.id}</h3>
             </div>
             <form onSubmit={handleUpdateOOS} className="p-6 space-y-4">
               <div>
                 <label className="block text-sm font-medium text-slate-700 mb-1">Assigned To (User ID)</label>
                 <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value={editingOOS.assignedTo || ''} onChange={e => setEditingOOS({...editingOOS, assignedTo: e.target.value})} />
               </div>
               <div>
                 <label className="block text-sm font-medium text-slate-700 mb-1">Phase (forward only; the investigation is closed by QA's signature)</label>
                 <select className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" value={editPhase} onChange={e => setEditPhase(e.target.value)}>
                    {(() => { const cur = ((editingOOS as any).phase || 'Phase I') as OosPhase; return [cur, ...(OOS_PHASE_TRANSITIONS[cur] ?? [])]; })().map(p => <option key={p} value={p}>{p}</option>)}
                 </select>
               </div>
               <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-slate-100">
                 <button type="button" onClick={() => setEditingOOS(null)} className="px-4 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200">Cancel</button>
                 <button type="submit" className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700">Save Changes (v{editingOOS.version})</button>
               </div>
             </form>
          </div>
        </div>
      )}
      {/* AI CAPA & Root Cause Intelligence Modal */}
      {aiResult && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full overflow-hidden border border-slate-200 my-8">
            <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-indigo-300" />
                </div>
                <div>
                  <h3 className="font-bold text-base tracking-tight">AI suggestion (optional): Root Cause & CAPA</h3>
                  <p className="text-xs text-indigo-300/80">FDA 21 CFR Part 211 & ICH Q10 Quality Intelligence</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-indigo-900/80 border border-indigo-700 text-indigo-200">
                  RPN: {aiResult.fmeaRiskScore?.rpn || 'N/A'} ({aiResult.fmeaRiskScore?.riskLevel || 'Medium'})
                </span>
                <button
                  onClick={() => setAiResult(null)}
                  className="text-slate-400 hover:text-white p-1 rounded-lg text-sm"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
              <AiSuggestionPanel result={aiResult} onUse={copyAiSuggestionIntoDraft} onDismiss={() => setAiResult(null)} />
              <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-4">
                <div className="text-xs font-bold text-indigo-900 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-indigo-600" /> Executive Compliance Summary
                </div>
                <p className="text-sm text-indigo-950 font-medium leading-relaxed">{aiResult.summary}</p>
              </div>

              {aiResult.fmeaRiskScore && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">FMEA Risk Assessment Matrix</div>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500 uppercase font-bold">Severity (S)</div>
                      <div className="text-lg font-bold font-mono text-slate-800">{aiResult.fmeaRiskScore.severity} / 10</div>
                    </div>
                    <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500 uppercase font-bold">Occurrence (O)</div>
                      <div className="text-lg font-bold font-mono text-slate-800">{aiResult.fmeaRiskScore.occurrence} / 10</div>
                    </div>
                    <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500 uppercase font-bold">Detection (D)</div>
                      <div className="text-lg font-bold font-mono text-slate-800">{aiResult.fmeaRiskScore.detection} / 10</div>
                    </div>
                    <div className="bg-indigo-600 text-white p-2.5 rounded-lg shadow-xs">
                      <div className="text-[10px] text-indigo-200 uppercase font-bold">RPN Score</div>
                      <div className="text-lg font-extrabold font-mono">{aiResult.fmeaRiskScore.rpn}</div>
                    </div>
                  </div>
                </div>
              )}

              {aiResult.fishboneAnalysis && (
                <div>
                  <div className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5 text-blue-600" /> Ishikawa 6M Root Cause Evaluation
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                    {Object.entries(aiResult.fishboneAnalysis).map(([key, val]: [string, any]) => (
                      <div key={key} className="bg-white border border-slate-200 rounded-lg p-3 shadow-2xs">
                        <div className="font-bold text-slate-800 capitalize mb-1 text-[11px] text-blue-700">{key}</div>
                        <div className="text-slate-600 text-xs leading-normal">{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {aiResult.phase1LabInvestigation && (
                <div className="border border-slate-200 rounded-xl p-4 bg-white">
                  <div className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5 text-emerald-600" /> Phase 1 Laboratory Verification Steps
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-600">
                    {aiResult.phase1LabInvestigation.map((step: string, i: number) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="w-4 h-4 rounded-full bg-slate-100 text-slate-600 text-[10px] flex items-center justify-center font-mono shrink-0 mt-0.5">{i+1}</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* 21 CFR Part 11 Signature Verification Certificate Modal */}
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
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Attributable: Signer identity authenticated
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Legible: Readable immutable audit sequence
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Contemporaneous: Server verified execution timestamp
                      </div>
                      <div className="flex items-center gap-1.5 text-blue-800">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Original: Cryptographic genesis link verified
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
