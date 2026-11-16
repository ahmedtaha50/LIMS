import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { StepInput } from '../../step-inputs/types.js';
import type { Screen } from '../registry.js';

/** Inputs of step types added by other tracks (materials, equipment), found by directory. */
const inputs = new Map(Object.values(import.meta.glob<{ stepInput: StepInput }>('../../step-inputs/*.tsx', { eager: true })).map(m => [m.stepInput.type, m.stepInput]));

type Def = { key: string; label: string; type: string; text?: string; unit?: string; min?: number; max?: number; formula?: string; critical?: boolean } & Record<string, unknown>;
type BStep = { id: string; seq: number; phaseLabel: string; definition: Def; state: string; value: Record<string, unknown> | null; comment: string | null; performedBy: string | null; performedAt: string | null; verifiedBy: string | null; needsVerification: boolean; version: number };
type Exc = { id: string; stepId: string; message: string; comment: string; status: string; deviationNumber: string | null; closeNote: string | null; version: number };
type Batch = { id: string; batchNumber: string; productName: string; status: string; version: number; mbr: { code: string; versionNo: number }; nextStepId: string | null; waitingFor: string | null; steps: BStep[]; exceptions: Exc[] };
type Summary = { id: string; batchNumber: string; productName: string; status: string; stepsDone: number; stepsTotal: number; openExceptions: number };
type Me = { userId: string; displayName: string; permissions: string[] };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const shown = (v: Record<string, unknown> | null) => (v && 'value' in v ? `${String(v.value)}${v.unit ? ' ' + String(v.unit) : ''}` : v ? 'done' : '');

function errorText(err: unknown) { return err instanceof ApiError ? err.message : 'Not saved.'; }

/** The step the operator is on: what to do, what to enter, and the signature. */
function CurrentStep({ b, s, onDone }: { b: Batch; s: BStep; onDone: (b: Batch) => void }) {
  const [error, setError] = useState<string | null>(null);
  const d = s.definition;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const extra = inputs.get(d.type);
    const input: Record<string, unknown> = extra ? extra.read(f) : {};
    if (d.type === 'data') { const v = String(f.get('value') ?? ''); if (v !== '') input.value = Number(v); }
    const body: Record<string, unknown> = { version: s.version, input, password: String(f.get('password') ?? '') };
    const comment = String(f.get('comment') ?? ''); if (comment) body.comment = comment;
    try { onDone(await api<Batch>('POST', `/api/batches/${b.id}/steps/${s.id}/record`, body)); } catch (err) { setError(errorText(err)); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border-2 border-sky-700 bg-white p-4" aria-label="Current step">
      <p className="text-sm font-semibold text-sky-900">Step {s.seq} · {s.phaseLabel}{d.critical || d.type === 'verified' ? ' · needs a second person' : ''}</p>
      <h3 className="text-xl font-bold">{d.label}</h3>
      {d.text ? <p className="text-base">{d.text}</p> : null}
      {d.type === 'data' ? <TextField label={`Value${d.unit ? ` (${d.unit})` : ''} *`} name="value" type="number" step="any" inputMode="decimal" required {...(d.min !== undefined || d.max !== undefined ? { hint: `Limits: ${d.min ?? '…'} to ${d.max ?? '…'} ${d.unit ?? ''}` } : {})} /> : null}
      {inputs.get(d.type) ? (() => { const X = inputs.get(d.type)!.Fields; return <X def={d} />; })() : null}
      {d.type === 'calculation' ? <p className="text-base">The server calculates <b>{d.formula}</b>{d.unit ? ` in ${d.unit}` : ''} from the recorded values when you sign.</p> : null}
      <TextField label="Comment" name="comment" hint="Required when a value is outside its limits." />
      <TextField label="Your password (signature) *" name="password" type="password" autoComplete="current-password" required hint="Signing means: I performed this step as written." />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">Sign step</Button>
    </form>
  );
}

function SignForm({ label, onSubmit, note }: { label: string; note?: string; onSubmit: (password: string, note: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={label} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void onSubmit(String(f.get('password') ?? ''), String(f.get('note') ?? '')).catch(err => setError(errorText(err))); }}>
      {note ? <TextField label={note} name="note" required /> : null}
      <TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">{label}</Button>
    </form>
  );
}

