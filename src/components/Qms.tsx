// Quality management screen (roadmap M27, r2-qms): deviations, CAPA, change controls and audit findings.
// The server is the authority on every step: each record carries `nextMoves` (src/server/qms/states.ts via GET /qms/records/:id),
// and the screen offers exactly those, a signed one through the e-signature dialog with the step's own meaning code. What the user
// may decide (qms.approve, qms.settings) comes from GET /permissions/me; the server checks again on every call.
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ClipboardCheck, Link2, MessageSquare, Plus, Settings, ShieldCheck } from 'lucide-react';
import { useToast } from './ui/Toast';
import { EntityPicker } from './ui/EntityPicker';
import { ElectronicSignatureModal } from './ElectronicSignatureModal';
import { apiFetch, errorMessage } from '../lib/api';

export const QMS_TYPES = ['Deviation', 'CAPA', 'ChangeControl', 'AuditFinding'] as const;
export type QmsTypeName = (typeof QMS_TYPES)[number];
export const TYPE_LABEL: Record<QmsTypeName, string> = { Deviation: 'Deviation', CAPA: 'CAPA', ChangeControl: 'Change control', AuditFinding: 'Audit finding' };

const input = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none';
const button = 'px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50';
const primary = 'px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50';

/** A payload field of a type (src/server/qms/schemas.ts): free text, a calendar day, one of a list, or a yes/no flag. */
type PayloadField = { key: string; label: string; kind?: 'text' | 'date' | 'flag'; choices?: readonly string[] };

/** The payload fields of each type, as the editor shows them. The server validates them again with the type's strict schema. */
export const PAYLOAD_FIELDS: Record<QmsTypeName, PayloadField[]> = {
  Deviation: [{ key: 'occurredOn', label: 'Date of occurrence', kind: 'date' }, { key: 'area', label: 'Area' }, { key: 'immediateAction', label: 'Immediate action' }, { key: 'impactAssessment', label: 'Impact assessment' }, { key: 'rootCause', label: 'Root cause' }],
  CAPA: [{ key: 'kind', label: 'Kind', choices: ['Corrective', 'Preventive', 'Corrective and preventive'] }, { key: 'rootCause', label: 'Root cause' }, { key: 'plan', label: 'Action plan' }, { key: 'effectivenessCriteria', label: 'Effectiveness criteria' }],
  ChangeControl: [
    { key: 'changeType', label: 'Change type', choices: ['Specification', 'Role', 'Document', 'Equipment', 'Process', 'Other'] },
    { key: 'justification', label: 'Justification' }, { key: 'impactAssessment', label: 'Impact assessment' }, { key: 'implementationPlan', label: 'Implementation plan' },
    { key: 'emergency', label: 'Emergency change (approved by one QA signature before the review, reviewed retrospectively at closure)', kind: 'flag' },
  ],
  AuditFinding: [{ key: 'auditRef', label: 'Audit reference' }, { key: 'requirement', label: 'Requirement' }, { key: 'response', label: 'Response' }],
};

/** The editor of a record's payload. `value` holds what the record holds plus the user's unsaved edits. */
export function PayloadFields({ type, value, disabled, onChange }: {
  type: QmsTypeName; value: Record<string, unknown>; disabled: boolean; onChange: (key: string, v: unknown) => void;
}) {
  return (
    <>
      {PAYLOAD_FIELDS[type].map(f => {
        const v = value[f.key];
        if (f.kind === 'flag') {
          return (
            <label key={f.key} className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={v === true} disabled={disabled} onChange={e => onChange(f.key, e.target.checked)} /> {f.label}
            </label>
          );
        }
        return (
          <label key={f.key} className="block text-xs text-slate-600">{f.label}
            {f.choices ? (
              <select className={`${input} w-full`} value={typeof v === 'string' ? v : ''} disabled={disabled} onChange={e => onChange(f.key, e.target.value)}>
                <option value="">Not set</option>{f.choices.map(c => <option key={c}>{c}</option>)}
              </select>
            ) : f.kind === 'date' ? (
              <input className={`${input} w-full`} type="date" value={typeof v === 'string' ? v : ''} disabled={disabled} onChange={e => onChange(f.key, e.target.value)} />
            ) : (
              <textarea className={`${input} w-full`} rows={2} value={typeof v === 'string' ? v : ''} disabled={disabled} onChange={e => onChange(f.key, e.target.value)} />
            )}
          </label>
        );
      })}
    </>
  );
}

