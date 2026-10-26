// Specifications (roadmap M11; parameters bound to a method, a formula, replicates and a stage: roadmap M18). Owned by r2-methods-calc,
// which took it over from r1-spec.
//
// A specification is shown by its REVISION ("Rev 2"), the number the laboratory knows it by. `version` is the server's optimistic-
// concurrency counter: it is sent back as expectedVersion on every write and never shown as if it were the revision.
// What the user may do comes from GET /permissions/me (never a role name compared here); the server decides again on every call.
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, CalendarClock, CheckCircle2, Copy, Edit, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useToast } from './ui/Toast';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch } from '../lib/api';
import { localizedError, t, useLang } from '../i18n';
import { formatDate } from '../lib/format';
import { hasPermission } from '../lib/permissions';
import type { BoundSpecParameter } from '../lib/validations/methods';
import { LIMIT_KINDS, type LimitKind } from '../lib/validations/specifications';

type SpecParameter = BoundSpecParameter;

export type Effectiveness = 'Draft' | 'Scheduled' | 'Effective' | 'Superseded' | 'Unusable';

/** One row of GET /api/specifications. */
export interface SpecView {
  id: string;
  material: string;
  revisionLabel: number;
  /** The concurrency counter: sent back as expectedVersion, not shown as the revision. */
  version: number;
  effectiveDate: string;
  status: 'Draft' | 'Active' | 'Obsolete';
  parameters: SpecParameter[];
  createdBy: string | null;
  approvedBy: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  effectiveness?: Effectiveness;
  /** Draft only: what approving it now would replace, and the samples in progress that it touches. */
  approval?: { supersedes: string[]; samplesInProgress: number };
}

const NUMERIC: readonly LimitKind[] = ['RANGE', 'NMT', 'NLT'];
/** "Method HPLC-01 · Formula ASSAY-1 · n = 2 · Release": what a parameter is tested and calculated by, or '' when it is not bound. */
export function formatBinding(p: SpecParameter): string {
  return [p.method_code && `Method ${p.method_code}`, p.formula_code && `Formula ${p.formula_code}`, p.replicates && `n = ${p.replicates}`, p.stage]
    .filter(Boolean).join(' · ');
}

const fmt = (n: number | null, decimals: number | null) => (n === null ? '' : decimals === null ? String(n) : n.toFixed(decimals));

/** How a limit is written on the screen and in reports: "98.0 - 102.0 %", "NMT 0.50 %", "NLT 98.0 %", or the acceptance text. */
export function formatLimit(p: SpecParameter): string {
  const unit = p.unit ? ` ${p.unit}` : '';
  switch (p.limit_kind) {
    case 'RANGE': return `${fmt(p.lower, p.decimals)} - ${fmt(p.upper, p.decimals)}${unit}`;
    case 'NMT': return `NMT ${fmt(p.upper, p.decimals)}${unit}`;
    case 'NLT': return `NLT ${fmt(p.lower, p.decimals)}${unit}`;
    default: return p.text ?? '';
  }
}

export const revisionText = (s: Pick<SpecView, 'revisionLabel'>) => `Rev ${s.revisionLabel}`;

const STATUS_STYLE: Record<string, string> = {
  Active: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  Draft: 'bg-amber-100 text-amber-800 border-amber-200',
  Obsolete: 'bg-slate-200 text-slate-600 border-slate-300',
};
const effectivenessText = (e: Effectiveness): string => ({
  Draft: t('spec.notApproved'),
  Scheduled: t('spec.scheduled'),
  Effective: t('spec.inForce'),
  Superseded: t('spec.superseded'),
  Unusable: t('spec.unusable'),
})[e];

export interface SpecificationCardProps {
  spec: SpecView;
  canEdit: boolean;
  canCreate: boolean;
  canApprove: boolean;
  /** The signed-in user: the author of a Draft is not offered the approval (the server refuses it too). */
  userId?: string;
  onEdit?: (s: SpecView) => void;
  onRevise?: (s: SpecView) => void;
  onApprove?: (s: SpecView) => void;
}

