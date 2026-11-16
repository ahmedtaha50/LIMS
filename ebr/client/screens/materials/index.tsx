import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorText, useT } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type Lot = { id: string; lotNumber: string; status: string; expiry: string; decidedBy: string | null; version: number };
type Material = { code: string; name: string; unit: string; lots: Lot[] };
type Me = { permissions: string[] };

function LotRow({ l, canDecide, onDone }: { l: Lot; canDecide: boolean; onDone: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const expired = l.expiry < new Date().toISOString().slice(0, 10);
  async function decide(e: FormEvent<HTMLFormElement>, what: 'release' | 'reject') {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api('POST', `/api/material-lots/${l.id}/${what}`, { version: l.version, password: String(f.get('password') ?? ''), ...(what === 'reject' ? { reason: String(f.get('reason') ?? '') } : {}) }); onDone(); } catch (x) { setError(errorText(t, x, 'Not saved.')); }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
      <p className="text-base"><b>{l.lotNumber}</b> · {t(`status.${l.status}`)}{l.decidedBy ? ` ${t('by {name}', { name: l.decidedBy })}` : ''} · {t('expires {date}', { date: l.expiry })}{expired ? ` (${t('EXPIRED')})` : ''}</p>
      {canDecide && l.status === 'quarantine' ? (
        <div className="grid gap-2 md:grid-cols-2">
          <form onSubmit={e => void decide(e, 'release')} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('Release lot {lot}', { lot: l.lotNumber })}>
            <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" /><Button type="submit">{t('Release (QA)')}</Button></form>
          <form onSubmit={e => void decide(e, 'reject')} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('Reject lot {lot}', { lot: l.lotNumber })}>
            <TextField label={t('Reason *')} name="reason" required /><TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" /><Button type="submit" variant="danger">{t('Reject')}</Button></form>
        </div>) : null}
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

function Materials() {
  const t = useT();
  const [list, setList] = useState<Material[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { void api<Material[]>('GET', '/api/materials').then(setList); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (!list || !me) return <p role="status">{t('Loading…')}</p>;
  const can = (p: string) => me.permissions.includes(p);
  const submit = (path: (f: FormData) => string, body: (f: FormData) => unknown) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
    void api('POST', path(f), body(f)).then(() => { form.reset(); setError(null); load(); }).catch(x => setError(errorText(t, x, 'Not saved.')));
  };
  return (
    <div className="flex flex-col gap-4">
      {can('materials.manage') ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={t('New material')}><form className="flex flex-col gap-2" aria-label={t('New material')} onSubmit={submit(() => '/api/materials', f => ({ code: f.get('code'), name: f.get('name'), unit: f.get('unit') }))}>
            <TextField label={t('Code *')} name="code" required dir="ltr" /><TextField label={t('Name *')} name="name" required /><TextField label={t('Unit *')} name="unit" required defaultValue="kg" /><Button type="submit">{t('Add material')}</Button></form></Card>
          <Card title={t('Receive a lot')}><form className="flex flex-col gap-2" aria-label={t('Receive a lot')} onSubmit={submit(f => `/api/materials/${encodeURIComponent(String(f.get('material')))}/lots`, f => ({ lotNumber: f.get('lot'), expiry: f.get('expiry') }))}>
            <div className="flex flex-col gap-1"><label htmlFor="rl-m" className="text-sm font-semibold text-slate-700">{t('Material *')}</label>
              <select id="rl-m" name="material" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">{list.map(m => <option key={m.code} value={m.code}>{m.code} · {m.name}</option>)}</select></div>
            <TextField label={t('Lot number *')} name="lot" required dir="ltr" /><TextField label={t('Expiry date *')} name="expiry" type="date" required /><Button type="submit">{t('Receive (quarantine)')}</Button></form></Card>
        </div>) : null}
      {error ? <Alert>{error}</Alert> : null}
      {list.map(m => (
        <Card key={m.code} title={`${m.code} · ${m.name}`}>
          {m.lots.length ? <ul className="flex flex-col gap-2">{m.lots.map(l => <LotRow key={l.id} l={l} canDecide={can('materials.release')} onDone={load} />)}</ul> : <p className="text-base">{t('No lot received.')}</p>}
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'materials', title: 'Materials', order: 30, permission: 'materials.read', Component: Materials };
