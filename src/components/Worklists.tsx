/**
 * Worklists and batch runs (roadmap M33): #/worklists (the list, grouped by method and instrument, and the workload view) and
 * #/worklists/<WL-id> (one run: its items in run order, the assignment of each, grid entry, the run-sequence CSV and the bench sheet).
 *
 *   groupWorklists / WorklistGroups   the list as method -> instrument -> worklists
 *   WorkloadTables                    per analyst and per instrument: planned, on the bench, pending, overdue
 *   ItemsTable                        the run in sequence; for a Released worklist each Sample item has a value cell (grid entry)
 *   buildCells                        what a grid save sends: only changed cells, the cell's own reason, held back until it has one
 *
 * What the user may do comes from GET /permissions/me; the server decides again on every call. A change of a Released worklist asks for
 * its reason first (the server refuses and audits it otherwise). Every outcome is a toast or an inline message (no silent failure).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ListChecks } from 'lucide-react';
import { apiFetch, errorMessage, type SelfUser } from '../lib/api';
import { hasPermission, type PermissionCode } from '../lib/permissions';
import { formatHash, navigate } from '../lib/router';
import { Badge, stateTone } from './ui/Badge';
import { Button } from './ui/Button';
import { EntityPicker } from './ui/EntityPicker';
import { Field, fieldErrors, inputClass } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

// ---- types (the answers of /api/worklists) -----------------------------------------------------------------------------------

export interface WorklistRow {
  id: string; title: string; methodCode: string; instrumentId: string | null; instrumentName: string | null; plannedDate: string; status: string;
  itemCount: number; sampleItems: number; pending: number; version: number;
}
export interface WorklistItem {
  id: string; position: number; kind: string; sampleId: string | null; resultId: string | null; label: string | null; assigneeId: string | null;
  assigneeName: string | null; status: string; version: number; material: string | null; batch: string | null; parameter: string | null;
  value: string | null; unit: string | null; resultVersion: number | null; isOos: boolean | null; removedReason: string | null;
}
export interface WorklistDetail extends Omit<WorklistRow, 'itemCount' | 'sampleItems' | 'pending' | 'instrumentName'> {
  notes: string | null; instrument: { id: string; name: string; type: string; status: string; calibrationDueDate: string } | null; items: WorklistItem[];
  closeReason: string | null;
}
interface Candidate { resultId: string; sampleId: string; parameter: string; unit: string | null; material: string; batch: string; state: string }
export interface Workload {
  today: string;
  analysts: Array<{ userId: string; name: string; releasedWorklists: number; releasedItems: number; pending: number; overdue: number; draftWorklists: number; draftItems: number; nextPlannedDate: string | null }>;
  instruments: Array<{ instrumentId: string; name: string; releasedWorklists: number; draftWorklists: number; items: number; nextPlannedDate: string | null }>;
}
export interface GridFailure { index: number; resultId: string; parameter: string | null; status: number; code: string; error: string }

const STATUSES = ['Draft', 'Released', 'Completed', 'Cancelled'] as const;
const KINDS = ['Sample', 'Standard', 'Blank', 'SST', 'Control'] as const;
const isBlank = (v: string | null | undefined) => v === null || v === undefined || v === '';

// ---- pure pieces ---------------------------------------------------------------------------------------------------------------

/** method -> instrument -> worklists, in a stable order (method, instrument, planned date, id; plain comparison, not locale dependent). */
export function groupWorklists(rows: readonly WorklistRow[]) {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const methods = new Map<string, Map<string, WorklistRow[]>>();
  for (const r of rows) {
    const byInstrument = methods.get(r.methodCode) ?? new Map<string, WorklistRow[]>();
    const key = r.instrumentName ? `${r.instrumentName} (${r.instrumentId})` : 'No instrument named';
    byInstrument.set(key, [...(byInstrument.get(key) ?? []), r]);
    methods.set(r.methodCode, byInstrument);
  }
  return [...methods.entries()].sort((a, b) => cmp(a[0], b[0])).map(([methodCode, byInstrument]) => ({
    methodCode,
    instruments: [...byInstrument.entries()].sort((a, b) => cmp(a[0], b[0])).map(([instrument, worklists]) => ({
      instrument, worklists: [...worklists].sort((a, b) => cmp(a.plannedDate, b.plannedDate) || cmp(a.id, b.id)),
    })),
  }));
}

