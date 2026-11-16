import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { errorText, useT } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { FieldDef, KindDef } from '../logbooks/EntryForm.js';
import type { Screen } from '../registry.js';

type Version = { id: string; versionNo: number; status: string; authorName: string; approvedBy: string | null; rowVersion: number; needsQaReview: boolean; qaReviewedBy: string | null; definition: { entryKinds: KindDef[]; tracksStatus?: boolean } };
type LType = { id: string; code: string; name: string; description: string; builtIn: boolean; versions: Version[] };
type Me = { userId: string; permissions: string[] };
const TYPES: FieldDef['type'][] = ['text', 'number', 'datetime', 'choice', 'boolean'];
const keyOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';

/** Builds a logbook type without code (E21#1): entry kinds, and fields of the five kinds the engine knows. */
/** Creates a type, or (E32#4) edits the draft version of an existing one: the same designer for both. */
function Designer({ onCreated, editing }: { onCreated: () => void; editing?: { lt: LType; v: Version } }) {
  const t = useT();
  const [kinds, setKinds] = useState<KindDef[]>(editing ? editing.v.definition.entryKinds : [{ key: 'entry', label: 'Entry', fields: [] }]);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const setKind = (i: number, k: KindDef) => setKinds(ks => ks.map((x, j) => (j === i ? k : x)));
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      if (editing) await api('PUT', `/api/logbook-types/${editing.lt.id}/versions/${editing.v.id}`, { rowVersion: editing.v.rowVersion, definition: { ...editing.v.definition, entryKinds: kinds } });
      else await api('POST', '/api/logbook-types', { code: String(f.get('code')), name: String(f.get('name')), description: String(f.get('description') ?? ''), definition: { entryKinds: kinds } });
      onCreated();
    } catch (err) {
      setError(errorText(t, err, 'Not created.'));
      const d = err instanceof ApiError ? err.details : undefined;
      setDetails(Array.isArray(d) ? d.map(x => (typeof x === 'string' ? x : `${x.path}: ${x.message}`)) : []);
    }
  }
  return (
    <form onSubmit={create} className="flex flex-col gap-4" aria-label={editing ? t('Edit draft') : t('New logbook type')}>
      {editing ? null : <><div className="grid gap-4 md:grid-cols-2">
        <TextField label={t('Code *')} name="code" required pattern="[a-z][a-z0-9_-]{1,39}" hint={t('Lowercase, for example balance-daily')} dir="ltr" />
        <TextField label={t('Name *')} name="name" required />
      </div>
      <TextField label={t('Description')} name="description" /></>}
      {kinds.map((k, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-xl border border-slate-300 p-3">
          <legend className="px-1 text-base font-bold">{t('Entry kind {n}', { n: i + 1 })}</legend>
          <TextField label={t('Name of the entry kind')} value={k.label} onChange={e => setKind(i, { ...k, label: e.target.value, key: keyOf(e.target.value) })} />
          {k.fields.map((fd, j) => (
            <div key={j} className="grid gap-2 rounded-lg bg-slate-50 p-2 md:grid-cols-3">
              <TextField label={t('Field label')} value={fd.label} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, label: e.target.value, key: keyOf(e.target.value) } : x)) })} />
              <div className="flex flex-col gap-1"><label htmlFor={`t-${i}-${j}`} className="text-sm font-semibold text-slate-700">{t('Type')}</label>
                <select id={`t-${i}-${j}`} value={fd.type} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { key: x.key, label: x.label, type: e.target.value as FieldDef['type'], ...(e.target.value === 'choice' ? { choices: ['', ''] } : {}) } : x)) })} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
                  {TYPES.map(ty => <option key={ty} value={ty}>{t(`fieldType.${ty}`)}</option>)}</select></div>
              <label className="flex min-h-11 items-center gap-2 text-base"><input type="checkbox" className="size-11 shrink-0" checked={!!fd.required} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, required: e.target.checked } : x)) })} />{t('Required')}</label>
              {fd.type === 'number' ? <>
                <TextField label={t('Unit')} value={fd.unit ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, unit: e.target.value } : x)) })} />
                <TextField label={t('Lower limit')} type="number" step="any" value={fd.min ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => { if (n !== j) return x; const { min: _m, ...rest } = x; void _m; return e.target.value === '' ? rest : { ...rest, min: Number(e.target.value) }; }) })} />
                <TextField label={t('Upper limit')} type="number" step="any" value={fd.max ?? ''} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => { if (n !== j) return x; const { max: _m, ...rest } = x; void _m; return e.target.value === '' ? rest : { ...rest, max: Number(e.target.value) }; }) })} />
              </> : null}
              {fd.type === 'choice' ? <TextField label={t('Choices (comma between them)')} value={(fd.choices ?? []).join(',')} onChange={e => setKind(i, { ...k, fields: k.fields.map((x, n) => (n === j ? { ...x, choices: e.target.value.split(',').map(s => s.trim()) } : x)) })} /> : null}
            </div>
          ))}
          <div><Button variant="secondary" onClick={() => setKind(i, { ...k, fields: [...k.fields, { key: `field_${k.fields.length + 1}`, label: `Field ${k.fields.length + 1}`, type: 'text' }] })}>{t('Add field')}</Button></div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setKinds(ks => [...ks, { key: `entry_${ks.length + 1}`, label: `Entry ${ks.length + 1}`, fields: [] }])}>{t('Add entry kind')}</Button>
        <Button type="submit">{editing ? t('Save draft') : t('Create as draft')}</Button>
      </div>
      {error ? <Alert>{error}{details.length ? <ul className="mt-1 list-disc ps-5">{details.map(d => <li key={d}>{d}</li>)}</ul> : null}</Alert> : null}
    </form>
  );
}

