import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorText, formatWhen, useI18n } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';
import { EntryForm, type KindDef } from './EntryForm.js';
import { StatusBadge } from './StatusBadge.js';

type Summary = { id: string; objectKind: string; objectCode: string; name: string; location: string; typeName: string; status: string; derived: { status: string; reasons: string[] }; entryCount: number; lastEntryAt: string | null };
type Entry = { id: string; kindLabel: string; kind: string; typeVersion: number; values: Record<string, unknown>; flags: Array<{ message: string }>; comment: string | null; recordedAt: string; meaning: string; signedBy: string; correctsEntryId: string | null; correctionReason: string | null; correctedBy: string | null };
type Detail = Summary & { version: number; settings: { cleanHoldHours?: number }; definition: { entryKinds: KindDef[] } | null; entries: Entry[]; derived: { status: string; reasons: string[]; calibrationDue: string | null } };
type Me = { permissions: string[] };
type LType = { code: string; name: string; versions: Array<{ status: string; needsQaReview: boolean }> };
const KINDS = ['equipment', 'room', 'area', 'instrument', 'process', 'other'];

/** E32#4: a supervisor creates the logbook of an object from an effective type (E21#3). */
function NewLogbook({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const [types, setTypes] = useState<LType[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<LType[]>('GET', '/api/logbook-types').then(l => setTypes(l.filter(x => x.versions.some(v => v.status === 'effective')))); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), hold = String(f.get('hold') ?? '');
    try {
      const r = await api<{ id: string }>('POST', '/api/logbooks', { typeCode: String(f.get('type')), objectKind: String(f.get('kind')), objectCode: String(f.get('code')), name: String(f.get('name')), location: String(f.get('location') ?? ''), settings: hold ? { cleanHoldHours: Number(hold) } : {} });
      onCreated(r.id);
    } catch (err) { setError(errorText(t, err, 'Not created.')); }
  }
  return (
    <form onSubmit={submit} className="grid gap-3 md:grid-cols-2" aria-label={t('New logbook')}>
      <div className="flex flex-col gap-1"><label htmlFor="lb-type" className="text-sm font-semibold text-slate-700">{t('Logbook type *')}</label>
        <select id="lb-type" name="type" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base"><option value="">{t('Choose…')}</option>
          {types.map(x => <option key={x.code} value={x.code}>{x.name}{x.versions.some(v => v.status === 'effective' && v.needsQaReview) ? ` (${t('waits for the QA review')})` : ''}</option>)}</select></div>
      <div className="flex flex-col gap-1"><label htmlFor="lb-kind" className="text-sm font-semibold text-slate-700">{t('Kind of object *')}</label>
        <select id="lb-kind" name="kind" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">{KINDS.map(k => <option key={k} value={k}>{t(`objectKind.${k}`)}</option>)}</select></div>
      <TextField label={t('Code *')} name="code" required pattern="[A-Za-z0-9._/-]{1,40}" dir="ltr" autoCapitalize="characters" />
      <TextField label={t('Name *')} name="name" required />
      <TextField label={t('Location')} name="location" />
      <TextField label={t('Clean hold time (hours)')} name="hold" type="number" step="any" min={0} hint={t('After this time a cleaned item is dirty again. Empty: no limit.')} />
      <div className="md:col-span-2"><Button type="submit">{t('Create logbook')}</Button></div>
      {error ? <div className="md:col-span-2"><Alert>{error}</Alert></div> : null}
    </form>
  );
}

/** E32#4: name, location and clean hold time changed with a reason; retiring is signed and keeps the logbook readable. */
function ManageLogbook({ d, onDone }: { d: Detail; onDone: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), hold = String(f.get('hold') ?? '');
    try { await api('PATCH', `/api/logbooks/${d.id}`, { version: d.version, reason: String(f.get('reason') ?? ''), name: String(f.get('name')), location: String(f.get('location') ?? ''), settings: hold ? { cleanHoldHours: Number(hold) } : {} }); setError(null); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not saved.')); }
  }
  async function retire(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api('POST', `/api/logbooks/${d.id}/retire`, { version: d.version, reason: String(f.get('reason') ?? ''), password: String(f.get('password') ?? '') }); setError(null); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not done.')); }
  }
  return (
    <Card title={t('Manage this logbook')}>
      <div className="grid gap-3 md:grid-cols-2">
        <form onSubmit={change} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('Change logbook')}>
          <TextField label={t('Name *')} name="name" defaultValue={d.name} required />
          <TextField label={t('Location')} name="location" defaultValue={d.location} />
          <TextField label={t('Clean hold time (hours)')} name="hold" type="number" step="any" min={0} defaultValue={d.settings?.cleanHoldHours ?? ''} />
          <TextField label={t('Reason *')} name="reason" required />
          <div><Button type="submit">{t('Save')}</Button></div>
        </form>
        <form onSubmit={retire} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('Retire logbook')}>
          <p className="text-base">{t('A retired logbook stays readable; nothing more is written in it.')}</p>
          <TextField label={t('Reason *')} name="reason" required />
          <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
          <div><Button type="submit" variant="danger">{t('Retire logbook')}</Button></div>
        </form>
      </div>
      {error ? <div className="mt-2"><Alert>{error}</Alert></div> : null}
    </Card>
  );
}