/** E12#3: yield and material reconciliation, once, before the batch is closed (r2-materials). */
function Reconcile({ b, onDone }: { b: Batch; onDone: (b: Batch) => void }) {
  const [done, setDone] = useState<{ yieldPct: number } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<{ yieldPct: number } | null>('GET', `/api/batches/${b.id}/reconciliation`).then(setDone).catch(() => setDone(null)); }, [b.id]);
  if (done === undefined) return null;
  if (done) return <Alert kind="info">Reconciled: yield {done.yieldPct}%.</Alert>;
  return (
    <Card title="Yield and material reconciliation">
      <form className="flex flex-col gap-2" aria-label="Reconciliation" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
        void api('POST', `/api/batches/${b.id}/reconcile`, { outputQuantity: Number(f.get('output')), password: String(f.get('password') ?? '') })
          .then(() => api<Batch>('GET', `/api/batches/${b.id}`)).then(nb => { onDone(nb); setDone({ yieldPct: 0 }); void api<{ yieldPct: number }>('GET', `/api/batches/${b.id}/reconciliation`).then(setDone); }).catch(err => setError(errorText(err))); }}>
        <TextField label={`Output quantity (${String((b as Batch & { batchSize?: { unit: string } }).batchSize?.unit ?? '')}) *`} name="output" type="number" step="any" inputMode="decimal" required />
        <TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required />
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit">Sign the reconciliation</Button>
      </form>
    </Card>
  );
}

