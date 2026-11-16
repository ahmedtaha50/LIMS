import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorText, formatWhen, type T, useI18n, useT } from '../../i18n/index.js';
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
const shown = (t: T, v: Record<string, unknown> | null) => (v && 'value' in v ? `${String(v.value)}${v.unit ? ' ' + String(v.unit) : ''}` : v ? t('done') : '');
const notSaved = (t: T, err: unknown) => errorText(t, err, 'Not saved.');

/** The step the operator is on: what to do, what to enter, and the signature. */
function CurrentStep({ b, s, onDone }: { b: Batch; s: BStep; onDone: (b: Batch) => void }) {
  const t = useT();
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
    try { onDone(await api<Batch>('POST', `/api/batches/${b.id}/steps/${s.id}/record`, body)); } catch (err) { setError(notSaved(t, err)); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border-2 border-sky-700 bg-white p-4" aria-label={t('Current step')}>
      <p className="text-sm font-semibold text-sky-900">{t('Step {n}', { n: s.seq })} · {s.phaseLabel}{d.critical || d.type === 'verified' ? ` · ${t('needs a second person')}` : ''}</p>
      <h3 className="text-xl font-bold">{d.label}</h3>
      {d.text ? <p className="text-base">{d.text}</p> : null}
      {d.type === 'data' ? <TextField label={`${t('Value')}${d.unit ? ` (${d.unit})` : ''} *`} name="value" type="number" step="any" inputMode="decimal" required {...(d.min !== undefined || d.max !== undefined ? { hint: t('Limits: {min} to {max}{unit}', { min: d.min ?? '…', max: d.max ?? '…', unit: d.unit ? ' ' + d.unit : '' }) } : {})} /> : null}
      {inputs.get(d.type) ? (() => { const X = inputs.get(d.type)!.Fields; return <X def={d} />; })() : null}
      {d.type === 'calculation' ? <p className="text-base">{t('The server calculates {formula}{unit} from the recorded values when you sign.', { formula: d.formula, unit: d.unit ? ` (${d.unit})` : '' })}</p> : null}
      <TextField label={t('Comment')} name="comment" hint={t('Required when a value is outside its limits.')} />
      <TextField label={t('Your password (signature) *')} name="password" type="password" autoComplete="current-password" required hint={t('Signing means: I performed this step as written.')} dir="ltr" />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">{t('Sign step')}</Button>
    </form>
  );
}

function SignForm({ label, onSubmit, note }: { label: string; note?: string; onSubmit: (password: string, note: string) => Promise<void> }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={label} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void onSubmit(String(f.get('password') ?? ''), String(f.get('note') ?? '')).catch(err => setError(notSaved(t, err))); }}>
      {note ? <TextField label={note} name="note" required /> : null}
      <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">{label}</Button>
    </form>
  );
}

type LimsView = { limsReachable: boolean; samples: Array<{ externalRef: string; step: string; limsSampleId: string; test: string; status: string; result: Array<{ parameter: string; value: string | null; unit: string | null; outOfSpecification: boolean }> | null }> };

/** E32#4: the LIMS samples of the batch, with the results once approved in the LIMS (E18#1). */
function LimsSamples({ b }: { b: Batch }) {
  const t = useT();
  const [v, setV] = useState<LimsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<LimsView>('GET', `/api/batches/${b.id}/lims`).then(setV).catch(e => setError(errorText(t, e, 'Not loaded.'))); }, [b.id, b.version]);
  if (error) return <Alert>{error}</Alert>;
  if (!v || v.samples.length === 0) return null;
  return (
    <Card title={t('LIMS samples')}>
      {!v.limsReachable ? <Alert kind="info">{t('The LIMS cannot be reached now: the last known state is shown.')}</Alert> : null}
      <ul className="flex flex-col gap-2">{v.samples.map(s => (
        <li key={s.externalRef} className="rounded-lg border border-slate-200 p-2 text-base">
          <p><b>{s.test}</b> · {t('LIMS sample {id}', { id: s.limsSampleId })} · {s.status}</p>
          {s.result ? <ul className="mt-1 ps-5">{s.result.map(r => <li key={r.parameter} className={r.outOfSpecification ? 'font-semibold text-red-800' : ''}>{r.parameter}: {r.value ?? '—'}{r.unit ? ` ${r.unit}` : ''}{r.outOfSpecification ? ` (${t('out of specification')})` : ''}</li>)}</ul>
            : <p className="text-sm text-slate-600">{t('No approved result yet.')}</p>}
        </li>))}</ul>
    </Card>
  );
}