export interface NextMove { to: string; signed: boolean; meaningCode: string | null; qa: boolean; reasonRequired: boolean }
export interface QmsRecordRow {
  id: string; type: QmsTypeName; title: string; description: string; classification: string | null; state: string; ownerId: string | null;
  dueDate: string | null; payload: Record<string, unknown>; origin: string; createdBy: string; version: number;
  overdue: boolean; editable: boolean; final: boolean; nextMoves: NextMove[];
}
export interface QmsActionRow {
  id: string; recordId: string; title: string; description: string; ownerId: string; dueDate: string; status: string; evidenceRef: string | null;
  completedBy: string | null; version: number; overdue: boolean; recordTitle?: string; recordType?: string;
}
interface LinkRow { id: string; recordId: string; relation: string; targetType: string; targetId: string; createdBy: string }
interface CommentRow { id: string; authorId: string; text: string; createdAt: string }
interface CheckRow { id: string; result: string; evidence: string; checkedBy: string; checkedAt: string }
interface Detail { record: QmsRecordRow; actions: QmsActionRow[]; links: LinkRow[]; linkedFrom: LinkRow[]; comments: CommentRow[]; effectivenessChecks: CheckRow[] }

const STATE_STYLE = (r: { final: boolean; state: string }) =>
  r.state === 'Closed' ? 'bg-emerald-50 text-emerald-700' : r.final ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-700';

export const OverdueBadge = ({ overdue }: { overdue: boolean }) =>
  overdue ? <span className="ms-2 px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-700" aria-label="overdue">Overdue</span> : null;

