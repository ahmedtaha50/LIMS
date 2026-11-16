import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { FieldDef, KindDef } from '../logbooks/EntryForm.js';
import type { Screen } from '../registry.js';

type Version = { id: string; versionNo: number; status: string; authorName: string; approvedBy: string | null; rowVersion: number; definition: { entryKinds: KindDef[]; tracksStatus?: boolean } };
type LType = { id: string; code: string; name: string; description: string; builtIn: boolean; versions: Version[] };
type Me = { userId: string; permissions: string[] };
const TYPES: FieldDef['type'][] = ['text', 'number', 'datetime', 'choice', 'boolean'];
const keyOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';

/** Builds a logbook type without code (E21#1): entry kinds, and fields of the five kinds the engine knows. */
function Designer({ onCreated }: { onCreated: () => void }) {
  const [kinds, setKinds] = useState<KindDef[]>([{ key: 'entry', label: 'Entry', fields: [] }]);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const setKind = (i: number, k: KindDef) => setKinds(ks => ks.map((x, j) => (j === i ? k : x)));
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('POST', '/api/logbook-types', { code: String(f.get('code')), name: String(f.get('name')), description: String(f.get('description') ?? ''), definition: { entryKinds: kinds } });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Not created.');
      const d = err instanceof ApiError ? err.details : undefined;
      setDetails(Array.isArray(d) ? d.map(x => (typeof x === 'string' ? x : `${x.path}: ${x.message}`)) : []);
    }
  }
  return (
    <form onSubmit={create} className="flex flex-col gap-4" aria-label="New logbook type">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Code *" name="code" required pattern="[a-z][a-z0-9_-]{1,39}" hint="Lowercase, for example balance-daily" />
        <TextField label="Name *" name="name" required />
      </div>
      <TextField label="Description" name="description" />
      {kinds.map((k, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-xl border border-slate-300 p-3">
          <legend className="px-1 text-base font-bold">Entry kind {i + 1}</legend>
          <TextField label="Name of the entry kind" value={k.label} onChange={e => setKind(i, { ...k, label: e.target.value, key: keyOf(e.target.value) })} />
          {k.fields.map((fd, j) => (
            <div key={j} className="grid gap-2 rounded-lg bg-slate-50 p-2 md:grid-cols-3">
              <TextField label="Field label" value={fd.label} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, label: e.target.value, key: keyOf(e.target.value) } : x)) })} />
              <div className="flex flex-col gap-1"><label htmlFor={`t-${i}-${j}`} className="text-sm font-semibold text-slate-700">Type</label>
                <select id={`t-${i}-${j}`} value={fd.type} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { key: x.key, label: x.label, type: e.target.value as FieldDef['type'], ...(e.target.value === 'choice' ? { choices: ['', ''] } : {}) } : x)) })} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
              <label className="flex min-h-11 items-center gap-2 text-base"><input type="checkbox" className="size-5" checked={!!fd.required} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, required: e.target.checked } : x)) })} />Required</label>
              {fd.type === 'number' ? <>
                <TextField label="Unit" value={fd.unit ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, unit: e.target.value } : x)) })} />
                <TextField label="Lower limit" type="number" step="any" value={fd.min ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => { if (n !== j) return x; const { min: _m, ...rest } = x; void _m; return e.target.value === '' ? rest : { ...rest, min: Number(e.target.value) }; }) })} />
                <TextField label="Upper limit" type="number" step="any" value={fd.max ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => { if (n !== j) return x; const { max: _m, ...rest } = x; void _m; return e.target.value === '' ? rest : { ...rest, max: Number(e.target.value) }; }) })} />
              </> : null}
              {fd.type === 'choice' ? <TextField label="Choices (comma between them)" value={(fd.choices ?? []).join(',')} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, choices: e.target.value.split(',').map(s => s.trim()) } : x)) })} /> : null}
            </div>
          ))}
          <div><Button variant="secondary" onClick={() => setKind(i, { ...k, fields: [...k.fields, { key: `field_${k.fields.length + 1}`, label: `Field ${k.fields.length + 1}`, type: 'text' }] })}>Add field</Button></div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setKinds(ks => [...ks, { key: `entry_${ks.length + 1}`, label: `Entry ${ks.length + 1}`, fields: [] }])}>Add entry kind</Button>
        <Button type="submit">Create as draft</Button>
      </div>
      {error ? <Alert>{error}{details.length ? <ul className="mt-1 list-disc pl-5">{details.map(d => <li key={d}>{d}</li>)}</ul> : null}</Alert> : null}
    </form>
  );
}

function VersionActions({ t, v, me, onDone }: { t: LType; v: Version; me: Me; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const can = (p: string) => me.permissions.includes(p);
  async function act(e: FormEvent<HTMLFormElement>, what: 'submit' | 'approve' | 'reject') {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { rowVersion: v.rowVersion, password: String(f.get('password') ?? '') };
    if (what === 'reject') body.reason = String(f.get('note') ?? '');
    if (what === 'approve' && f.get('note')) body.comment = String(f.get('note'));
    try { await api('POST', `/api/logbook-types/${t.id}/versions/${v.id}/${what}`, body); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Not done.'); }
  }
  const sign = (what: 'submit' | 'approve' | 'reject', label: string, note?: string) => (
    <form onSubmit={e => void act(e, what)} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={`${label} version ${v.versionNo}`}>
      {note ? <TextField label={note} name="note" required={what === 'reject'} /> : null}
      <TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" variant={what === 'reject' ? 'danger' : 'primary'}>{label}</Button>
    </form>
  );
  return (
    <div className="flex flex-col gap-2">
      {v.status === 'draft' && can('logbook.type.design') ? sign('submit', 'Sign as author and send to QA') : null}
      {v.status === 'in_review' && can('logbook.type.approve') ? <div className="grid gap-2 md:grid-cols-2">{sign('approve', 'Approve (QA)', 'Comment')}{sign('reject', 'Send back', 'Reason *')}</div> : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

function LogbookTypes() {
  const [types, setTypes] = useState<LType[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [designing, setDesigning] = useState(false);
  const load = () => { void api<LType[]>('GET', '/api/logbook-types').then(setTypes); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (!types || !me) return <p role="status">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      {me.permissions.includes('logbook.type.design') ? (designing ? <Card title="New logbook type"><Designer onCreated={() => { setDesigning(false); load(); }} /></Card> : <div><Button onClick={() => setDesigning(true)}>New logbook type</Button></div>) : null}
      {types.map(t => (
        <Card key={t.id} title={`${t.name}${t.builtIn ? ' (built in)' : ''}`}>
          <p className="mb-2 text-sm text-slate-700">Code {t.code}{t.description ? ` · ${t.description}` : ''}</p>
          <ul className="flex flex-col gap-2">{t.versions.map(v => (
            <li key={v.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
              <p className="text-base"><b>Version {v.versionNo}</b> · {v.status.replace('_', ' ')} · by {v.authorName}{v.approvedBy ? ` · approved by ${v.approvedBy}` : ''} · {v.definition.entryKinds.map(k => k.label).join(', ')}</p>
              <VersionActions t={t} v={v} me={me} onDone={load} />
            </li>))}</ul>
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'logbook-types', title: 'Logbook types', order: 11, permission: 'logbook.read', Component: LogbookTypes };
