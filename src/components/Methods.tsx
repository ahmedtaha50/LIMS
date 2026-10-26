// Methods, calculation formulas and test plans (roadmap M18). Owned by r2-methods-calc.
//
// Each is a controlled configuration record: shown by its REVISION ("Rev 2"), never by the concurrency counter `version` (sent back as
// expectedVersion); a Draft is edited and then signed Effective by someone other than its author; an Effective one is never edited,
// a new revision is drafted from it. What the user may do comes from GET /permissions/me; the server decides again on every call.
import React, { useCallback, useEffect, useState } from 'react';
import { Calculator, ClipboardList, Copy, Edit, FlaskConical, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useToast } from './ui/Toast';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { FormulaEditor, type FormulaDraft } from './FormulaEditor';
import { apiFetch, errorMessage } from '../lib/api';
import type { FormulaInput, FormulaTestCase, SstCriterion } from '../lib/validations/methods';

export type ConfigKind = 'Method' | 'Formula' | 'Test plan';

/** The fields every row of GET /methods, /calc/formulas and /test-plans has (a formula's name is shown as its title). */
export interface ConfigView {
  id: string;
  code: string;
  title: string;
  revision: number;
  status: 'Draft' | 'Effective' | 'Superseded' | string;
  /** The concurrency counter: sent back as expectedVersion, not shown as the revision. */
  version: number;
  createdBy: string | null;
  approvedBy: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  Effective: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  Draft: 'bg-amber-100 text-amber-800 border-amber-200',
  Superseded: 'bg-slate-200 text-slate-600 border-slate-300',
};

export interface ConfigCardProps {
  record: ConfigView;
  kind: ConfigKind;
  canEdit: boolean;
  canApprove: boolean;
  /** The signed-in user: the author of a Draft is not offered the approval (the server refuses it too). */
  userId?: string;
  onEdit?: (r: ConfigView) => void;
  onRevise?: (r: ConfigView) => void;
  onApprove?: (r: ConfigView) => void;
  children?: React.ReactNode;
}

