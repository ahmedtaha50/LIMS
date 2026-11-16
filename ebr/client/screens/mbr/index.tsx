import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { errorText, useT } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type StepType = 'instruction' | 'data' | 'signature' | 'verified' | 'calculation' | 'material' | 'equipment' | 'sample';
type Step = { key: string; label: string; type: StepType; critical?: boolean } & Record<string, unknown>;
type Phase = { key: string; label: string; steps: Step[] };
type Design = { batchSize: { value: number; unit: string }; yieldLimits?: { minPct: number; maxPct: number }; phases: Phase[] };
type Version = { id: string; versionNo: number; status: string; authorId: string; authorName: string; approvedBy: string | null; rowVersion: number; design: Design };
type Master = { id: string; code: string; productName: string; versions: Version[] };
type Me = { userId: string; permissions: string[] };

const STEP_TYPES: StepType[] = ['instruction', 'data', 'signature', 'verified', 'calculation', 'material', 'equipment', 'sample'];
const keyOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1').slice(0, 40) || 'step';
const blank = (type: StepType, n: number): Step => {
  const s: Step = { key: `step_${n}`, label: `Step ${n}`, type };
  if (type === 'instruction' || type === 'signature' || type === 'verified') s.text = 'Describe what is done';
  if (type === 'data' || type === 'calculation') s.unit = '';
  if (type === 'calculation') s.formula = '';
  if (type === 'material') Object.assign(s, { material: '', quantity: 1, unit: 'kg', tolerancePct: 1 });
  if (type === 'equipment') Object.assign(s, { objectKind: 'equipment' });
  if (type === 'sample') Object.assign(s, { test: '', quantity: 1, unit: 'g' });
  return s;
};
const num = (v: string) => (v === '' ? undefined : Number(v));