export function SpecificationCard({ spec, canEdit, canCreate, canApprove, userId, onEdit, onRevise, onApprove }: SpecificationCardProps) {
  const isAuthor = !!userId && spec.createdBy === userId;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col" data-spec-id={spec.id}>
      <div className="p-5 border-b border-slate-100 flex justify-between items-start bg-slate-50/50 rounded-t-xl">
        <div>
          <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2">
            <BookOpenCheck className="w-5 h-5 text-blue-600" /> {spec.material}
          </h3>
          <p className="text-xs font-mono text-slate-500 mt-1"><bdi dir="ltr">{spec.id}</bdi></p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="text-sm font-semibold text-slate-800" data-testid="revision"><bdi dir="ltr">{revisionText(spec)}</bdi></span>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${STATUS_STYLE[spec.status] ?? 'bg-slate-100 text-slate-800 border-slate-200'}`}>{spec.status}</span>
          {spec.effectiveness && spec.effectiveness !== 'Draft' && (
            <span className="text-xs text-slate-500">{effectivenessText(spec.effectiveness)}</span>
          )}
        </div>
      </div>

      <div className="p-5 flex-1">
        <div className="mb-3 text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between items-center">
          <span>{t('spec.parametersAndLimits')}</span>
          {spec.status === 'Draft' && canEdit && onEdit && (
            <button type="button" onClick={() => onEdit(spec)} className="flex items-center gap-1 text-blue-600 hover:text-blue-800">
              <Edit className="w-3.5 h-3.5" aria-hidden="true" /> {t('spec.edit')}
            </button>
          )}
        </div>
        {spec.parameters.length === 0 ? (
          <p className="text-sm text-slate-500 italic">{t('spec.noParameters')}</p>
        ) : (
          <ul className="space-y-2">
            {spec.parameters.map(p => (
              <li key={p.name} className="flex justify-between items-center gap-3 p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                <span className="text-sm font-medium text-slate-800">
                  {p.name}
                  {formatBinding(p) && <span className="block text-xs font-normal text-slate-500">{formatBinding(p)}</span>}
                </span>
                <span dir="ltr" className="text-sm font-mono text-slate-600 bg-white px-2 py-1 rounded border border-slate-200">
                  {formatLimit(p)}{NUMERIC.includes(p.limit_kind) && p.decimals === null ? t('spec.decimalsUndeclared') : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {spec.status === 'Draft' && spec.approval && spec.approval.supersedes.length > 0 && (
          <p className="mt-3 text-xs text-slate-600">
            {t('spec.approvingReplaces', { list: spec.approval.supersedes.join(', ') })}
            {spec.approval.samplesInProgress > 0 && t('spec.inProgress', { n: spec.approval.samplesInProgress })}
          </p>
        )}
      </div>

      <div className="p-4 border-t border-slate-100 bg-slate-50 rounded-b-xl flex flex-wrap gap-2 justify-between items-center text-xs text-slate-500">
        <span className="flex items-center gap-1"><CalendarClock className="w-4 h-4" aria-hidden="true" /> {t('spec.effective', { date: formatDate(spec.effectiveDate) })}</span>
        <span>
          {t('spec.author', { name: spec.createdByName ?? spec.createdBy ?? t('spec.notRecorded') })}
          {spec.approvedBy && <> · {t('spec.approvedBy', { name: spec.approvedByName ?? spec.approvedBy })}</>}
        </span>
        {spec.status === 'Active' && canCreate && onRevise && (
          <button type="button" onClick={() => onRevise(spec)} className="flex items-center gap-1 text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200">
            <Copy className="w-4 h-4" aria-hidden="true" /> {t('spec.newRevision')}
          </button>
        )}
        {spec.status === 'Active' && spec.effectiveness === 'Effective' && (
          <span className="flex items-center gap-1 text-emerald-600 font-medium"><CheckCircle2 className="w-4 h-4" aria-hidden="true" /> {t('spec.approvedForUse')}</span>
        )}
        {spec.status === 'Draft' && canApprove && onApprove && (
          isAuthor
            ? <span className="text-slate-500">{t('spec.youWrote')}</span>
            : (
              <button type="button" onClick={() => onApprove(spec)} className="flex items-center gap-1 text-emerald-600 font-medium bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200">
                <ShieldCheck className="w-4 h-4" aria-hidden="true" /> {t('spec.approve')}
              </button>
            )
        )}
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const blankParameter = (): SpecParameter => ({ name: '', unit: '', limit_kind: 'RANGE', lower: null, upper: null, decimals: 1, text: null });
const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

/** The parameter as the API expects it: only the fields its kind uses, and only the binding fields that are filled in. */
function forKind(p: SpecParameter): SpecParameter {
  const { method_code, formula_code, replicates, stage, ...limit } = p;
  const binding: Partial<SpecParameter> = {};
  if (method_code?.trim()) binding.method_code = method_code.trim();
  if (stage?.trim()) binding.stage = stage.trim();
  if (!NUMERIC.includes(p.limit_kind)) return { ...limit, ...binding, lower: null, upper: null, decimals: null };
  if (formula_code?.trim()) binding.formula_code = formula_code.trim();
  if (binding.formula_code && replicates) binding.replicates = replicates;
  return { ...limit, ...binding, text: null, lower: p.limit_kind === 'NMT' ? null : p.lower, upper: p.limit_kind === 'NLT' ? null : p.upper };
}

export function Specifications({ token, user }: { token?: string; user: any }) {
  useLang();
  const { toast } = useToast();
  const [specs, setSpecs] = useState<SpecView[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [material, setMaterial] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [editing, setEditing] = useState<SpecView | null>(null);
  const [draftParams, setDraftParams] = useState<SpecParameter[]>([]);
  const [draftDate, setDraftDate] = useState('');
  const [approving, setApproving] = useState<SpecView | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [codes, setCodes] = useState<{ methods: string[]; formulas: string[] }>({ methods: [], formulas: [] });

  const load = useCallback(async () => {
    try {
      setSpecs(await apiFetch<SpecView[]>('/specifications'));
    } catch (err) {
      toast.error(localizedError(err, 'spec.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    apiFetch<{ permissions: string[] }>('/permissions/me')
      .then(me => setPermissions(me.permissions))
      .catch(err => toast.error(localizedError(err, 'spec.permsFailed')));
  }, [load, toast]);

  const can = (code: 'spec.create' | 'spec.edit' | 'spec.approve') => hasPermission(permissions, code);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const s = await apiFetch<SpecView>('/specifications', { method: 'POST', body: { material, effectiveDate } });
      setMaterial('');
      toast.success(t('spec.created', { material: s.material, revision: revisionText(s) }));
      await load();
    } catch (err) { toast.error(localizedError(err, 'error.generic')); }
  };

  const revise = async (from: SpecView) => {
    try {
      const s = await apiFetch<SpecView>('/specifications', { method: 'POST', body: { material: from.material, effectiveDate: today(), reviseFrom: from.id } });
      toast.success(t('spec.drafted', { material: s.material, revision: revisionText(s), from: revisionText(from) }));
      await load();
    } catch (err) { toast.error(localizedError(err, 'error.generic')); }
  };

  const openEditor = (s: SpecView) => {
    setEditing(s); setDraftParams(s.parameters.map(p => ({ ...p }))); setDraftDate(s.effectiveDate);
    // The codes a parameter can be bound to (offered as suggestions; the server checks that they exist).
    // method.view joins PermissionCode with the gate patch of r2-methods-calc; compared as text until then.
    if (permissions.includes('method.view')) {
      Promise.all([apiFetch<Array<{ code: string }>>('/methods'), apiFetch<Array<{ code: string }>>('/calc/formulas')])
        .then(([m, f]) => setCodes({ methods: [...new Set(m.map(x => x.code))], formulas: [...new Set(f.map(x => x.code))] }))
        .catch(err => toast.error(localizedError(err, 'spec.codesFailed')));
    }
  };
  const setParam = (i: number, patch: Partial<SpecParameter>) => setDraftParams(list => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const save = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = { parameters: draftParams.map(forKind), expectedVersion: editing.version };
    if (draftDate !== editing.effectiveDate) body.effectiveDate = draftDate;
    try {
      const s = await apiFetch<SpecView>(`/specifications/${editing.id}`, { method: 'PUT', body });
      toast.success(t('spec.saved', { material: s.material, revision: revisionText(s) }));
      setEditing(null);
      await load();
    } catch (err) { toast.error(localizedError(err, 'error.generic')); }
  };

  const approve = async (password: string, reason?: string, totpCode?: string) => {
    if (!approving) return;
    const body: Record<string, unknown> = { password, expectedVersion: approving.version };
    if (reason?.trim()) body.reason = reason.trim();
    if (totpCode) body.totpCode = totpCode;
    if (exceptionReason.trim()) body.exceptionReason = exceptionReason.trim();
    try {
      const s = await apiFetch<SpecView>(`/specifications/${approving.id}/approve`, { method: 'POST', body, replay: 'never' });
      toast.success(t('spec.approved', { material: s.material, revision: revisionText(s), date: formatDate(s.effectiveDate) }));
      setApproving(null);
      setExceptionReason('');
      await load();
    } catch (err) {
      toast.error(localizedError(err, 'error.generic'));
      throw err; // the signature dialog shows it too and clears the password
    }
  };

  const needsException = !!approving?.approval && approving.approval.supersedes.length > 0 && approving.approval.samplesInProgress > 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {can('spec.create') && (
        <div className="p-6 border-b border-slate-200 bg-slate-50">
          <h3 className="text-lg font-semibold mb-1">{t('spec.newTitle')}</h3>
          <p className="text-xs text-slate-500 mb-3">{t('spec.newHelp')}</p>
          <form onSubmit={create} className="flex flex-wrap gap-4">
            <input type="text" aria-label={t('spec.material')} placeholder={t('spec.materialName')} dir="auto" required value={material} onChange={e => setMaterial(e.target.value)} className="flex-1 px-4 py-2 border rounded-lg border-slate-300 min-w-[200px]" />
            <input type="date" aria-label={t('spec.effectiveDate')} required value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="px-4 py-2 border rounded-lg border-slate-300" />
            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg flex items-center gap-2 whitespace-nowrap">
              <Plus className="w-4 h-4" aria-hidden="true" /> {t('spec.createDraft')}
            </button>
          </form>
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {specs.map(s => (
            <React.Fragment key={s.id}>
              <SpecificationCard spec={s} userId={user?.id} canEdit={can('spec.edit')} canCreate={can('spec.create')} canApprove={can('spec.approve')}
                onEdit={openEditor} onRevise={revise} onApprove={x => { setExceptionReason(''); setApproving(x); }} />
            </React.Fragment>
          ))}
        </div>
        {specs.length === 0 && !loading && <div className="text-center p-12 text-slate-500">{t('spec.none')}</div>}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 bg-slate-900 text-white shrink-0">
              <h3 className="font-semibold tracking-tight">{t('spec.editTitle', { material: editing.material, revision: revisionText(editing) })}</h3>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              <label className="flex items-center gap-3 text-sm">
                {t('spec.effectiveDate')}
                <input type="date" value={draftDate} onChange={e => setDraftDate(e.target.value)} className="px-3 py-1.5 border border-slate-300 rounded" />
              </label>
              {draftParams.map((p, i) => {
                const numeric = NUMERIC.includes(p.limit_kind);
                return (
                  <div key={i} className="flex flex-wrap gap-2 items-center bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <input type="text" aria-label={t('spec.paramName')} placeholder={t('spec.paramName')} dir="auto" value={p.name} onChange={e => setParam(i, { name: e.target.value })} className="flex-1 min-w-[160px] px-3 py-1.5 border border-slate-300 rounded text-sm" />
                    <select aria-label={t('spec.limitKind')} value={p.limit_kind} onChange={e => setParam(i, { limit_kind: e.target.value as LimitKind })} className="px-2 py-1.5 border border-slate-300 rounded text-sm">
                      {LIMIT_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                    {numeric ? (
                      <>
                        {p.limit_kind !== 'NMT' && <input type="number" step="any" aria-label={t('spec.lowerLimit')} placeholder={t('spec.lower')} dir="ltr" value={p.lower ?? ''} onChange={e => setParam(i, { lower: numberOrNull(e.target.value) })} className="w-24 px-3 py-1.5 border border-slate-300 rounded text-sm" />}
                        {p.limit_kind !== 'NLT' && <input type="number" step="any" aria-label={t('spec.upperLimit')} placeholder={t('spec.upper')} dir="ltr" value={p.upper ?? ''} onChange={e => setParam(i, { upper: numberOrNull(e.target.value) })} className="w-24 px-3 py-1.5 border border-slate-300 rounded text-sm" />}
                        <input type="number" min={0} max={10} step={1} aria-label={t('spec.decimals')} placeholder={t('spec.decimals')} title={t('spec.decimalsHint')} dir="ltr" value={p.decimals ?? ''} onChange={e => setParam(i, { decimals: numberOrNull(e.target.value) })} className="w-24 px-3 py-1.5 border border-slate-300 rounded text-sm" />
                        <input type="text" aria-label={t('spec.unit')} placeholder={t('spec.unit')} dir="auto" value={p.unit} onChange={e => setParam(i, { unit: e.target.value })} className="w-20 px-3 py-1.5 border border-slate-300 rounded text-sm" />
                      </>
                    ) : (
                      <input type="text" aria-label={t('spec.acceptance')} placeholder={t('spec.acceptance')} dir="auto" value={p.text ?? ''} onChange={e => setParam(i, { text: e.target.value })} className="flex-1 min-w-[200px] px-3 py-1.5 border border-slate-300 rounded text-sm" />
                    )}
                    <button type="button" aria-label={t('spec.remove')} onClick={() => setDraftParams(list => list.filter((_, j) => j !== i))} className="text-red-500 hover:bg-red-50 p-1.5 rounded">
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <div className="basis-full flex flex-wrap gap-2 items-center text-xs text-slate-600">
                      <input type="text" list="spec-method-codes" aria-label={t('spec.methodCode')} placeholder={t('spec.methodCodeOptional')} dir="ltr" value={p.method_code ?? ''} onChange={e => setParam(i, { method_code: e.target.value })} className="w-48 px-2 py-1 border border-slate-300 rounded" />
                      {numeric && (
                        <>
                          <input type="text" list="spec-formula-codes" aria-label={t('spec.formulaCode')} placeholder={t('spec.formulaCodeCalc')} dir="ltr" value={p.formula_code ?? ''} onChange={e => setParam(i, { formula_code: e.target.value })} className="w-48 px-2 py-1 border border-slate-300 rounded" />
                          <input type="number" min={1} max={100} step={1} aria-label={t('spec.replicates')} placeholder={t('spec.replicates')} dir="ltr" value={p.replicates ?? ''} onChange={e => setParam(i, { replicates: numberOrNull(e.target.value) ?? undefined })} className="w-24 px-2 py-1 border border-slate-300 rounded" />
                        </>
                      )}
                      <input type="text" aria-label={t('spec.stage')} placeholder={t('spec.stageOptional')} dir="auto" value={p.stage ?? ''} onChange={e => setParam(i, { stage: e.target.value })} className="w-36 px-2 py-1 border border-slate-300 rounded" />
                    </div>
                  </div>
                );
              })}
              <datalist id="spec-method-codes">{codes.methods.map(c => <option key={c} value={c} />)}</datalist>
              <datalist id="spec-formula-codes">{codes.formulas.map(c => <option key={c} value={c} />)}</datalist>
              <button type="button" onClick={() => setDraftParams(list => [...list, blankParameter()])} className="w-full py-2 border-2 border-dashed border-slate-300 rounded-lg text-sm text-slate-500 font-medium hover:border-blue-400 hover:text-blue-600">
                {t('spec.addParameter')}
              </button>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3 shrink-0">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 bg-slate-100 border border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-200">{t('common.cancel')}</button>
              <button type="button" onClick={save} className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700">{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      {approving && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode="SPECIFICATION_APPROVAL"
          action="approve"
          entityName={`${approving.material} ${revisionText(approving)}`}
          recordVersion={approving.version}
          onClose={() => setApproving(null)}
          onSign={approve}
        >
          {needsException && (
            <label className="block text-sm text-slate-700 mt-3">
              {t('spec.exceptionLabel', { n: approving.approval!.samplesInProgress })}
              <textarea aria-label={t('spec.exceptionReason')} value={exceptionReason} onChange={e => setExceptionReason(e.target.value)} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded text-sm" rows={2} />
            </label>
          )}
        </ElectronicSignatureModal>
      )}
    </div>
  );
}