export function ConfigCard({ record, kind, canEdit, canApprove, userId, onEdit, onRevise, onApprove, children }: ConfigCardProps) {
  const isAuthor = !!userId && record.createdBy === userId;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col" data-record-id={record.id}>
      <div className="p-4 border-b border-slate-100 flex justify-between items-start bg-slate-50/50 rounded-t-xl gap-3">
        <div>
          <h3 className="font-bold text-slate-900">{record.title}</h3>
          <p className="text-xs font-mono text-slate-500 mt-1">{kind} {record.code}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-sm font-semibold text-slate-800">Rev {record.revision}</span>
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${STATUS_STYLE[record.status] ?? 'bg-slate-100 text-slate-800 border-slate-200'}`}>{record.status}</span>
        </div>
      </div>
      <div className="p-4 flex-1 text-sm text-slate-700">{children}</div>
      <div className="p-3 border-t border-slate-100 bg-slate-50 rounded-b-xl flex flex-wrap gap-2 justify-between items-center text-xs text-slate-500">
        <span>
          Author {record.createdByName ?? record.createdBy ?? 'not recorded'}
          {record.approvedBy && <> · Approved by {record.approvedByName ?? record.approvedBy}{record.approvedAt ? ` on ${record.approvedAt.slice(0, 10)}` : ''}</>}
        </span>
        <span className="flex gap-2">
          {record.status === 'Draft' && canEdit && onEdit && (
            <button type="button" onClick={() => onEdit(record)} className="flex items-center gap-1 text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200"><Edit className="w-4 h-4" />Edit</button>
          )}
          {record.status === 'Effective' && canEdit && onRevise && (
            <button type="button" onClick={() => onRevise(record)} className="flex items-center gap-1 text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200"><Copy className="w-4 h-4" />New revision</button>
          )}
          {record.status === 'Draft' && canApprove && onApprove && (
            isAuthor
              ? <span className="text-slate-500 self-center">You wrote this revision: another person must approve it.</span>
              : <button type="button" onClick={() => onApprove(record)} className="flex items-center gap-1 text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200"><ShieldCheck className="w-4 h-4" />Approve</button>
          )}
        </span>
      </div>
    </div>
  );
}

// ---- rows of the three lists ---------------------------------------------------------------------------------------------------

interface MethodRow extends ConfigView { description: string | null; instrumentType: string | null; requiredTrainingModule: string | null; sstCriteria: SstCriterion[] }
interface FormulaRow extends Omit<ConfigView, 'title'> { name: string; expression: string; unit: string | null; inputs: FormulaInput[]; testCases: FormulaTestCase[] }
interface PlanRow extends Omit<ConfigView, 'title'> { name: string; material: string; purpose: string; parameters: string[] }

type Tab = 'methods' | 'formulas' | 'plans';
const KIND: Record<Tab, ConfigKind> = { methods: 'Method', formulas: 'Formula', plans: 'Test plan' };
const BASE: Record<Tab, string> = { methods: '/methods', formulas: '/calc/formulas', plans: '/test-plans' };
const MEANING: Record<Tab, string> = { methods: 'METHOD_APPROVAL', formulas: 'FORMULA_APPROVAL', plans: 'TEST_PLAN_APPROVAL' };

interface MethodDraft { code: string; title: string; description: string; instrumentType: string; requiredTrainingModule: string; sstCriteria: SstCriterion[] }
interface PlanDraft { code: string; name: string; material: string; purpose: string; parameters: string }
type Editing =
  | { tab: 'methods'; id?: string; version?: number; draft: MethodDraft }
  | { tab: 'formulas'; id?: string; version?: number; draft: FormulaDraft }
  | { tab: 'plans'; id?: string; version?: number; draft: PlanDraft };

const blankCriterion = (): SstCriterion => ({ name: '', formulaCode: '', limit_kind: 'NMT', lower: null, upper: null, decimals: 1, replicates: null });
const num = (v: string) => (v.trim() === '' ? null : Number(v));
const limitOf = (c: SstCriterion) => (c.limit_kind === 'NMT' ? `NMT ${c.upper}` : c.limit_kind === 'NLT' ? `NLT ${c.lower}` : `${c.lower} - ${c.upper}`);

export function Methods({ token, user }: { token?: string; user: any }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('methods');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [formulas, setFormulas] = useState<FormulaRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [approving, setApproving] = useState<{ tab: Tab; record: ConfigView } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, f, p] = await Promise.all([apiFetch<MethodRow[]>('/methods'), apiFetch<FormulaRow[]>('/calc/formulas'), apiFetch<PlanRow[]>('/test-plans')]);
      setMethods(m); setFormulas(f); setPlans(p);
    } catch (err) { toast.error(errorMessage(err, 'The methods could not be loaded.')); }
  }, [toast]);

  useEffect(() => {
    load();
    apiFetch<{ permissions: string[] }>('/permissions/me')
      .then(me => setPermissions(me.permissions))
      .catch(err => toast.error(errorMessage(err, 'Your permissions could not be loaded; actions are hidden.')));
  }, [load, toast]);

  const canManage = permissions.includes('method.manage');
  const canApprove = permissions.includes('method.approve');

  const startCreate = () => {
    if (tab === 'methods') setEditing({ tab, draft: { code: '', title: '', description: '', instrumentType: '', requiredTrainingModule: '', sstCriteria: [] } });
    else if (tab === 'formulas') setEditing({ tab, draft: { code: '', name: '', expression: '', unit: null, inputs: [{ name: 'x', label: null, unit: null, replicates: true }], testCases: [] } });
    else setEditing({ tab, draft: { code: '', name: '', material: '', purpose: 'Release', parameters: '' } });
  };
  const startEdit = (t: Tab, id: string) => {
    if (t === 'methods') {
      const m = methods.find(x => x.id === id)!;
      setEditing({ tab: t, id, version: m.version, draft: { code: m.code, title: m.title, description: m.description ?? '', instrumentType: m.instrumentType ?? '', requiredTrainingModule: m.requiredTrainingModule ?? '', sstCriteria: m.sstCriteria ?? [] } });
    } else if (t === 'formulas') {
      const f = formulas.find(x => x.id === id)!;
      setEditing({ tab: t, id, version: f.version, draft: { code: f.code, name: f.name, expression: f.expression, unit: f.unit, inputs: f.inputs, testCases: f.testCases } });
    } else {
      const p = plans.find(x => x.id === id)!;
      setEditing({ tab: t, id, version: p.version, draft: { code: p.code, name: p.name, material: p.material, purpose: p.purpose, parameters: p.parameters.join(', ') } });
    }
  };

  const save = async () => {
    if (!editing) return;
    let body: Record<string, unknown>;
    if (editing.tab === 'methods') {
      const d = editing.draft;
      body = { title: d.title, description: d.description || null, instrumentType: d.instrumentType || null, requiredTrainingModule: d.requiredTrainingModule || null, sstCriteria: d.sstCriteria };
    } else if (editing.tab === 'formulas') {
      const { code: _c, ...d } = editing.draft;
      body = d;
    } else {
      const d = editing.draft;
      body = { name: d.name, purpose: d.purpose, parameters: d.parameters.split(',').map(s => s.trim()).filter(Boolean) };
      if (!editing.id) body.material = d.material;
    }
    const path = editing.id ? `${BASE[editing.tab]}/${editing.id}` : BASE[editing.tab];
    if (editing.id) body.expectedVersion = editing.version; else body.code = editing.draft.code;
    setSaving(true);
    try {
      const r = await apiFetch<{ code: string; revision: number }>(path, { method: editing.id ? 'PUT' : 'POST', body });
      toast.success(`${KIND[editing.tab]} ${r.code} Rev ${r.revision} saved as a Draft (audit logged).`);
      setEditing(null);
      await load();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const revise = async (t: Tab, r: ConfigView) => {
    try {
      const n = await apiFetch<{ code: string; revision: number }>(`${BASE[t]}/${r.id}/revise`, { method: 'POST', body: {} });
      toast.success(`${KIND[t]} ${n.code} Rev ${n.revision} drafted from Rev ${r.revision}.`);
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const approve = async (password: string, reason?: string, totpCode?: string) => {
    if (!approving) return;
    const body: Record<string, unknown> = { password, expectedVersion: approving.record.version };
    if (reason?.trim()) body.reason = reason.trim();
    if (totpCode) body.totpCode = totpCode;
    try {
      await apiFetch(`${BASE[approving.tab]}/${approving.record.id}/approve`, { method: 'POST', body, replay: 'never' });
      toast.success(`${KIND[approving.tab]} ${approving.record.code} Rev ${approving.record.revision} approved: Effective.`);
      setApproving(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
      throw err; // the signature dialog shows it too and clears the password
    }
  };

  const tryFormula = async (expression: string, inputs: FormulaTestCase['inputs'], decimals: number | null) => {
    const r = await apiFetch<{ reported: string }>('/calc/evaluate', { method: 'POST', body: { expression, inputs, decimals } });
    return r.reported;
  };

  const card = (t: Tab, record: ConfigView, details: React.ReactNode) => (
    <React.Fragment key={record.id}>
      <ConfigCard record={record} kind={KIND[t]} userId={user?.id} canEdit={canManage} canApprove={canApprove}
        onEdit={r => startEdit(t, r.id)} onRevise={r => revise(t, r)} onApprove={r => setApproving({ tab: t, record: r })}>
        {details}
      </ConfigCard>
    </React.Fragment>
  );

  const setMethodDraft = (patch: Partial<MethodDraft>) => setEditing(e => (e && e.tab === 'methods' ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const setCriterion = (i: number, patch: Partial<SstCriterion>) => setEditing(e => (e && e.tab === 'methods'
    ? { ...e, draft: { ...e.draft, sstCriteria: e.draft.sstCriteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) } } : e));
  const setPlanDraft = (patch: Partial<PlanDraft>) => setEditing(e => (e && e.tab === 'plans' ? { ...e, draft: { ...e.draft, ...patch } } : e));

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-2 justify-between items-center">
        <div role="tablist" aria-label="Configuration" className="flex gap-1">
          {([['methods', 'Methods', FlaskConical], ['formulas', 'Calculations', Calculator], ['plans', 'Test plans', ClipboardList]] as const).map(([t, label, Icon]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm ${tab === t ? 'bg-white border border-slate-300 font-semibold' : 'text-slate-600'}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        {canManage && <Button variant="primary" onClick={startCreate}><Plus className="w-4 h-4" /> New {KIND[tab].toLowerCase()}</Button>}
      </div>

      <div className="flex-1 overflow-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-4 content-start">
        {tab === 'methods' && methods.map(m => card('methods', m, (
          <dl className="space-y-1">
            {m.description && <dd>{m.description}</dd>}
            <dd>Instrument type: {m.instrumentType ?? 'any'}</dd>
            <dd>Training module: {m.requiredTrainingModule ?? 'none named'}</dd>
            <dd>System suitability: {m.sstCriteria?.length ? m.sstCriteria.map(c => `${c.name} (${c.formulaCode}, ${limitOf(c)})`).join('; ') : 'none'}</dd>
          </dl>
        )))}
        {tab === 'formulas' && formulas.map(f => card('formulas', { ...f, title: f.name }, (
          <div className="space-y-1">
            <code className="block font-mono bg-slate-50 border border-slate-200 rounded px-2 py-1">{f.expression}</code>
            <p>Inputs: {f.inputs.map(i => `${i.name}${i.replicates ? ' (replicates)' : ''}`).join(', ')}{f.unit ? ` · result in ${f.unit}` : ''}</p>
            <p>{f.testCases.length} test case(s)</p>
          </div>
        )))}
        {tab === 'plans' && plans.map(p => card('plans', { ...p, title: p.name }, (
          <div className="space-y-1">
            <p>{p.material} · {p.purpose}</p>
            <p>Parameters: {p.parameters.join(', ')}</p>
          </div>
        )))}
        {((tab === 'methods' && methods.length === 0) || (tab === 'formulas' && formulas.length === 0) || (tab === 'plans' && plans.length === 0)) && (
          <p className="text-slate-500 col-span-full text-center p-8">Nothing here yet.</p>
        )}
      </div>

      <Modal open={!!editing} size="xl" title={editing ? `${editing.id ? 'Edit' : 'New'} ${KIND[editing.tab].toLowerCase()} (Draft)` : ''} onClose={() => setEditing(null)} dismissible={!saving}
        footer={<><Button onClick={() => setEditing(null)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={save} busy={saving}>Save</Button></>}>
        {editing?.tab === 'formulas' && (
          <FormulaEditor value={editing.draft} codeLocked={!!editing.id} onTry={tryFormula} onChange={draft => setEditing(e => (e && e.tab === 'formulas' ? { ...e, draft } : e))} />
        )}
        {editing?.tab === 'methods' && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">Code<input type="text" value={editing.draft.code} disabled={!!editing.id} onChange={e => setMethodDraft({ code: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" /></label>
              <label className="flex flex-col gap-1 md:col-span-2">Title<input type="text" value={editing.draft.title} onChange={e => setMethodDraft({ title: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            </div>
            <label className="flex flex-col gap-1">Description<textarea value={editing.draft.description} onChange={e => setMethodDraft({ description: e.target.value })} rows={2} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">Instrument type (results need an instrument of this type)<input type="text" value={editing.draft.instrumentType} onChange={e => setMethodDraft({ instrumentType: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
              <label className="flex flex-col gap-1">Training module<input type="text" value={editing.draft.requiredTrainingModule} onChange={e => setMethodDraft({ requiredTrainingModule: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            </div>
            <fieldset className="border border-slate-200 rounded-lg p-3">
              <legend className="px-1 font-semibold text-slate-700">System suitability criteria</legend>
              {editing.draft.sstCriteria.map((c, i) => (
                <div key={i} className="flex flex-wrap gap-2 items-center mb-2">
                  <input type="text" aria-label="Criterion name" placeholder="criterion" value={c.name} onChange={e => setCriterion(i, { name: e.target.value })} className="flex-1 min-w-[160px] px-2 py-1 border border-slate-300 rounded" />
                  <input type="text" aria-label="Formula code" placeholder="formula code" value={c.formulaCode} onChange={e => setCriterion(i, { formulaCode: e.target.value })} className="w-36 px-2 py-1 border border-slate-300 rounded font-mono" />
                  <select aria-label="Limit kind" value={c.limit_kind} onChange={e => setCriterion(i, { limit_kind: e.target.value as SstCriterion['limit_kind'] })} className="px-2 py-1 border border-slate-300 rounded">
                    <option value="NMT">NMT</option><option value="NLT">NLT</option><option value="RANGE">RANGE</option>
                  </select>
                  {c.limit_kind !== 'NMT' && <input type="number" step="any" aria-label="Lower limit" placeholder="lower" value={c.lower ?? ''} onChange={e => setCriterion(i, { lower: num(e.target.value) })} className="w-20 px-2 py-1 border border-slate-300 rounded" />}
                  {c.limit_kind !== 'NLT' && <input type="number" step="any" aria-label="Upper limit" placeholder="upper" value={c.upper ?? ''} onChange={e => setCriterion(i, { upper: num(e.target.value) })} className="w-20 px-2 py-1 border border-slate-300 rounded" />}
                  <input type="number" min={0} max={10} aria-label="Decimals" placeholder="decimals" value={c.decimals} onChange={e => setCriterion(i, { decimals: Number(e.target.value) })} className="w-20 px-2 py-1 border border-slate-300 rounded" />
                  <input type="number" min={1} max={100} aria-label="Injections" placeholder="injections" value={c.replicates ?? ''} onChange={e => setCriterion(i, { replicates: num(e.target.value) })} className="w-24 px-2 py-1 border border-slate-300 rounded" />
                  <button type="button" aria-label="Remove criterion" onClick={() => setMethodDraft({ sstCriteria: editing.draft.sstCriteria.filter((_, j) => j !== i) })} className="text-red-500 p-1 rounded hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
              <button type="button" onClick={() => setMethodDraft({ sstCriteria: [...editing.draft.sstCriteria, blankCriterion()] })} className="text-blue-700 flex items-center gap-1"><Plus className="w-4 h-4" /> Add criterion</button>
            </fieldset>
          </div>
        )}
        {editing?.tab === 'plans' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">Code<input type="text" value={editing.draft.code} disabled={!!editing.id} onChange={e => setPlanDraft({ code: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" /></label>
            <label className="flex flex-col gap-1">Name<input type="text" value={editing.draft.name} onChange={e => setPlanDraft({ name: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            <label className="flex flex-col gap-1">Material<input type="text" value={editing.draft.material} disabled={!!editing.id} onChange={e => setPlanDraft({ material: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            <label className="flex flex-col gap-1">Purpose<input type="text" value={editing.draft.purpose} onChange={e => setPlanDraft({ purpose: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
            <label className="flex flex-col gap-1 md:col-span-2">Parameters of the specification (comma separated)<input type="text" value={editing.draft.parameters} onChange={e => setPlanDraft({ parameters: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" /></label>
          </div>
        )}
      </Modal>

      {approving && (
        <ElectronicSignatureModal user={user} token={token} meaningCode={MEANING[approving.tab]} action="approve"
          entityName={`${KIND[approving.tab]} ${approving.record.code} Rev ${approving.record.revision}`} recordVersion={approving.record.version}
          onClose={() => setApproving(null)} onSign={approve} />
      )}
    </div>
  );
}