function StepEditor({ s, onChange, id }: { s: Step; onChange: (s: Step) => void; id: string }) {
  const t = useT();
  const set = (k: string, v: unknown) => { const n = { ...s }; if (v === undefined) delete n[k]; else n[k] = v; onChange(n); };
  const text = (k: string, label: string) => <TextField label={label} value={String(s[k] ?? '')} onChange={e => set(k, e.target.value)} />;
  const number = (k: string, label: string) => <TextField label={label} type="number" step="any" inputMode="decimal" value={s[k] === undefined ? '' : String(s[k])} onChange={e => set(k, num(e.target.value))} />;
  return (
    <div className="grid gap-2 md:grid-cols-3" id={id}>
      <TextField label={t('Step name')} value={s.label} onChange={e => onChange({ ...s, label: e.target.value, key: keyOf(e.target.value) })} hint={t('Reference: {key}', { key: s.key })} />
      {s.type === 'instruction' || s.type === 'signature' || s.type === 'verified' ? text('text', t('Text')) : null}
      {s.type === 'data' || s.type === 'calculation' ? <>{text('unit', t('Unit'))}{number('min', t('Lower limit'))}{number('max', t('Upper limit'))}</> : null}
      {s.type === 'calculation' ? text('formula', t('Formula (for example water / 60)')) : null}
      {s.type === 'material' ? <>{text('material', t('Material code'))}{number('quantity', t('Target quantity'))}{text('unit', t('Unit'))}{number('tolerancePct', t('Tolerance (%)'))}</> : null}
      {s.type === 'equipment' ? <div className="flex flex-col gap-1"><label htmlFor={`${id}-kind`} className="text-sm font-semibold text-slate-700">{t('Kind')}</label>
        <select id={`${id}-kind`} value={String(s.objectKind)} onChange={e => set('objectKind', e.target.value)} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base"><option value="equipment">{t('Equipment')}</option><option value="room">{t('Room')}</option></select></div> : null}
      {s.type === 'sample' ? <>{text('test', t('Test'))}{number('quantity', t('Quantity'))}{text('unit', t('Unit'))}</> : null}
      <label className="flex min-h-11 items-center gap-2 text-base"><input type="checkbox" className="size-11 shrink-0" checked={!!s.critical} onChange={e => set('critical', e.target.checked || undefined)} />{t('Critical step')}</label>
    </div>
  );
}

/** The recipe designer (E08): phases of typed steps, on a tablet or a desktop; the server checks the recipe when saved. */
function Designer({ master, version, onSaved, onCancel }: { master?: Master; version?: Version; onSaved: () => void; onCancel: () => void }) {
  const t = useT();
  const [d, setD] = useState<Design>(version?.design ?? { batchSize: { value: 100, unit: 'kg' }, phases: [{ key: 'phase_1', label: 'Phase 1', steps: [] }] });
  const [addType, setAddType] = useState<StepType>('instruction');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const setPhase = (i: number, p: Phase) => setD(x => ({ ...x, phases: x.phases.map((q, j) => (j === i ? p : q)) }));
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      if (version && master) await api('PUT', `/api/mbrs/${master.id}/versions/${version.id}`, { rowVersion: version.rowVersion, design: d });
      else await api('POST', '/api/mbrs', { code: String(f.get('code')), productName: String(f.get('productName')), design: d });
      onSaved();
    } catch (err) {
      setError(errorText(t, err, 'Not saved.'));
      const det = err instanceof ApiError ? err.details : undefined;
      setDetails(Array.isArray(det) ? det.map(x => (typeof x === 'string' ? x : x.message)) : []);
    }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4" aria-label={t('Recipe designer')}>
      {!version ? <div className="grid gap-4 md:grid-cols-2"><TextField label={t('Recipe code *')} name="code" required dir="ltr" /><TextField label={t('Product *')} name="productName" required /></div> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label={t('Batch size')} type="number" step="any" value={String(d.batchSize.value)} onChange={e => setD({ ...d, batchSize: { ...d.batchSize, value: Number(e.target.value) } })} />
        <TextField label={t('Batch size unit')} value={d.batchSize.unit} onChange={e => setD({ ...d, batchSize: { ...d.batchSize, unit: e.target.value } })} />
      </div>
      <fieldset className="grid gap-4 rounded-xl border border-slate-300 p-3 md:grid-cols-2">
        <legend className="px-1 text-base font-bold">{t('Yield limits of this product (optional)')}</legend>
        <p className="text-sm text-slate-700 md:col-span-2">{t('Empty: the site limits apply. QA approves these limits with the version.')}</p>
        <TextField label={t('Lowest yield (%)')} type="number" step="any" inputMode="decimal" value={d.yieldLimits?.minPct ?? ''}
          onChange={e => { const v = e.target.value; setD(x => (v === '' ? (({ yieldLimits: _y, ...rest }) => { void _y; return rest; })(x) : { ...x, yieldLimits: { minPct: Number(v), maxPct: x.yieldLimits?.maxPct ?? 102 } })); }} />
        <TextField label={t('Highest yield (%)')} type="number" step="any" inputMode="decimal" value={d.yieldLimits?.maxPct ?? ''}
          onChange={e => { const v = e.target.value; setD(x => (v === '' ? (({ yieldLimits: _y, ...rest }) => { void _y; return rest; })(x) : { ...x, yieldLimits: { minPct: x.yieldLimits?.minPct ?? 95, maxPct: Number(v) } })); }} />
      </fieldset>
      {d.phases.map((ph, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-xl border border-slate-300 p-3">
          <legend className="px-1 text-base font-bold">{t('Phase {n}', { n: i + 1 })}</legend>
          <TextField label={t('Phase name')} value={ph.label} onChange={e => setPhase(i, { ...ph, label: e.target.value, key: keyOf(e.target.value) })} />
          <ol className="flex flex-col gap-2">{ph.steps.map((s, j) => (
            <li key={j} className="rounded-lg bg-slate-50 p-2">
              <p className="mb-1 text-sm font-bold">{j + 1}. {t(`stepType.${s.type}`)}</p>
              <StepEditor id={`s-${i}-${j}`} s={s} onChange={n => setPhase(i, { ...ph, steps: ph.steps.map((x, k) => (k === j ? n : x)) })} />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" disabled={j === 0} onClick={() => { const st = [...ph.steps]; [st[j - 1], st[j]] = [st[j]!, st[j - 1]!]; setPhase(i, { ...ph, steps: st }); }}>{t('Move up')}</Button>
                <Button variant="secondary" onClick={() => setPhase(i, { ...ph, steps: ph.steps.filter((_, k) => k !== j) })}>{t('Remove')}</Button>
              </div>
            </li>))}</ol>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1"><label htmlFor={`add-${i}`} className="text-sm font-semibold text-slate-700">{t('Step type')}</label>
              <select id={`add-${i}`} value={addType} onChange={e => setAddType(e.target.value as StepType)} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
                {STEP_TYPES.map(ty => <option key={ty} value={ty}>{t(`stepType.${ty}`)}</option>)}</select></div>
            <Button variant="secondary" onClick={() => setPhase(i, { ...ph, steps: [...ph.steps, blank(addType, ph.steps.length + 1)] })}>{t('Add step')}</Button>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setD({ ...d, phases: [...d.phases, { key: `phase_${d.phases.length + 1}`, label: `Phase ${d.phases.length + 1}`, steps: [] }] })}>{t('Add phase')}</Button>
        <Button type="submit">{version ? t('Save draft') : t('Create as draft')}</Button><Button variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
      </div>
      {error ? <Alert>{error}{details.length ? <ul className="mt-1 list-disc ps-5">{details.map(x => <li key={x}>{x}</li>)}</ul> : null}</Alert> : null}
    </form>
  );
}

function Actions({ m, v, me, onDone, onEdit }: { m: Master; v: Version; me: Me; onDone: () => void; onEdit: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const can = (p: string) => me.permissions.includes(p);
  async function act(e: FormEvent<HTMLFormElement>, what: string) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { rowVersion: v.rowVersion, password: String(f.get('password') ?? '') };
    if (what === 'reject') body.reason = String(f.get('note') ?? '');
    if (what === 'approve' && f.get('note')) body.comment = String(f.get('note'));
    try { await api('POST', `/api/mbrs/${m.id}/versions/${v.id}/${what}`, body); onDone(); } catch (err) { setError(errorText(t, err, 'Not done.')); }
  }
  const signed = (what: string, label: string, note?: string) => (
    <form onSubmit={e => void act(e, what)} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('{action} version {n}', { action: label, n: v.versionNo })}>
      {note ? <TextField label={note} name="note" required={what === 'reject'} /> : null}
      <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
      <Button type="submit" variant={what === 'reject' ? 'danger' : 'primary'}>{label}</Button>
    </form>
  );
  return (
    <div className="flex flex-col gap-2">
      {v.status === 'draft' && can('mbr.design') ? <div className="flex flex-col gap-2"><div><Button variant="secondary" onClick={onEdit}>{t('Edit draft')}</Button></div>{signed('submit', t('Sign as author and send to QA'))}</div> : null}
      {v.status === 'in_review' && can('mbr.approve') ? <div className="grid gap-2 md:grid-cols-2">{signed('approve', t('Approve (QA)'), t('Comment'))}{signed('reject', t('Send back'), t('Reason *'))}</div> : null}
      {v.status === 'approved' && can('mbr.approve') ? signed('make-effective', t('Make effective')) : null}
      {can('mbr.design') ? <details className="rounded-lg bg-slate-50 p-2"><summary className="min-h-11 cursor-pointer content-center text-base font-semibold">{t('Copy into a new recipe')}</summary>
        <form className="mt-2 grid gap-2 md:grid-cols-3" aria-label={t('Copy version {n} into a new recipe', { n: v.versionNo })} onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget);
          void api('POST', `/api/mbrs/${m.id}/versions/${v.id}/copy`, { code: String(f.get('code')), productName: String(f.get('productName')) }).then(() => { setError(null); onDone(); }).catch(err => setError(errorText(t, err, 'Not created.'))); }}>
          <TextField label={t('Recipe code *')} name="code" required dir="ltr" /><TextField label={t('Product *')} name="productName" required />
          <div className="flex items-end"><Button type="submit">{t('Copy as a new draft')}</Button></div>
        </form></details> : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

function Recipes() {
  const t = useT();
  const [list, setList] = useState<Master[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState<{ master?: Master; version?: Version } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { void api<Master[]>('GET', '/api/mbrs').then(setList).catch(e => setError(errorText(t, e, 'Not loaded.'))); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (error) return <Alert>{error}</Alert>;
  if (!list || !me) return <p role="status">{t('Loading…')}</p>;
  if (editing) return <Card title={editing.version ? t('Edit draft version {n}', { n: editing.version.versionNo }) : t('New master batch record')}><Designer {...editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} /></Card>;
  return (
    <div className="flex flex-col gap-4">
      {me.permissions.includes('mbr.design') ? <div><Button onClick={() => setEditing({})}>{t('New master batch record')}</Button></div> : null}
      {list.length === 0 ? <p className="text-base">{t('No master batch record yet.')}</p> : null}
      {list.map(m => (
        <Card key={m.id} title={`${m.code} · ${m.productName}`}>
          <ul className="flex flex-col gap-2">{m.versions.map(v => (
            <li key={v.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
              <p className="text-base"><b>{t('Version {n}', { n: v.versionNo })}</b> · {t(`status.${v.status}`)} · {t('by {name}', { name: v.authorName })}{v.approvedBy ? ` · ${t('approved by {name}', { name: v.approvedBy })}` : ''} · {t('{phases} phase(s), {steps} step(s)', { phases: v.design.phases.length, steps: v.design.phases.reduce((n, p) => n + p.steps.length, 0) })}{v.design.yieldLimits ? ` · ${t('yield {min} to {max}%', { min: v.design.yieldLimits.minPct, max: v.design.yieldLimits.maxPct })}` : ''}</p>
              <Actions m={m} v={v} me={me} onDone={load} onEdit={() => setEditing({ master: m, version: v })} />
            </li>))}</ul>
          {me.permissions.includes('mbr.design') && m.versions.some(v => v.status === 'effective') && !m.versions.some(v => ['draft', 'in_review', 'approved'].includes(v.status))
            ? <Button variant="secondary" className="mt-2" onClick={() => void api('POST', `/api/mbrs/${m.id}/versions`).then(load).catch(e => setError(errorText(t, e, 'Not created.')))}>{t('Start a new version')}</Button> : null}
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'mbr', title: 'Recipes (MBR)', order: 20, permission: 'mbr.read', Component: Recipes };