export interface CellEdit { value: string; reason: string }

/**
 * What a grid save sends. A cell is sent when the typed value differs from the recorded one. A cell that already holds a value needs
 * its own reason (ALCOA+): until it has one it is held back and named, and nothing is sent for it. `instrumentId` is the worklist's.
 */
export function buildCells(items: readonly WorklistItem[], edits: Readonly<Record<string, CellEdit>>, instrumentId?: string | null) {
  const cells: Array<Record<string, unknown>> = [];
  const held: Array<{ resultId: string; message: string }> = [];
  for (const item of items) {
    if (item.status !== 'Active' || !item.resultId) continue;
    const edit = edits[item.resultId];
    const value = edit?.value.trim() ?? '';
    if (!edit || value === '' || value === (item.value ?? '')) continue;
    const reason = edit.reason.trim();
    if (!isBlank(item.value) && reason.length < 5) {
      held.push({ resultId: item.resultId, message: `${item.parameter}: changing a value already entered needs a reason of at least 5 characters.` });
      continue;
    }
    cells.push({
      resultId: item.resultId, value, expectedVersion: item.resultVersion,
      ...(instrumentId ? { instrumentId } : {}), ...(reason ? { reason } : {}),
    });
  }
  return { cells, held };
}

const rangeText = (n: string | null) => n ?? '-';

// ---- presentational tables ------------------------------------------------------------------------------------------------------