/** E12#3: yield and material reconciliation, once, before the batch is closed (r2-materials). */
function Reconcile({ b, onDone }: { b: Batch; onDone: (b: Batch) => void }) {
  const t = useT();
  const [done, setDone] = useState<{ yieldPct: number } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<{ yieldPct: number } | null>('GET', `/api/batches/${b.id}/reconciliation`).then(setDone).catch(() => setDone(null)); }, [b.id]);
  if (done === undefined) return null;
  if (done) return <Alert kind="info">{t('Reconciled: yield {pct}%.', { pct: done.yieldPct })}</Alert>;
  return (
    <Card title={t('Yield and material reconciliation')}>
      <form className="flex flex-col gap-2" aria-label={t('Reconciliation')} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
        void api('POST', `/api/batches/${b.id}/reconcile`, { outputQuantity: Number(f.get('output')), password: String(f.get('password') ?? '') })
          .then(() => api<Batch>('GET', `/api/batches/${b.id}`)).then(nb => { onDone(nb); setDone({ yieldPct: 0 }); void api<{ yieldPct: number }>('GET', `/api/batches/${b.id}/reconciliation`).then(setDone); }).catch(err => setError(notSaved(t, err))); }}>
        <TextField label={t('Output quantity ({unit}) *', { unit: String((b as Batch & { batchSize?: { unit: string } }).batchSize?.unit ?? '') })} name="output" type="number" step="any" inputMode="decimal" required />
        <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit">{t('Sign the reconciliation')}</Button>
      </form>
    </Card>
  );
}