function LogbookView({ id, onBack, me }: { id: string; onBack: () => void; me: Me }) {
  const { t, lang } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<{ kind: 'view' } | { kind: 'new' } | { kind: 'correct'; entry: Entry }>({ kind: 'view' });
  const load = () => api<Detail>('GET', `/api/logbooks/${id}`).then(setD).catch(e => setError(errorText(t, e, 'Not loaded.')));
  useEffect(() => { void load(); }, [id]);
  if (error) return <Alert>{error}</Alert>;
  if (!d) return <p role="status">{t('Loading…')}</p>;
  const done = () => { setMode({ kind: 'view' }); void load(); };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" onClick={onBack}>{t('Back to logbooks')}</Button>
        <h2 className="text-xl font-bold">{d.objectCode} · {d.name}</h2><StatusBadge status={d.derived.status} /></div>
      {d.derived.reasons.length ? <Alert kind="info">{d.derived.reasons.join('; ')}</Alert> : null}
      <p className="text-base text-slate-700">{d.typeName}{d.location ? ` · ${d.location}` : ''}{d.derived.calibrationDue ? ` · ${t('calibration due {date}', { date: d.derived.calibrationDue.slice(0, 10) })}` : ''}</p>
      {d.status !== 'active' ? <Alert kind="info">{t('This logbook is retired: it can be read, not written.')}</Alert> : null}
      {mode.kind === 'view' && d.status === 'active' && d.definition ? <div><Button onClick={() => setMode({ kind: 'new' })}>{t('New entry')}</Button></div> : null}
      {mode.kind === 'new' && d.definition ? <EntryForm logbookId={d.id} kinds={d.definition.entryKinds} onSaved={done} onCancel={() => setMode({ kind: 'view' })} /> : null}
      {mode.kind === 'correct' && d.definition ? <EntryForm logbookId={d.id} kinds={d.definition.entryKinds} correcting={mode.entry} onSaved={done} onCancel={() => setMode({ kind: 'view' })} /> : null}
      <ol className="flex flex-col gap-3" aria-label={t('Entries')}>
        {[...d.entries].reverse().map(e => (
          <li key={e.id} className={`rounded-xl border bg-white p-3 ${e.correctedBy ? 'border-slate-300 opacity-75' : 'border-slate-300'}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-base font-bold">#{e.id} {e.kindLabel}{e.correctedBy ? <span className="ms-2 text-sm font-semibold text-amber-800">{t('corrected by #{id}', { id: e.correctedBy })}</span> : null}</p>
              <p className="text-sm text-slate-600">{formatWhen(lang, e.recordedAt)} · {e.signedBy} · {t(`meaning.${e.meaning}`)}</p>
            </div>
            {e.correctsEntryId ? <p className="text-sm text-amber-900">{t('Corrects #{id}: {reason}', { id: e.correctsEntryId, reason: e.correctionReason })}</p> : null}
            <dl className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">{Object.entries(e.values).map(([k, v]) => <div key={k} className="flex gap-2 text-base"><dt className="font-semibold">{k}:</dt><dd>{String(v)}</dd></div>)}</dl>
            {e.flags.length ? <p className="mt-1 text-base font-semibold text-red-800">{t('Outside limits: {list}', { list: e.flags.map(f => f.message).join('; ') })}</p> : null}
            {e.comment ? <p className="mt-1 text-base">{t('Comment: {text}', { text: e.comment })}</p> : null}
            {!e.correctedBy && d.status === 'active' && mode.kind === 'view' ? <Button variant="secondary" className="mt-2" onClick={() => setMode({ kind: 'correct', entry: e })}>{t('Correct')}</Button> : null}
          </li>
        ))}
      </ol>
      <a className="inline-flex min-h-11 items-center text-base text-sky-800 underline" href={`/api/logbooks/${d.id}/export`}>{t('Export as PDF')}</a>
      {d.status === 'active' && me.permissions.includes('logbook.manage') && mode.kind === 'view' ? <ManageLogbook d={d} onDone={() => void load()} /> : null}
    </div>
  );
}

function Logbooks() {
  const { t } = useI18n();
  const [list, setList] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!open) { api<Summary[]>('GET', '/api/logbooks?status=active').then(setList).catch(e => setError(errorText(t, e, 'Not loaded.'))); void api<Me>('GET', '/api/auth/me').then(setMe); } }, [open]);
  if (open && me) return <LogbookView id={open} me={me} onBack={() => setOpen(null)} />;
  if (error) return <Alert>{error}</Alert>;
  if (!list || !me) return <p role="status">{t('Loading…')}</p>;
  return (
    <div className="flex flex-col gap-4">
    {me.permissions.includes('logbook.manage') ? (creating ? <Card title={t('New logbook')}><NewLogbook onCreated={id => { setCreating(false); setOpen(id); }} /></Card> : <div><Button onClick={() => setCreating(true)}>{t('New logbook')}</Button></div>) : null}
    <Card title={t('Logbooks')}>
      {list.length === 0 ? <p className="text-base">{t('No logbook yet. A supervisor creates them.')}</p> : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label={t('Logbooks list')}>
          {list.map(l => (
            <li key={l.id}>
              <button type="button" onClick={() => setOpen(l.id)} className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-300 bg-white p-3 text-start hover:bg-slate-50">
                <span className="flex w-full flex-wrap items-center justify-between gap-2"><span className="text-base font-bold">{l.objectCode} · {l.name}</span><StatusBadge status={l.derived.status} /></span>
                <span className="text-sm text-slate-700">{l.typeName}{l.location ? ` · ${l.location}` : ''} · {t('{n} entries', { n: l.entryCount })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </div>
  );
}
export const screen: Screen = { id: 'logbooks', title: 'Logbooks', order: 10, permission: 'logbook.read', Component: Logbooks };