export function WorklistGroups({ rows }: { rows: readonly WorklistRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-600">No worklist matches. Plan one with "New worklist".</p>;
  return (
    <div className="space-y-6">
      {groupWorklists(rows).map(m => (
        <section key={m.methodCode} aria-label={`Method ${m.methodCode}`} className="space-y-2">
          <h3 className="text-sm font-bold text-slate-800">Method {m.methodCode}</h3>
          {m.instruments.map(i => (
            <div key={i.instrument} className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <caption className="text-start px-3 pt-2 text-xs font-semibold text-slate-600">{i.instrument}</caption>
                <thead><tr className="text-start text-slate-500 border-b"><th scope="col" className="px-3 py-1">Worklist</th><th scope="col">Title</th><th scope="col">Planned</th><th scope="col">Status</th><th scope="col">Items</th><th scope="col">Pending</th></tr></thead>
                <tbody>
                  {i.worklists.map(w => (
                    <tr key={w.id} className="border-b last:border-0">
                      <td className="px-3 py-1 font-mono"><a className="text-blue-800 underline" href={formatHash('worklists', [w.id])}>{w.id}</a></td>
                      <td>{w.title}</td><td>{w.plannedDate}</td><td><Badge tone={stateTone(w.status)}>{w.status}</Badge></td>
                      <td>{w.itemCount}</td><td>{w.status === 'Released' ? w.pending : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function WorkloadTables({ data }: { data: Workload }) {
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <caption className="text-start px-3 pt-2 font-semibold text-slate-700">By analyst (today is {data.today})</caption>
          <thead><tr className="text-start text-slate-500 border-b">
            <th scope="col" className="px-3 py-1">Analyst</th><th scope="col">Worklists on the bench</th><th scope="col">Items</th><th scope="col">Pending</th><th scope="col">Overdue</th><th scope="col">Planned (Draft)</th><th scope="col">Next planned date</th>
          </tr></thead>
          <tbody>
            {data.analysts.length === 0 && <tr><td colSpan={7} className="px-3 py-2 text-slate-600">No analyst has work assigned in this period.</td></tr>}
            {data.analysts.map(a => (
              <tr key={a.userId} className="border-b last:border-0">
                <th scope="row" className="px-3 py-1 text-start font-medium">{a.name}</th>
                <td>{a.releasedWorklists}</td><td>{a.releasedItems}</td><td>{a.pending}</td>
                <td>{a.overdue > 0 ? <Badge tone="danger">{a.overdue} overdue</Badge> : 0}</td>
                <td>{a.draftWorklists} worklist(s), {a.draftItems} item(s)</td><td>{rangeText(a.nextPlannedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <caption className="text-start px-3 pt-2 font-semibold text-slate-700">By instrument</caption>
          <thead><tr className="text-start text-slate-500 border-b"><th scope="col" className="px-3 py-1">Instrument</th><th scope="col">Released</th><th scope="col">Draft</th><th scope="col">Items</th><th scope="col">Next planned date</th></tr></thead>
          <tbody>
            {data.instruments.length === 0 && <tr><td colSpan={5} className="px-3 py-2 text-slate-600">No instrument is planned in this period.</td></tr>}
            {data.instruments.map(i => (
              <tr key={i.instrumentId} className="border-b last:border-0">
                <th scope="row" className="px-3 py-1 text-start font-medium">{i.name} <span className="font-mono text-xs text-slate-500">{i.instrumentId}</span></th>
                <td>{i.releasedWorklists}</td><td>{i.draftWorklists}</td><td>{i.items}</td><td>{rangeText(i.nextPlannedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface ItemsTableProps {
  items: readonly WorklistItem[];
  status: string;
  canManage: boolean;
  canEnter: boolean;
  userId: string;
  edits: Readonly<Record<string, CellEdit>>;
  failures: Readonly<Record<string, string>>;
  onEdit: (resultId: string, edit: CellEdit) => void;
  onMove: (itemId: string, direction: -1 | 1) => void;
  onReassign: (item: WorklistItem) => void;
  onRemove: (item: WorklistItem) => void;
}

export function ItemsTable({ items, status, canManage, canEnter, userId, edits, failures, onEdit, onMove, onReassign, onRemove }: ItemsTableProps) {
  const active = items.filter(i => i.status === 'Active');
  const open = status === 'Draft' || status === 'Released';
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <caption className="sr-only">Run sequence</caption>
        <thead><tr className="text-start text-slate-500 border-b">
          <th scope="col" className="px-3 py-1">#</th><th scope="col">Kind</th><th scope="col">Sample / label</th><th scope="col">Parameter</th><th scope="col">Analyst</th><th scope="col">Result</th><th scope="col"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          {items.map(item => {
            const n = active.indexOf(item);
            const removed = item.status === 'Removed';
            const mine = item.assigneeId === userId;
            const edit = item.resultId ? edits[item.resultId] : undefined;
            const failure = item.resultId ? failures[item.resultId] : undefined;
            const typing = status === 'Released' && !removed && !!item.resultId && canEnter;
            const needsReason = typing && !isBlank(item.value) && !!edit && edit.value.trim() !== '' && edit.value.trim() !== item.value;
            return (
              <tr key={item.id} className={`border-b last:border-0 align-top ${removed ? 'text-slate-400 line-through' : ''}`} data-status={item.status}>
                <td className="px-3 py-1">{removed ? '-' : n + 1}</td>
                <td>{item.kind}</td>
                <td>{item.kind === 'Sample' ? <><a className="font-mono text-blue-800 underline" href={formatHash('samples', [item.sampleId ?? ''])}>{item.sampleId}</a><div className="text-xs text-slate-500">{item.material} / {item.batch}</div></> : item.label}</td>
                <td>{item.parameter ?? '-'}</td>
                <td>{item.assigneeName ?? '-'}{mine && <span className="text-xs text-slate-500"> (you)</span>}</td>
                <td>
                  {item.kind !== 'Sample' || removed ? (removed ? `Removed: ${item.removedReason}` : '-') : (
                    <div className="space-y-1">
                      {typing && mine ? (
                        <input
                          aria-label={`Result for ${item.parameter} of ${item.sampleId}`} className={`${inputClass} !py-1 w-32`} value={edit?.value ?? ''} placeholder={item.value ?? 'Enter value'}
                          onChange={e => onEdit(item.resultId!, { value: e.target.value, reason: edit?.reason ?? '' })} aria-invalid={failure ? true : undefined}
                        />
                      ) : null}
                      <span className={item.isOos ? 'font-semibold text-red-700' : ''}>{isBlank(item.value) ? <span className="text-slate-500">Not entered</span> : `${item.value}${item.unit ? ` ${item.unit}` : ''}`}{item.isOos ? ' (OOS)' : ''}</span>
                      {typing && !mine && <div className="text-xs text-slate-500">Only {item.assigneeName ?? 'the assignee'} enters this result.</div>}
                      {needsReason && (
                        <input aria-label={`Reason for changing ${item.parameter}`} className={`${inputClass} !py-1`} placeholder="Reason for change" value={edit?.reason ?? ''}
                          onChange={e => onEdit(item.resultId!, { value: edit?.value ?? '', reason: e.target.value })} />
                      )}
                      {failure && <p role="alert" className="text-xs font-medium text-red-700">{failure}</p>}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  {canManage && open && !removed && (
                    <span className="inline-flex gap-1">
                      <Button size="sm" aria-label={`Move item ${n + 1} up`} disabled={n === 0} onClick={() => onMove(item.id, -1)}><ArrowUp className="w-3 h-3" aria-hidden="true" /></Button>
                      <Button size="sm" aria-label={`Move item ${n + 1} down`} disabled={n === active.length - 1} onClick={() => onMove(item.id, 1)}><ArrowDown className="w-3 h-3" aria-hidden="true" /></Button>
                      <Button size="sm" onClick={() => onReassign(item)}>{item.kind === 'Sample' ? 'Reassign' : 'Relabel'}</Button>
                      <Button size="sm" variant="danger" onClick={() => onRemove(item)}>Remove</Button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- dialogs ---------------------------------------------------------------------------------------------------------------------

/** Asks for a reason (required once the worklist is Released) before a change; `children` holds the change's own fields. */
function ChangeDialog({ title, requireReason, busy, onClose, onConfirm, children, confirmLabel = 'Confirm' }: {
  title: string; requireReason: boolean; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void; children?: React.ReactNode; confirmLabel?: string;
}) {
  const [reason, setReason] = useState('');
  const short = requireReason && reason.trim().length < 5;
  return (
    <Modal open title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={short} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
    </>}>
      <div className="space-y-3">
        {children}
        <Field label={requireReason ? 'Reason for the change' : 'Reason (optional on a Draft)'} required={requireReason} hint={requireReason ? 'The worklist is Released, so its membership is frozen: every change needs a reason and is audited.' : undefined}>
          {p => <textarea {...p} className={inputClass} rows={2} value={reason} onChange={e => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function NewWorklistDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const [methods, setMethods] = useState<Array<{ code: string; title: string; status: string; instrumentType?: string | null }>>([]);
  const [instruments, setInstruments] = useState<Array<{ id: string; name: string; type: string; status: string; calibrationDueDate: string }>>([]);
  const [form, setForm] = useState({ title: '', methodCode: '', instrumentId: '', plannedDate: new Date().toISOString().slice(0, 10), notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiFetch<any[]>('/methods').then(r => setMethods(r.filter(m => m.status === 'Effective'))).catch(e => toast.error(`The methods could not be loaded: ${errorMessage(e)}`));
    apiFetch<any[]>('/instruments').then(setInstruments).catch(e => toast.error(`The instruments could not be loaded: ${errorMessage(e)}`));
  }, [toast]);
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));
  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      const body: Record<string, string> = { title: form.title, methodCode: form.methodCode, plannedDate: form.plannedDate };
      if (form.instrumentId) body.instrumentId = form.instrumentId;
      if (form.notes.trim()) body.notes = form.notes;
      const created = await apiFetch<{ id: string }>('/worklists', { body });
      toast.success(`Worklist ${created.id} planned.`);
      onCreated(created.id);
    } catch (e) { setErrors(fieldErrors(e)); toast.error(errorMessage(e, 'The worklist could not be planned.')); } finally { setBusy(false); }
  };
  return (
    <Modal open title="New worklist" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Plan worklist</Button></>}>
      <div className="space-y-3">
        <Field label="Title" required error={errors.title}>{p => <input {...p} className={inputClass} value={form.title} onChange={e => set('title')(e.target.value)} />}</Field>
        <Field label="Method" required error={errors.methodCode} hint="Only methods with an Effective revision.">{p => (
          <select {...p} className={inputClass} value={form.methodCode} onChange={e => set('methodCode')(e.target.value)}>
            <option value="">Choose a method</option>
            {methods.map(m => <option key={m.code} value={m.code}>{m.code}: {m.title}</option>)}
          </select>)}
        </Field>
        <Field label="Instrument" error={errors.instrumentId} hint="Active and within calibration; of the type the method is run on.">{p => (
          <select {...p} className={inputClass} value={form.instrumentId} onChange={e => set('instrumentId')(e.target.value)}>
            <option value="">No instrument named</option>
            {instruments.filter(i => i.status === 'Active').map(i => <option key={i.id} value={i.id}>{i.name} ({i.type}), calibration due {i.calibrationDueDate}</option>)}
          </select>)}
        </Field>
        <Field label="Planned date" required error={errors.plannedDate}>{p => <input {...p} type="date" className={inputClass} value={form.plannedDate} onChange={e => set('plannedDate')(e.target.value)} />}</Field>
        <Field label="Notes" error={errors.notes}>{p => <textarea {...p} className={inputClass} rows={2} value={form.notes} onChange={e => set('notes')(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

// ---- the list ----------------------------------------------------------------------------------------------------------------------

function WorklistIndex() {
  const { toast } = useToast();
  const [can, setCan] = useState<string[] | null>(null);
  const [tab, setTab] = useState<'list' | 'workload'>('list');
  const [rows, setRows] = useState<WorklistRow[] | null>(null);
  const [workload, setWorkload] = useState<Workload | null>(null);
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setCan(p.permissions)).catch(e => { setCan([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (status) q.set('status', status);
      if (method.trim()) q.set('methodCode', method.trim());
      setRows(await apiFetch<WorklistRow[]>(`/worklists${q.toString() ? `?${q}` : ''}`));
      setWorkload(await apiFetch<Workload>('/worklists/workload'));
      setLoadError(null);
    } catch (e) { setLoadError(errorMessage(e, 'The worklists could not be loaded.')); }
  }, [status, method]);
  useEffect(() => { void load(); }, [load]);

  const canManage = hasPermission(can, 'worklist.manage');
  return (
    <section aria-labelledby="worklists-title" className="space-y-4">
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <h2 id="worklists-title" className="text-xl font-bold text-slate-800 flex items-center gap-2"><ListChecks className="w-5 h-5" aria-hidden="true" /> Worklists</h2>
        <div className="flex items-center gap-2">
          <Button variant={tab === 'list' ? 'primary' : 'secondary'} size="sm" aria-pressed={tab === 'list'} onClick={() => setTab('list')}>Worklists</Button>
          <Button variant={tab === 'workload' ? 'primary' : 'secondary'} size="sm" aria-pressed={tab === 'workload'} onClick={() => setTab('workload')}>Workload</Button>
          {canManage && <Button variant="primary" size="sm" onClick={() => setCreating(true)}>New worklist</Button>}
        </div>
      </header>
      {loadError && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{loadError} <Button size="sm" onClick={() => void load()}>Retry</Button></p>}
      {tab === 'list' && (
        <>
          <div className="flex flex-wrap gap-3">
            <Field label="Status" className="w-44">{p => (
              <select {...p} className={inputClass} value={status} onChange={e => setStatus(e.target.value)}>
                <option value="">All</option>{STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>)}
            </Field>
            <Field label="Method code" className="w-56">{p => <input {...p} className={inputClass} value={method} onChange={e => setMethod(e.target.value)} />}</Field>
          </div>
          {rows ? <WorklistGroups rows={rows} /> : <p aria-busy="true" className="text-sm text-slate-600">Loading worklists...</p>}
        </>
      )}
      {tab === 'workload' && (workload ? <WorkloadTables data={workload} /> : <p aria-busy="true" className="text-sm text-slate-600">Loading workload...</p>)}
      {creating && <NewWorklistDialog onClose={() => setCreating(false)} onCreated={id => { setCreating(false); navigate(formatHash('worklists', [id])); }} />}
    </section>
  );
}

// ---- one worklist ------------------------------------------------------------------------------------------------------------------

type Pending =
  | { kind: 'reassign'; item: WorklistItem }
  | { kind: 'remove'; item: WorklistItem }
  | { kind: 'move'; itemId: string; direction: -1 | 1 }
  | { kind: 'release' } | { kind: 'complete' } | { kind: 'cancel' };

async function saveBlob(path: string, fileName: string) {
  const blob = await apiFetch<Blob>(path, { parse: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function WorklistView({ id, user }: { id: string; user: SelfUser }) {
  const { toast } = useToast();
  const [can, setCan] = useState<string[] | null>(null);
  const [w, setW] = useState<WorklistDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, CellEdit>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    apiFetch<{ permissions: string[] }>('/permissions/me').then(p => setCan(p.permissions)).catch(e => { setCan([]); toast.error(`Your permissions could not be loaded: ${errorMessage(e)}`); });
  }, [toast]);
  const load = useCallback(async () => {
    try { setW(await apiFetch<WorklistDetail>(`/worklists/${encodeURIComponent(id)}`)); setLoadError(null); }
    catch (e) { setLoadError(errorMessage(e, 'The worklist could not be loaded.')); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const has = (code: PermissionCode) => hasPermission(can, code);
  const run = async (what: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await work(); if (done) toast.success(done); setPending(null); await load(); return true; }
    catch (e) { toast.error(`${what}: ${errorMessage(e)}`); await load(); return false; }
    finally { setBusy(false); }
  };

  if (loadError) return <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{loadError} <Button size="sm" onClick={() => void load()}>Retry</Button></p>;
  if (!w) return <p aria-busy="true" className="text-sm text-slate-600">Loading worklist...</p>;

  const released = w.status === 'Released';
  const open = w.status === 'Draft' || released;
  const active = w.items.filter(i => i.status === 'Active');
  const base = `/worklists/${encodeURIComponent(w.id)}`;

  const saveGrid = async () => {
    const { cells, held } = buildCells(w.items, edits, w.instrumentId);
    if (held.length > 0) {
      setFailures(Object.fromEntries(held.map(h => [h.resultId, h.message])));
      toast.error(`${held.length} cell(s) need a reason before they can be saved. Nothing was sent for them.`);
      if (cells.length === 0) return;
    }
    if (cells.length === 0) { toast.info('There is nothing to save: no value was changed.'); return; }
    setBusy(true);
    try {
      const out = await apiFetch<{ saved: Array<{ id: string }>; failed: GridFailure[] }>(`${base}/grid`, { method: 'PUT', body: { cells } });
      const failed = Object.fromEntries([...held.map(h => [h.resultId, h.message]), ...out.failed.map(f => [f.resultId, `${f.status}: ${f.error}`])]);
      setFailures(failed);
      const savedIds = new Set(out.saved.map(s => s.id));
      setEdits(prev => Object.fromEntries(Object.entries(prev).filter(([rid]) => !savedIds.has(rid))));
      if (out.failed.length > 0) toast.error(`${out.saved.length} cell(s) saved, ${out.failed.length} refused. The refused cells show why; nothing was saved for them.`);
      else toast.success(`${out.saved.length} result(s) saved.`);
    } catch (e) { toast.error(`The grid could not be saved: ${errorMessage(e)}`); } finally { setBusy(false); await load(); }
  };

  const benchSheet = async () => {
    setBusy(true);
    try {
      const { jobId } = await apiFetch<{ jobId: string }>(`${base}/bench-sheet`, { body: {} });
      toast.info('The bench sheet is being made.');
      for (let n = 0; n < 60; n++) {
        try { await saveBlob(`/worklists/bench-sheets/${encodeURIComponent(jobId)}`, `${w.id}-bench-sheet.pdf`); toast.success('Bench sheet downloaded.'); return; }
        catch (e: any) { if (e?.code !== 'JOB_PENDING') throw e; await new Promise(r => setTimeout(r, 1000)); }
      }
      toast.error('The bench sheet is still being made. Request it again in a moment.');
    } catch (e) { toast.error(`The bench sheet could not be made: ${errorMessage(e)}`); } finally { setBusy(false); }
  };

  const confirm = (reason: string, extra: { assigneeId?: string; label?: string } = {}) => {
    const p = pending!;
    const r = reason ? { reason } : {};
    if (p.kind === 'release') return run('Release', () => apiFetch(`${base}/release`, { body: { expectedVersion: w.version } }), 'Worklist released: its membership is frozen.');
    if (p.kind === 'complete') return run('Complete', () => apiFetch(`${base}/complete`, { body: { expectedVersion: w.version, ...r } }), 'Worklist completed.');
    if (p.kind === 'cancel') return run('Cancel', () => apiFetch(`${base}/cancel`, { body: { expectedVersion: w.version, reason } }), 'Worklist cancelled.');
    if (p.kind === 'remove') return run('Remove', () => apiFetch(`${base}/items/${encodeURIComponent(p.item.id)}/remove`, { body: { expectedVersion: p.item.version, ...r } }), 'Item removed (it stays in the record).');
    if (p.kind === 'reassign') return run('Change', () => apiFetch(`${base}/items/${encodeURIComponent(p.item.id)}`, { method: 'PUT', body: { expectedVersion: p.item.version, ...extra, ...r } }), 'Item changed.');
    const order = active.map(i => i.id);
    const at = order.indexOf(p.itemId);
    [order[at], order[at + p.direction]] = [order[at + p.direction], order[at]];
    return run('Reorder', () => apiFetch(`${base}/reorder`, { body: { itemIds: order, ...r } }), 'Run order changed.');
  };

  return (
    <section aria-labelledby="worklist-title" className="space-y-4">
      <header className="space-y-1">
        <a className="text-sm text-blue-800 underline" href={formatHash('worklists')}>All worklists</a>
        <h2 id="worklist-title" className="text-xl font-bold text-slate-800 flex flex-wrap items-center gap-2">
          <span className="font-mono">{w.id}</span> {w.title} <Badge tone={stateTone(w.status)}>{w.status}</Badge>
        </h2>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-sm">
          <div><dt className="text-slate-500">Method</dt><dd>{w.methodCode}</dd></div>
          <div><dt className="text-slate-500">Instrument</dt><dd>{w.instrument ? `${w.instrument.name} (${w.instrument.type}), calibration due ${w.instrument.calibrationDueDate}` : 'None named'}</dd></div>
          <div><dt className="text-slate-500">Planned</dt><dd>{w.plannedDate}</dd></div>
          <div><dt className="text-slate-500">Items</dt><dd>{active.length}</dd></div>
          {w.notes && <div className="col-span-2"><dt className="text-slate-500">Notes</dt><dd>{w.notes}</dd></div>}
          {w.closeReason && <div className="col-span-2"><dt className="text-slate-500">Closed because</dt><dd>{w.closeReason}</dd></div>}
        </dl>
        {released && <p className="text-xs text-slate-600">Released: the membership is frozen. A change needs a reason and is audited; only the assigned analyst enters a result.</p>}
      </header>

      <div className="flex flex-wrap gap-2">
        {has('worklist.view') && <Button size="sm" onClick={() => void saveBlob(`${base}/run-sequence.csv`, `${w.id}-run-sequence.csv`).catch(e => toast.error(`The run sequence could not be exported: ${errorMessage(e)}`))}>Export run sequence (CSV)</Button>}
        {has('worklist.manage') && <Button size="sm" busy={busy} onClick={() => void benchSheet()}>Bench sheet (PDF)</Button>}
        {has('worklist.manage') && w.status === 'Draft' && <Button size="sm" variant="primary" onClick={() => setPending({ kind: 'release' })}>Release</Button>}
        {has('worklist.manage') && released && <Button size="sm" variant="primary" onClick={() => setPending({ kind: 'complete' })}>Complete</Button>}
        {has('worklist.manage') && open && <Button size="sm" variant="danger" onClick={() => setPending({ kind: 'cancel' })}>Cancel worklist</Button>}
        {has('worklist.manage') && open && <Button size="sm" onClick={() => setAdding(true)}>Add item</Button>}
        {released && has('result.enter') && <Button size="sm" variant="primary" busy={busy} onClick={() => void saveGrid()}>Save entered results</Button>}
      </div>

      <ItemsTable
        items={w.items} status={w.status} canManage={has('worklist.manage')} canEnter={has('result.enter')} userId={user.id} edits={edits} failures={failures}
        onEdit={(rid, edit) => setEdits(prev => ({ ...prev, [rid]: edit }))}
        onMove={(itemId, direction) => setPending({ kind: 'move', itemId, direction })}
        onReassign={item => setPending({ kind: 'reassign', item })}
        onRemove={item => setPending({ kind: 'remove', item })}
      />

      {pending && <PendingDialog pending={pending} released={released} busy={busy} onClose={() => setPending(null)} onConfirm={confirm} />}
      {adding && <AddItemDialog worklist={w} released={released} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />}
    </section>
  );
}

function PendingDialog({ pending, released, busy, onClose, onConfirm }: {
  pending: Pending; released: boolean; busy: boolean; onClose: () => void; onConfirm: (reason: string, extra?: { assigneeId?: string; label?: string }) => void;
}) {
  const [assigneeId, setAssigneeId] = useState('');
  const [label, setLabel] = useState('');
  if (pending.kind === 'release') {
    return (
      <Modal open title="Release worklist" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => onConfirm('')}>Release</Button></>}>
        <p className="text-sm">Releasing freezes the membership. From then on every change needs a reason and is audited, and only the assigned analyst enters each result.</p>
      </Modal>
    );
  }
  const titles = { complete: 'Complete worklist', cancel: 'Cancel worklist', remove: 'Remove item', reassign: 'Change item', move: 'Change the run order' } as const;
  const requireReason = pending.kind === 'cancel' || pending.kind === 'remove' || released;
  return (
    <ChangeDialog title={titles[pending.kind]} requireReason={requireReason} busy={busy} onClose={onClose}
      onConfirm={reason => onConfirm(reason, pending.kind === 'reassign' ? (pending.item.kind === 'Sample' ? { assigneeId } : { label }) : {})}>
      {pending.kind === 'reassign' && pending.item.kind === 'Sample' && (
        <EntityPicker kind="users" label="New analyst" value={assigneeId} onChange={id => setAssigneeId(id)} required hint="Must be an active Analyst with the method training." />
      )}
      {pending.kind === 'reassign' && pending.item.kind !== 'Sample' && (
        <Field label="New label" required>{p => <input {...p} className={inputClass} value={label} onChange={e => setLabel(e.target.value)} />}</Field>
      )}
    </ChangeDialog>
  );
}

function AddItemDialog({ worklist, released, onClose, onDone }: { worklist: WorklistDetail; released: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('Sample');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [resultId, setResultId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [label, setLabel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiFetch<Candidate[]>(`/worklists/candidates?methodCode=${encodeURIComponent(worklist.methodCode)}`).then(setCandidates)
      .catch(e => toast.error(`The results waiting for ${worklist.methodCode} could not be loaded: ${errorMessage(e)}`));
  }, [worklist.methodCode, toast]);
  const chosen = candidates.find(c => c.resultId === resultId);
  return (
    <ChangeDialog title="Add item" requireReason={released} busy={busy} onClose={onClose} confirmLabel="Add item" onConfirm={async reason => {
      setBusy(true); setErrors({});
      try {
        const body: Record<string, string> = { kind };
        if (kind === 'Sample') { body.sampleId = chosen?.sampleId ?? ''; body.resultId = resultId; body.assigneeId = assigneeId; } else { body.label = label; if (assigneeId) body.assigneeId = assigneeId; }
        if (reason) body.reason = reason;
        await apiFetch(`/worklists/${encodeURIComponent(worklist.id)}/items`, { body });
        toast.success('Item added.');
        onDone();
      } catch (e) { setErrors(fieldErrors(e)); toast.error(errorMessage(e, 'The item could not be added.')); } finally { setBusy(false); }
    }}>
      <Field label="Kind" required>{p => (
        <select {...p} className={inputClass} value={kind} onChange={e => setKind(e.target.value as (typeof KINDS)[number])}>{KINDS.map(k => <option key={k} value={k}>{k}</option>)}</select>)}
      </Field>
      {kind === 'Sample' ? (
        <Field label="Result waiting for this method" required error={errors.resultId ?? errors.sampleId}>{p => (
          <select {...p} className={inputClass} value={resultId} onChange={e => setResultId(e.target.value)}>
            <option value="">{candidates.length === 0 ? 'No result is waiting for this method' : 'Choose a result'}</option>
            {candidates.map(c => <option key={c.resultId} value={c.resultId}>{c.sampleId}: {c.parameter} ({c.material} / {c.batch})</option>)}
          </select>)}
        </Field>
      ) : (
        <Field label="Label" required error={errors.label}>{p => <input {...p} className={inputClass} value={label} onChange={e => setLabel(e.target.value)} placeholder={`${kind} injection 1`} />}</Field>
      )}
      <EntityPicker kind="users" label={kind === 'Sample' ? 'Analyst who runs it' : 'Analyst (optional)'} value={assigneeId} onChange={id => setAssigneeId(id)} required={kind === 'Sample'} error={errors.assigneeId}
        hint="An active Analyst with the method training; the server checks it." />
    </ChangeDialog>
  );
}

// ---- entry point -------------------------------------------------------------------------------------------------------------------

export function Worklists({ user, recordId }: { user: SelfUser; recordId?: string | null }) {
  return recordId ? <WorklistView id={recordId} user={user} /> : <WorklistIndex />;
}

export { STATUSES as WORKLIST_STATUSES };