function BatchView({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const { t, lang } = useI18n();
  const [b, setB] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<Batch>('GET', `/api/batches/${id}`).then(setB).catch(e => setError(errorText(t, e, 'Not loaded.'))); }, [id]);
  if (error) return <Alert>{error}</Alert>;
  if (!b) return <p role="status">{t('Loading…')}</p>;
  const can = (p: string) => me.permissions.includes(p);
  const current = b.steps.find(s => s.id === b.nextStepId);
  const toVerify = b.steps.filter(s => s.state === 'done' && s.needsVerification && !s.verifiedBy);
  const open = b.exceptions.filter(e => e.status === 'open');
  const done = b.steps.filter(s => s.state === 'done').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={onBack}>{t('Back to batches')}</Button>
        <h2 className="text-xl font-bold">{b.batchNumber} · {b.productName}</h2></div>
      <p className="text-base">{t('Recipe {code} version {n}', { code: b.mbr.code, n: b.mbr.versionNo })} · {t(`status.${b.status}`)} · {t('{done} of {total} steps', { done, total: b.steps.length })}</p>
      <div className="h-3 w-full rounded-full bg-slate-200" role="progressbar" aria-label={t('Progress')} aria-valuenow={done} aria-valuemin={0} aria-valuemax={b.steps.length}><div className="h-3 rounded-full bg-sky-700" style={{ width: `${(100 * done) / Math.max(1, b.steps.length)}%` }} /></div>
      {open.length ? <Alert>{t('{n} open exception(s): the batch cannot be closed until each is handled.', { n: open.length })}</Alert> : null}
      {current && can('batch.execute') && ['created', 'in_progress'].includes(b.status) ? <CurrentStep b={b} s={current} onDone={setB} /> : null}
      {b.waitingFor ? <Alert kind="info">{t('Waiting: {what}.', { what: b.waitingFor })}</Alert> : null}
      {toVerify.filter(s => can('batch.execute')).map(s => (
        <Card key={s.id} title={t('Verify step {n}: {label}', { n: s.seq, label: s.definition.label })}>
          <p className="mb-2 text-base">{t('Performed by {name}. Verifying means: I checked this step myself. It must be someone else.', { name: s.performedBy })}</p>
          <SignForm label={t('Verify step {n}', { n: s.seq })} onSubmit={async (password) => setB(await api<Batch>('POST', `/api/batches/${b.id}/steps/${s.id}/verify`, { version: s.version, password }))} />
        </Card>
      ))}
      {open.length && can('batch.exception') ? <Card title={t('Exceptions to handle')}>{open.map(e => (
        <div key={e.id} className="mb-3 flex flex-col gap-2 border-b border-slate-200 pb-3">
          <p className="text-base font-semibold text-red-800">{e.message}</p><p className="text-base">{t('Comment: {text}', { text: e.comment })}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <SignForm label={t('Hand to deviation')} note={t('Deviation number')} onSubmit={async (password, n) => setB(await api<Batch>('POST', `/api/batches/${b.id}/exceptions/${e.id}/deviation`, { version: e.version, deviationNumber: n, password }))} />
            <SignForm label={t('Close with justification')} note={t('Justification')} onSubmit={async (password, n) => setB(await api<Batch>('POST', `/api/batches/${b.id}/exceptions/${e.id}/close`, { version: e.version, note: n, password }))} />
          </div>
        </div>))}</Card> : null}
      {b.status === 'in_progress' && !current && !b.waitingFor && can('batch.complete') && b.steps.some(s => s.definition.type === 'material') ? <Reconcile b={b} onDone={setB} /> : null}
      {b.status === 'in_progress' && !current && !b.waitingFor && !open.length && can('batch.complete') ? <Card title={t('All steps are recorded')}><SignForm label={t('Close the batch')} onSubmit={async (password) => setB(await api<Batch>('POST', `/api/batches/${b.id}/complete`, { version: b.version, password }))} /></Card> : null}
      {b.steps.some(s => s.definition.type === 'sample') ? <LimsSamples b={b} /> : null}
      <ol className="flex flex-col gap-2" aria-label={t('Steps')}>
        {b.steps.map(s => (
          <li key={s.id} className={`rounded-xl border p-3 ${s.id === b.nextStepId ? 'border-sky-700 bg-sky-50' : 'border-slate-200 bg-white'}`}>
            <p className="text-base"><b>{s.seq}. {s.definition.label}</b>{s.state === 'done' ? <span> · <span aria-hidden="true">✓</span> {shown(t, s.value)}</span> : <span className="text-slate-600"> · {t('to do')}</span>}</p>
            {s.performedBy ? <p className="text-sm text-slate-700">{s.performedBy}, {formatWhen(lang, s.performedAt!, 'short')}{s.verifiedBy ? ` · ${t('verified by {name}', { name: s.verifiedBy })}` : s.needsVerification ? ` · ${t('not verified yet')}` : ''}</p> : null}
            {s.comment ? <p className="text-sm">{t('Comment: {text}', { text: s.comment })}</p> : null}
            {b.exceptions.filter(e => e.stepId === s.id).map(e => <p key={e.id} className="text-sm font-semibold text-red-800">{t('Exception: {message}', { message: e.message })} ({t(`status.${e.status}`)}{e.deviationNumber ? `, ${e.deviationNumber}` : ''})</p>)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function NewBatch({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const [recipes, setRecipes] = useState<Array<{ id: string; code: string; productName: string; versions: Array<{ status: string; versionNo: number }> }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<typeof recipes>('GET', '/api/mbrs').then(r => setRecipes(r.filter(m => m.versions.some(v => v.status === 'effective')))); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { onCreated((await api<Batch>('POST', '/api/batches', { mbrMasterId: String(f.get('recipe')), batchNumber: String(f.get('batchNumber')) })).id); } catch (err) { setError(notSaved(t, err)); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={t('New batch')}>
      <div className="flex flex-col gap-1"><label htmlFor="recipe" className="text-sm font-semibold text-slate-700">{t('Effective recipe *')}</label>
        <select id="recipe" name="recipe" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base"><option value="">{t('Choose…')}</option>
          {recipes.map(r => <option key={r.id} value={r.id}>{r.code} · {r.productName} ({t('version {n}', { n: r.versions.find(v => v.status === 'effective')?.versionNo })})</option>)}</select></div>
      <TextField label={t('Batch number *')} name="batchNumber" required dir="ltr" />
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit">{t('Create batch')}</Button>
    </form>
  );
}

function Batches() {
  const t = useT();
  const [list, setList] = useState<Summary[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!open) { void api<Summary[]>('GET', '/api/batches').then(setList); void api<Me>('GET', '/api/auth/me').then(setMe); } }, [open]);
  if (!list || !me) return <p role="status">{t('Loading…')}</p>;
  if (open) return <BatchView id={open} me={me} onBack={() => setOpen(null)} />;
  return (
    <div className="flex flex-col gap-4">
      {me.permissions.includes('batch.create') ? (creating ? <Card title={t('New batch')}><NewBatch onCreated={id => { setCreating(false); setOpen(id); }} /></Card> : <div><Button onClick={() => setCreating(true)}>{t('New batch')}</Button></div>) : null}
      <Card title={t('Batches')}>{list.length === 0 ? <p className="text-base">{t('No batch yet.')}</p> : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label={t('Batch list')}>{list.map(b => (
          <li key={b.id}><button type="button" onClick={() => setOpen(b.id)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-300 bg-white p-3 text-start hover:bg-slate-50">
            <span className="text-base font-bold">{b.batchNumber} · {b.productName}</span>
            <span className="text-sm text-slate-700">{t(`status.${b.status}`)} · {t('{done}/{total} steps', { done: b.stepsDone, total: b.stepsTotal })}{b.openExceptions ? ` · ${t('{n} open exception(s)', { n: b.openExceptions })}` : ''}</span>
          </button></li>))}</ul>)}</Card>
    </div>
  );
}
export const screen: Screen = { id: 'batches', title: 'Batches', order: 5, permission: 'batch.read', Component: Batches };