function BatchView({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const [b, setB] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<Batch>('GET', `/api/batches/${id}`).then(setB).catch(e => setError(errorText(e))); }, [id]);
  if (error) return <Alert>{error}</Alert>;
  if (!b) return <p role="status">Loading…</p>;
  const can = (p: string) => me.permissions.includes(p);
  const current = b.steps.find(s => s.id === b.nextStepId);
  const toVerify = b.steps.filter(s => s.state === 'done' && s.needsVerification && !s.verifiedBy);
  const open = b.exceptions.filter(e => e.status === 'open');
  const done = b.steps.filter(s => s.state === 'done').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={onBack}>Back to batches</Button>
        <h2 className="text-xl font-bold">{b.batchNumber} · {b.productName}</h2></div>
      <p className="text-base">Recipe {b.mbr.code} version {b.mbr.versionNo} · {b.status.replace('_', ' ')} · {done} of {b.steps.length} steps</p>
      <div className="h-3 w-full rounded-full bg-slate-200" role="progressbar" aria-label="Progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={b.steps.length}><div className="h-3 rounded-full bg-sky-700" style={{ width: `${(100 * done) / Math.max(1, b.steps.length)}%` }} /></div>
      {open.length ? <Alert>{open.length} open exception(s): the batch cannot be closed until each is handled.</Alert> : null}
      {current && can('batch.execute') && ['created', 'in_progress'].includes(b.status) ? <CurrentStep b={b} s={current} onDone={setB} /> : null}
      {b.waitingFor ? <Alert kind="info">Waiting: {b.waitingFor}.</Alert> : null}
      {toVerify.filter(s => can('batch.execute')).map(s => (
        <Card key={s.id} title={`Verify step ${s.seq}: ${s.definition.label}`}>
          <p className="mb-2 text-base">Performed by {s.performedBy}. Verifying means: I checked this step myself. It must be someone else.</p>
          <SignForm label={`Verify step ${s.seq}`} onSubmit={async (password) => setB(await api<Batch>('POST', `/api/batches/${b.id}/steps/${s.id}/verify`, { version: s.version, password }))} />
        </Card>
      ))}
      {open.length && can('batch.exception') ? <Card title="Exceptions to handle">{open.map(e => (
        <div key={e.id} className="mb-3 flex flex-col gap-2 border-b border-slate-200 pb-3">
          <p className="text-base font-semibold text-red-800">{e.message}</p><p className="text-base">Comment: {e.comment}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <SignForm label="Hand to deviation" note="Deviation number" onSubmit={async (password, n) => setB(await api<Batch>('POST', `/api/batches/${b.id}/exceptions/${e.id}/deviation`, { version: e.version, deviationNumber: n, password }))} />
            <SignForm label="Close with justification" note="Justification" onSubmit={async (password, n) => setB(await api<Batch>('POST', `/api/batches/${b.id}/exceptions/${e.id}/close`, { version: e.version, note: n, password }))} />
          </div>
        </div>))}</Card> : null}
      {b.status === 'in_progress' && !current && !b.waitingFor && can('batch.complete') && b.steps.some(s => s.definition.type === 'material') ? <Reconcile b={b} onDone={setB} /> : null}
      {b.status === 'in_progress' && !current && !b.waitingFor && !open.length && can('batch.complete') ? <Card title="All steps are recorded"><SignForm label="Close the batch" onSubmit={async (password) => setB(await api<Batch>('POST', `/api/batches/${b.id}/complete`, { version: b.version, password }))} /></Card> : null}
      <ol className="flex flex-col gap-2" aria-label="Steps">
        {b.steps.map(s => (
          <li key={s.id} className={`rounded-xl border p-3 ${s.id === b.nextStepId ? 'border-sky-700 bg-sky-50' : 'border-slate-200 bg-white'}`}>
            <p className="text-base"><b>{s.seq}. {s.definition.label}</b>{s.state === 'done' ? <span> · <span aria-hidden="true">✓</span> {shown(s.value)}</span> : <span className="text-slate-600"> · to do</span>}</p>
            {s.performedBy ? <p className="text-sm text-slate-700">{s.performedBy}, {when(s.performedAt!)}{s.verifiedBy ? ` · verified by ${s.verifiedBy}` : s.needsVerification ? ' · not verified yet' : ''}</p> : null}
            {s.comment ? <p className="text-sm">Comment: {s.comment}</p> : null}
            {b.exceptions.filter(e => e.stepId === s.id).map(e => <p key={e.id} className="text-sm font-semibold text-red-800">Exception: {e.message} ({e.status}{e.deviationNumber ? `, ${e.deviationNumber}` : ''})</p>)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function NewBatch({ onCreated }: { onCreated: (id: string) => void }) {
  const [recipes, setRecipes] = useState<Array<{ id: string; code: string; productName: string; versions: Array<{ status: string; versionNo: number }> }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<typeof recipes>('GET', '/api/mbrs').then(r => setRecipes(r.filter(m => m.versions.some(v => v.status === 'effective')))); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { onCreated((await api<Batch>('POST', '/api/batches', { mbrMasterId: String(f.get('recipe')), batchNumber: String(f.get('batchNumber')) })).id); } catch (err) { setError(errorText(err)); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="New batch">
      <div className="flex flex-col gap-1"><label htmlFor="recipe" className="text-sm font-semibold text-slate-700">Effective recipe *</label>
        <select id="recipe" name="recipe" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base"><option value="">Choose…</option>
          {recipes.map(r => <option key={r.id} value={r.id}>{r.code} · {r.productName} (version {r.versions.find(v => v.status === 'effective')?.versionNo})</option>)}</select></div>
      <TextField label="Batch number *" name="batchNumber" required />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">Create batch</Button>
    </form>
  );
}

function Batches() {
  const [list, setList] = useState<Summary[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!open) { void api<Summary[]>('GET', '/api/batches').then(setList); void api<Me>('GET', '/api/auth/me').then(setMe); } }, [open]);
  if (!list || !me) return <p role="status">Loading…</p>;
  if (open) return <BatchView id={open} me={me} onBack={() => setOpen(null)} />;
  return (
    <div className="flex flex-col gap-4">
      {me.permissions.includes('batch.create') ? (creating ? <Card title="New batch"><NewBatch onCreated={id => { setCreating(false); setOpen(id); }} /></Card> : <div><Button onClick={() => setCreating(true)}>New batch</Button></div>) : null}
      <Card title="Batches">{list.length === 0 ? <p className="text-base">No batch yet.</p> : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Batch list">{list.map(b => (
          <li key={b.id}><button type="button" onClick={() => setOpen(b.id)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-300 bg-white p-3 text-left hover:bg-slate-50">
            <span className="text-base font-bold">{b.batchNumber} · {b.productName}</span>
            <span className="text-sm text-slate-700">{b.status.replace('_', ' ')} · {b.stepsDone}/{b.stepsTotal} steps{b.openExceptions ? ` · ${b.openExceptions} open exception(s)` : ''}</span>
          </button></li>))}</ul>)}</Card>
    </div>
  );
}
export const screen: Screen = { id: 'batches', title: 'Batches', order: 5, permission: 'batch.read', Component: Batches };