/** The record list (rendered on its own by tests/api/qms-ui.test.ts). */
export function RecordTable({ records, selected, onSelect }: { records: readonly QmsRecordRow[]; selected?: string; onSelect: (id: string) => void }) {
  if (records.length === 0) return <p className="text-sm text-slate-500 p-4">No quality records match.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Number</th><th className="p-2">Type</th><th className="p-2">Title</th><th className="p-2">Class</th><th className="p-2">State</th><th className="p-2">Due</th></tr>
      </thead>
      <tbody>
        {records.map(r => (
          <tr key={r.id} className={`border-t border-slate-100 cursor-pointer ${selected === r.id ? 'bg-blue-50' : 'hover:bg-slate-50'}`} onClick={() => onSelect(r.id)}>
            <td className="p-2 font-mono"><button type="button" className="underline-offset-2 hover:underline" onClick={() => onSelect(r.id)}>{r.id}</button></td>
            <td className="p-2">{TYPE_LABEL[r.type]}</td>
            <td className="p-2">{r.title}</td>
            <td className="p-2">{r.classification ?? 'not classified'}</td>
            <td className="p-2"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATE_STYLE(r)}`}>{r.state}</span></td>
            <td className="p-2">{r.dueDate ?? 'none'}<OverdueBadge overdue={r.overdue} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The steps the server allows next. Quality-unit steps are shown only to holders of qms.approve. */
export function NextMoves({ moves, canApprove, onMove }: { moves: readonly NextMove[]; canApprove: boolean; onMove: (m: NextMove) => void }) {
  const shown = moves.filter(m => (!m.signed && !m.qa) || canApprove);
  if (shown.length === 0) return <p className="text-xs text-slate-500">No step available to you in this state.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map(m => (
        <button key={m.to} type="button" className={m.signed ? primary : button} onClick={() => onMove(m)}>
          {m.signed ? <ShieldCheck className="w-4 h-4 inline me-1" /> : null}{m.to}{m.signed ? ' (sign)' : ''}
        </button>
      ))}
    </div>
  );
}

/** Actions with their due dates; an Open action past its due date is flagged Overdue. */
export function ActionTable({ actions, me, canApprove, onComplete, onCancel }: {
  actions: readonly QmsActionRow[]; me: string; canApprove: boolean; onComplete: (a: QmsActionRow) => void; onCancel: (a: QmsActionRow) => void;
}) {
  if (actions.length === 0) return <p className="text-sm text-slate-500">No actions.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-start text-xs text-slate-500 uppercase">
        <tr><th className="p-2">Action</th><th className="p-2">Owner</th><th className="p-2">Due</th><th className="p-2">Status</th><th className="p-2">Evidence</th><th className="p-2" /></tr>
      </thead>
      <tbody>
        {actions.map(a => (
          <tr key={a.id} className="border-t border-slate-100">
            <td className="p-2"><span className="font-mono text-xs text-slate-500 me-1">{a.id}</span>{a.title}</td>
            <td className="p-2">{a.ownerId}</td>
            <td className="p-2">{a.dueDate}<OverdueBadge overdue={a.overdue} /></td>
            <td className="p-2">{a.status}</td>
            <td className="p-2">{a.evidenceRef ?? ''}</td>
            <td className="p-2 text-end space-x-1">
              {a.status === 'Open' && (a.ownerId === me || canApprove) && <button type="button" className={button} onClick={() => onComplete(a)}>Complete</button>}
              {a.status === 'Open' && canApprove && <button type="button" className={button} onClick={() => onCancel(a)}>Cancel</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Signing =
  | { kind: 'move'; id: string; to: string; meaningCode: string; version: number }
  | { kind: 'effectiveness'; id: string; result: string; evidence: string; version: number }
  | { kind: 'action'; id: string; evidenceRef: string; version: number }
  | { kind: 'settings'; on: boolean; version: number };

export function Qms({ token, user, recordId }: { token?: string; user: any; recordId?: string }) {
  const { toast } = useToast();
  const [permissions, setPermissions] = useState<string[]>([]);
  const [tab, setTab] = useState<'records' | 'actions' | 'settings'>('records');
  const [filter, setFilter] = useState<{ type: string; open: string; overdue: string }>({ type: '', open: 'true', overdue: '' });
  const [records, setRecords] = useState<QmsRecordRow[]>([]);
  const [selected, setSelected] = useState<string | undefined>(recordId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [actions, setActions] = useState<QmsActionRow[]>([]);
  const [settings, setSettings] = useState<{ changeControlRequired: boolean; version: number } | null>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [creating, setCreating] = useState<{ type: QmsTypeName; title: string; description: string; classification: string; dueDate: string } | null>(null);
  const [draft, setDraft] = useState<{ title: string; description: string; classification: string; payload: Record<string, unknown>; ownerId: string; dueDate: string; reason: string } | null>(null);
  const [newAction, setNewAction] = useState({ title: '', ownerId: '', dueDate: '' });
  const [newLink, setNewLink] = useState({ relation: 'related', targetType: 'Batch', targetId: '' });
  const [comment, setComment] = useState('');
  const [check, setCheck] = useState({ result: 'Effective', evidence: '' });
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  const canApprove = permissions.includes('qms.approve');
  const canSettings = permissions.includes('qms.settings');
  const me = user?.id ?? '';

  const fail = useCallback((err: unknown, fallback: string) => toast.error(errorMessage(err, fallback)), [toast]);

  const loadRecords = useCallback(async () => {
    const q = new URLSearchParams(Object.entries(filter as Record<string, string>).filter(([, v]) => v !== '')).toString();
    try { setRecords(await apiFetch<QmsRecordRow[]>(`/qms/records${q ? `?${q}` : ''}`)); } catch (err) { fail(err, 'The quality records could not be loaded.'); }
  }, [filter, fail]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await apiFetch<Detail>(`/qms/records/${encodeURIComponent(id)}`);
      setDetail(d);
      setDraft({ title: d.record.title, description: d.record.description, classification: d.record.classification ?? '', payload: { ...(d.record.payload ?? {}) }, ownerId: d.record.ownerId ?? '', dueDate: d.record.dueDate ?? '', reason: '' });
    } catch (err) { setDetail(null); fail(err, `Quality record ${id} could not be loaded.`); }
  }, [fail]);

  const loadActions = useCallback(async () => {
    try { setActions(await apiFetch<QmsActionRow[]>('/qms/actions?status=Open')); } catch (err) { fail(err, 'The actions could not be loaded.'); }
  }, [fail]);

  const loadSettings = useCallback(async () => {
    try { setSettings(await apiFetch<{ changeControlRequired: boolean; version: number }>('/qms/settings')); } catch (err) { fail(err, 'The QMS settings could not be loaded.'); }
  }, [fail]);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setPermissions(p.permissions)).catch(err => fail(err, 'Your permissions could not be loaded.'));
  }, [fail]);
  useEffect(() => { loadRecords(); }, [loadRecords]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);
  useEffect(() => { if (tab === 'actions') loadActions(); if (tab === 'settings') loadSettings(); }, [tab, loadActions, loadSettings]);

  const refresh = async () => { await loadRecords(); if (selected) await loadDetail(selected); if (tab === 'actions') await loadActions(); };

  const run = async (what: string, call: () => Promise<unknown>, done?: () => void) => {
    // The screen shows the record as the server now holds it (new version) before it reports success.
    try { await call(); done?.(); await refresh(); toast.success(`${what} (audit logged)`); return true; } catch (err) { fail(err, `${what} failed.`); return false; }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creating) return;
    try {
      const body: Record<string, unknown> = { type: creating.type, title: creating.title };
      if (creating.description) body.description = creating.description;
      if (creating.classification) body.classification = creating.classification;
      if (creating.dueDate) body.dueDate = creating.dueDate;
      const r = await apiFetch<QmsRecordRow>('/qms/records', { body });
      toast.success(`${TYPE_LABEL[r.type]} ${r.id} raised (audit logged)`);
      setCreating(null);
      await loadRecords();
      setSelected(r.id);
    } catch (err) { fail(err, 'The record could not be raised.'); }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !draft) return;
    const r = detail.record;
    const body: Record<string, unknown> = { expectedVersion: r.version };
    if (r.editable) {
      if (draft.title !== r.title) body.title = draft.title;
      if (draft.description !== r.description) body.description = draft.description;
      if (draft.classification && draft.classification !== r.classification) body.classification = draft.classification;
      // A flag is sent when it changed; text is sent when it was filled in and changed (an empty field is not set).
      const changed = Object.fromEntries(Object.entries(draft.payload).filter(([k, v]) => v !== '' && v !== (r.payload?.[k] ?? (typeof v === 'boolean' ? false : ''))));
      if (Object.keys(changed).length) body.payload = changed;
    }
    if (draft.ownerId && draft.ownerId !== r.ownerId) body.ownerId = draft.ownerId;
    if (draft.dueDate && draft.dueDate !== r.dueDate) body.dueDate = draft.dueDate;
    if (draft.reason.trim()) body.reason = draft.reason.trim();
    if (Object.keys(body).length === 1 || (Object.keys(body).length === 2 && body.reason)) { toast.error('There is nothing to change.'); return; }
    await run(`${r.id} saved`, () => apiFetch(`/qms/records/${r.id}`, { method: 'PUT', body }));
  };

  const onMove = async (m: NextMove) => {
    if (!detail) return;
    const r = detail.record;
    if (m.signed) { setSigning({ kind: 'move', id: r.id, to: m.to, meaningCode: m.meaningCode!, version: r.version }); return; }
    const typed = (draft?.reason ?? '').trim();
    const reason = m.reasonRequired ? typed : undefined;
    if (m.reasonRequired) {
      if (typed.length < 5) { toast.error(`${r.state} to ${m.to} needs a reason: write it in the "Reason" field first (at least 5 characters).`); return; }
    }
    await run(`${r.id} moved to ${m.to}`, () => apiFetch(`/qms/records/${r.id}/transition`, { body: { to: m.to, expectedVersion: r.version, ...(reason ? { reason } : {}) } }));
  };

  const sign = async (password: string, reason?: string, totpCode?: string) => {
    if (!signing) return;
    const cred = { password, ...(totpCode ? { totpCode } : {}), ...(reason ? { reason } : {}) };
    // When a call throws, the dialog shows the server's message and stays open so the signer can correct the entry.
    if (signing.kind === 'move') {
      await apiFetch(`/qms/records/${signing.id}/sign`, { body: { to: signing.to, expectedVersion: signing.version, ...cred } });
      toast.success(`${signing.id}: ${signing.to}, signed (audit logged)`);
    } else if (signing.kind === 'effectiveness') {
      await apiFetch(`/qms/records/${signing.id}/effectiveness`, { body: { result: signing.result, evidence: signing.evidence, expectedVersion: signing.version, ...cred } });
      toast.success(`Effectiveness check recorded: ${signing.result} (audit logged)`);
      setCheck({ result: 'Effective', evidence: '' });
    } else if (signing.kind === 'action') {
      await apiFetch(`/qms/actions/${signing.id}/complete`, { body: { evidenceRef: signing.evidenceRef, expectedVersion: signing.version, ...cred } });
      toast.success(`Action ${signing.id} completed, signed (audit logged)`);
    } else {
      await apiFetch('/qms/settings', { method: 'PUT', body: { changeControlRequired: signing.on, expectedVersion: signing.version, ...cred } });
      toast.success(`Change control is now ${signing.on ? 'required' : 'not required'} (signed, audit logged)`);
      await loadSettings();
    }
    setSigning(null);
    await refresh();
  };

  const r = detail?.record;
  const signingMeaning = signing?.kind === 'move' ? signing.meaningCode : signing?.kind === 'effectiveness' ? 'QMS_EFFECTIVENESS' : signing?.kind === 'action' ? 'QMS_ACTION_COMPLETION' : 'QMS_SETTING_CHANGE';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2"><ClipboardCheck className="w-5 h-5" /> Quality management</h1>
        <div className="flex gap-2" role="tablist">
          {(['records', 'actions', 'settings'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? primary : button} onClick={() => setTab(t)}>
              {t === 'records' ? 'Records' : t === 'actions' ? 'Open actions' : 'Settings'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'records' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
            <div className="flex flex-wrap gap-2 items-end">
              <label className="text-xs text-slate-600">Type<br />
                <select className={input} value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value })}>
                  <option value="">All</option>{QMS_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-600">Show<br />
                <select className={input} value={filter.open} onChange={e => setFilter({ ...filter, open: e.target.value })}>
                  <option value="true">Open</option><option value="false">Final</option><option value="">All</option>
                </select>
              </label>
              <label className="text-xs text-slate-600 flex items-center gap-1 pb-2">
                <input type="checkbox" checked={filter.overdue === 'true'} onChange={e => setFilter({ ...filter, overdue: e.target.checked ? 'true' : '' })} /> Overdue only
              </label>
              <button type="button" className={`${primary} ms-auto`} onClick={() => setCreating({ type: 'Deviation', title: '', description: '', classification: '', dueDate: '' })}>
                <Plus className="w-4 h-4 inline me-1" />Raise
              </button>
            </div>
            {creating && (
              <form onSubmit={create} className="border border-slate-200 rounded-lg p-3 space-y-2" aria-label="Raise a quality record">
                <div className="flex flex-wrap gap-2">
                  <select className={input} value={creating.type} onChange={e => setCreating({ ...creating, type: e.target.value as QmsTypeName })} aria-label="Type">
                    {QMS_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </select>
                  <select className={input} value={creating.classification} onChange={e => setCreating({ ...creating, classification: e.target.value })} aria-label="Classification">
                    <option value="">Classification later</option><option>Minor</option><option>Major</option><option>Critical</option>
                  </select>
                  <input className={input} type="date" value={creating.dueDate} onChange={e => setCreating({ ...creating, dueDate: e.target.value })} aria-label="Due date" />
                </div>
                <input className={`${input} w-full`} required placeholder="Title" value={creating.title} onChange={e => setCreating({ ...creating, title: e.target.value })} />
                <textarea className={`${input} w-full`} rows={3} placeholder="What happened (description)" value={creating.description} onChange={e => setCreating({ ...creating, description: e.target.value })} />
                <div className="flex gap-2 justify-end">
                  <button type="button" className={button} onClick={() => setCreating(null)}>Cancel</button>
                  <button type="submit" className={primary} disabled={!creating.title.trim()}>Raise</button>
                </div>
              </form>
            )}
            <RecordTable records={records} selected={selected} onSelect={setSelected} />
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
            {!r || !draft ? <p className="text-sm text-slate-500">Select a record.</p> : (
              <>
                <header className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-semibold">{r.id}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATE_STYLE(r)}`}>{r.state}</span>
                    <span className="text-xs text-slate-500">{TYPE_LABEL[r.type]} · {r.classification ?? 'not classified'} · version {r.version}{r.origin !== 'manual' ? ` · opened automatically (${r.origin.slice(5)})` : ''}</span>
                    <OverdueBadge overdue={r.overdue} />
                  </div>
                  {r.final && <p className="text-xs text-slate-500">This record is final and locked.</p>}
                  {!r.final && !r.editable && <p className="text-xs text-slate-500">The content was approved and is frozen; owner and due date can still change.</p>}
                </header>

                {!r.final && (
                  <form onSubmit={saveEdit} className="space-y-2" aria-label="Edit the record">
                    <input className={`${input} w-full`} value={draft.title} disabled={!r.editable} onChange={e => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
                    <textarea className={`${input} w-full`} rows={2} value={draft.description} disabled={!r.editable} onChange={e => setDraft({ ...draft, description: e.target.value })} aria-label="Description" />
                    <select className={input} value={draft.classification} disabled={!r.editable || !canApprove} title={canApprove ? undefined : 'The quality unit classifies a record'} onChange={e => setDraft({ ...draft, classification: e.target.value })} aria-label="Classification">
                      <option value="">Not classified</option><option>Minor</option><option>Major</option><option>Critical</option>
                    </select>
                    <PayloadFields type={r.type} value={draft.payload} disabled={!r.editable} onChange={(key, v) => setDraft({ ...draft, payload: { ...draft.payload, [key]: v } })} />
                    {r.type === 'ChangeControl' && r.payload?.emergency === true && <p className="text-xs font-semibold text-amber-700">Emergency change: approved by one signature, reviewed retrospectively at closure.</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <EntityPicker kind="users" label="Owner" value={draft.ownerId} onChange={id => setDraft({ ...draft, ownerId: id })} />
                      <label className="text-xs text-slate-600">Due date<input className={`${input} w-full`} type="date" value={draft.dueDate} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} /></label>
                    </div>
                    <input className={`${input} w-full`} placeholder="Reason (for the edit, or a step that needs one)" value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} aria-label="Reason" />
                    <div className="flex justify-end"><button type="submit" className={button}>Save</button></div>
                  </form>
                )}

                {!r.final && <NextMoves moves={r.nextMoves} canApprove={canApprove} onMove={onMove} />}

                {r.type === 'CAPA' && r.state === 'Effectiveness Check' && canApprove && (
                  <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                    <h3 className="text-sm font-semibold">Effectiveness check</h3>
                    <select className={input} value={check.result} onChange={e => setCheck({ ...check, result: e.target.value })} aria-label="Result">
                      <option>Effective</option><option>Not effective</option>
                    </select>
                    <textarea className={`${input} w-full`} rows={2} placeholder="Evidence against the effectiveness criteria" value={check.evidence} onChange={e => setCheck({ ...check, evidence: e.target.value })} />
                    <button type="button" className={primary} disabled={!check.evidence.trim()}
                      onClick={() => setSigning({ kind: 'effectiveness', id: r.id, result: check.result, evidence: check.evidence.trim(), version: r.version })}>Record (sign)</button>
                  </div>
                )}
                {detail.effectivenessChecks.length > 0 && (
                  <ul className="text-xs text-slate-600 space-y-1">
                    {detail.effectivenessChecks.map(c => <li key={c.id}>{c.checkedAt.slice(0, 10)} {c.result} by {c.checkedBy}: {c.evidence}</li>)}
                  </ul>
                )}

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> Actions</h3>
                  <ActionTable actions={detail.actions} me={me} canApprove={canApprove}
                    onComplete={a => {
                      const ref = (evidence[a.id] ?? '').trim();
                      if (!ref) { toast.error(`Write the evidence for ${a.id} first (where the record of the work is).`); return; }
                      setSigning({ kind: 'action', id: a.id, evidenceRef: ref, version: a.version });
                    }}
                    onCancel={a => {
                      const reason = (draft.reason ?? '').trim();
                      if (reason.length < 5) { toast.error('Write the reason for cancelling in the "Reason" field first (at least 5 characters).'); return; }
                      run(`Action ${a.id} cancelled`, () => apiFetch(`/qms/actions/${a.id}/cancel`, { body: { reason, expectedVersion: a.version } }));
                    }} />
                  {detail.actions.filter(a => a.status === 'Open' && (a.ownerId === me || canApprove)).map(a => (
                    <input key={a.id} className={`${input} w-full`} placeholder={`Evidence for ${a.id} (document, record or logbook reference)`} value={evidence[a.id] ?? ''}
                      onChange={e => setEvidence({ ...evidence, [a.id]: e.target.value })} />
                  ))}
                  {!r.final && (
                    <form className="flex flex-wrap gap-2 items-end" aria-label="Add an action" onSubmit={e => {
                      e.preventDefault();
                      run('Action added', () => apiFetch(`/qms/records/${r.id}/actions`, { body: newAction }), () => setNewAction({ title: '', ownerId: '', dueDate: '' }));
                    }}>
                      <input className={input} required placeholder="New action" value={newAction.title} onChange={e => setNewAction({ ...newAction, title: e.target.value })} />
                      <EntityPicker kind="users" label="Owner" value={newAction.ownerId} onChange={id => setNewAction({ ...newAction, ownerId: id })} required />
                      <input className={input} type="date" required value={newAction.dueDate} onChange={e => setNewAction({ ...newAction, dueDate: e.target.value })} aria-label="Action due date" />
                      <button type="submit" className={button} disabled={!newAction.title || !newAction.ownerId || !newAction.dueDate}>Add</button>
                    </form>
                  )}
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1"><Link2 className="w-4 h-4" /> Links</h3>
                  <ul className="text-sm space-y-1">
                    {detail.links.map(l => <li key={l.id}><span className="text-xs text-slate-500">{l.relation}</span> {l.targetType} <span className="font-mono">{l.targetId}</span></li>)}
                    {detail.linkedFrom.map(l => <li key={l.id}><span className="text-xs text-slate-500">{l.relation} of</span> <button type="button" className="font-mono underline" onClick={() => setSelected(l.recordId)}>{l.recordId}</button></li>)}
                    {detail.links.length + detail.linkedFrom.length === 0 && <li className="text-slate-500">No links.</li>}
                  </ul>
                  {!r.final && (
                    <form className="flex flex-wrap gap-2" aria-label="Add a link" onSubmit={e => {
                      e.preventDefault();
                      run('Link added', () => apiFetch(`/qms/records/${r.id}/links`, { body: newLink }), () => setNewLink({ ...newLink, targetId: '' }));
                    }}>
                      <select className={input} value={newLink.relation} onChange={e => setNewLink({ ...newLink, relation: e.target.value, targetType: e.target.value === 'capa' ? 'QmsRecord' : newLink.targetType })} aria-label="Relation">
                        <option value="related">related to</option><option value="capa">CAPA</option><option value="affects">affects (change control)</option>
                      </select>
                      <select className={input} value={newLink.targetType} onChange={e => setNewLink({ ...newLink, targetType: e.target.value })} aria-label="Target type">
                        {['Batch', 'Sample', 'OOS', 'Specification', 'User', 'Instrument', 'Document', 'QmsRecord'].map(t => <option key={t}>{t}</option>)}
                      </select>
                      <input className={input} required placeholder="Id" value={newLink.targetId} onChange={e => setNewLink({ ...newLink, targetId: e.target.value })} aria-label="Target id" />
                      <button type="submit" className={button} disabled={!newLink.targetId.trim()}>Link</button>
                    </form>
                  )}
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1"><MessageSquare className="w-4 h-4" /> Comments</h3>
                  <ul className="text-sm space-y-1">
                    {detail.comments.map(c => <li key={c.id}><span className="text-xs text-slate-500">{c.createdAt.slice(0, 16).replace('T', ' ')} {c.authorId}</span> {c.text}</li>)}
                    {detail.comments.length === 0 && <li className="text-slate-500">No comments.</li>}
                  </ul>
                  {!r.final && (
                    <form className="flex gap-2" aria-label="Add a comment" onSubmit={e => {
                      e.preventDefault();
                      run('Comment added', () => apiFetch(`/qms/records/${r.id}/comments`, { body: { text: comment } }), () => setComment(''));
                    }}>
                      <input className={`${input} flex-1`} required placeholder="Comment" value={comment} onChange={e => setComment(e.target.value)} aria-label="Comment" />
                      <button type="submit" className={button} disabled={!comment.trim()}>Add</button>
                    </form>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {tab === 'actions' && (
        <section className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500 mb-2">Open actions of every record, earliest due first. Select the record to complete one.</p>
          <table className="w-full text-sm">
            <thead className="text-start text-xs text-slate-500 uppercase"><tr><th className="p-2">Action</th><th className="p-2">Record</th><th className="p-2">Owner</th><th className="p-2">Due</th></tr></thead>
            <tbody>
              {actions.map(a => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="p-2">{a.title}</td>
                  <td className="p-2"><button type="button" className="font-mono underline" onClick={() => { setTab('records'); setSelected(a.recordId); }}>{a.recordId}</button> {a.recordTitle}</td>
                  <td className="p-2">{a.ownerId}</td>
                  <td className="p-2">{a.dueDate}<OverdueBadge overdue={a.overdue} /></td>
                </tr>
              ))}
              {actions.length === 0 && <tr><td className="p-2 text-slate-500" colSpan={4}>No open actions.</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'settings' && (
        <section className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
          <h2 className="font-semibold flex items-center gap-2"><Settings className="w-4 h-4" /> Change control</h2>
          {settings && (
            <>
              <p className="text-sm">Change control is <strong>{settings.changeControlRequired ? 'required' : 'not required'}</strong>.
                {' '}When it is required, approving a specification and approving a role change need an Approved change control that affects the record (otherwise the server answers CHANGE_REQUIRED).</p>
              {canSettings
                ? <button type="button" className={primary} onClick={() => setSigning({ kind: 'settings', on: !settings.changeControlRequired, version: settings.version })}>
                    {settings.changeControlRequired ? 'Stop requiring change control (sign)' : 'Require change control (sign)'}
                  </button>
                : <p className="text-xs text-slate-500">Only the quality unit can change this setting.</p>}
            </>
          )}
        </section>
      )}

      {signing && (
        <ElectronicSignatureModal
          user={user}
          token={token}
          meaningCode={signingMeaning}
          action={signing.kind === 'move' ? `move to ${signing.to}` : signing.kind === 'effectiveness' ? 'effectiveness check' : signing.kind === 'action' ? 'action completion' : 'change-control setting'}
          entityName={signing.kind === 'settings' ? 'QMS settings' : signing.id}
          recordVersion={signing.version}
          onClose={() => setSigning(null)}
          onSign={sign}
        />
      )}
    </div>
  );
}