function VersionActions({ lt, v, me, onDone }: { lt: LType; v: Version; me: Me; onDone: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = (p: string) => me.permissions.includes(p);
  async function act(e: FormEvent<HTMLFormElement>, what: 'submit' | 'approve' | 'reject' | 'qa-review') {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { rowVersion: v.rowVersion, password: String(f.get('password') ?? '') };
    if (what === 'reject') body.reason = String(f.get('note') ?? '');
    if (what === 'approve' && f.get('note')) body.comment = String(f.get('note'));
    // E28: the QA review of a built-in type takes the password and a remark, not a record version
    const send = what === 'qa-review' ? { password: body.password, comment: String(f.get('note') ?? '') } : body;
    try { await api('POST', `/api/logbook-types/${lt.id}/versions/${v.id}/${what}`, send); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not done.')); }
  }
  const sign = (what: 'submit' | 'approve' | 'reject' | 'qa-review', label: string, note?: string) => (
    <form onSubmit={e => void act(e, what)} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('{action} version {n}', { action: label, n: v.versionNo })}>
      {note ? <TextField label={note} name="note" required={what === 'reject' || what === 'qa-review'} /> : null}
      <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
      <Button type="submit" variant={what === 'reject' ? 'danger' : 'primary'}>{label}</Button>
    </form>
  );
  return (
    <div className="flex flex-col gap-2">
      {v.needsQaReview ? <Alert kind="info">{t('Built in: waits for the QA review before anything is written with it.')}</Alert> : null}
      {v.needsQaReview && can('logbook.type.approve') ? sign('qa-review', t('Reviewed (QA)'), t('Remark *')) : null}
      {v.status === 'draft' && can('logbook.type.design') ? <div><Button variant="secondary" onClick={() => setEditing(x => !x)}>{editing ? t('Close') : t('Edit draft')}</Button></div> : null}
      {editing ? <Designer editing={{ lt, v }} onCreated={() => { setEditing(false); onDone(); }} /> : null}
      {v.status === 'draft' && can('logbook.type.design') ? sign('submit', t('Sign as author and send to QA')) : null}
      {v.status === 'in_review' && can('logbook.type.approve') ? <div className="grid gap-2 md:grid-cols-2">{sign('approve', t('Approve (QA)'), t('Comment'))}{sign('reject', t('Send back'), t('Reason *'))}</div> : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

function LogbookTypes() {
  const t = useT();
  const [types, setTypes] = useState<LType[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [designing, setDesigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => { void api<LType[]>('GET', '/api/logbook-types').then(setTypes); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (!types || !me) return <p role="status">{t('Loading…')}</p>;
  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert>{error}</Alert> : null}
      {me.permissions.includes('logbook.type.design') ? (designing ? <Card title={t('New logbook type')}><Designer onCreated={() => { setDesigning(false); load(); }} /></Card> : <div><Button onClick={() => setDesigning(true)}>{t('New logbook type')}</Button></div>) : null}
      {types.map(lt => (
        <Card key={lt.id} title={`${lt.name}${lt.builtIn ? ` (${t('built in')})` : ''}`}>
          <p className="mb-2 text-sm text-slate-700">{t('Code {code}', { code: lt.code })}{lt.description ? ` · ${lt.description}` : ''}</p>
          <ul className="flex flex-col gap-2">{lt.versions.map(v => (
            <li key={v.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
              <p className="text-base"><b>{t('Version {n}', { n: v.versionNo })}</b> · {t(`status.${v.status}`)} · {t('by {name}', { name: v.authorName })}{v.approvedBy ? ` · ${t('approved by {name}', { name: v.approvedBy })}` : ''}{v.qaReviewedBy ? ` · ${t('reviewed by QA: {name}', { name: v.qaReviewedBy })}` : ''} · {v.definition.entryKinds.map(k => k.label).join(', ')}</p>
              <VersionActions lt={lt} v={v} me={me} onDone={load} />
            </li>))}</ul>
          {me.permissions.includes('logbook.type.design') && lt.versions.some(v => v.status === 'effective') && !lt.versions.some(v => ['draft', 'in_review'].includes(v.status))
            ? <Button variant="secondary" className="mt-2" onClick={() => void api('POST', `/api/logbook-types/${lt.id}/versions`).then(() => { setError(null); load(); }).catch(e => setError(errorText(t, e, 'Not created.')))}>{t('Start a new version')}</Button> : null}
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'logbook-types', title: 'Logbook types', order: 11, permission: 'logbook.read', Component: LogbookTypes };
