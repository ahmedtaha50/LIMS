import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type Lot = { id: string; lotNumber: string; status: string; expiry: string; decidedBy: string | null; version: number };
type Material = { code: string; name: string; unit: string; lots: Lot[] };
type Me = { permissions: string[] };
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Not saved.');

function LotRow({ l, canDecide, onDone }: { l: Lot; canDecide: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const expired = l.expiry < new Date().toISOString().slice(0, 10);
  async function decide(e: FormEvent<HTMLFormElement>, what: 'release' | 'reject') {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api('POST', `/api/material-lots/${l.id}/${what}`, { version: l.version, password: String(f.get('password') ?? ''), ...(what === 'reject' ? { reason: String(f.get('reason') ?? '') } : {}) }); onDone(); } catch (x) { setError(err(x)); }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
      <p className="text-base"><b>{l.lotNumber}</b> · {l.status}{l.decidedBy ? ` by ${l.decidedBy}` : ''} · expires {l.expiry}{expired ? ' (EXPIRED)' : ''}</p>
      {canDecide && l.status === 'quarantine' ? (
        <div className="grid gap-2 md:grid-cols-2">
          <form onSubmit={e => void decide(e, 'release')} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={`Release lot ${l.lotNumber}`}>
            <TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required /><Button type="submit">Release (QA)</Button></form>
          <form onSubmit={e => void decide(e, 'reject')} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={`Reject lot ${l.lotNumber}`}>
            <TextField label="Reason *" name="reason" required /><TextField label="Your password (signature)" name="password" type="password" autoComplete="current-password" required /><Button type="submit" variant="danger">Reject</Button></form>
        </div>) : null}
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

function Materials() {
  const [list, setList] = useState<Material[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { void api<Material[]>('GET', '/api/materials').then(setList); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (!list || !me) return <p role="status">Loading…</p>;
  const can = (p: string) => me.permissions.includes(p);
  const submit = (path: (f: FormData) => string, body: (f: FormData) => unknown) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
    void api('POST', path(f), body(f)).then(() => { form.reset(); setError(null); load(); }).catch(x => setError(err(x)));
  };
  return (
    <div className="flex flex-col gap-4">
      {can('materials.manage') ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="New material"><form className="flex flex-col gap-2" aria-label="New material" onSubmit={submit(() => '/api/materials', f => ({ code: f.get('code'), name: f.get('name'), unit: f.get('unit') }))}>
            <TextField label="Code *" name="code" required /><TextField label="Name *" name="name" required /><TextField label="Unit *" name="unit" required defaultValue="kg" /><Button type="submit">Add material</Button></form></Card>
          <Card title="Receive a lot"><form className="flex flex-col gap-2" aria-label="Receive a lot" onSubmit={submit(f => `/api/materials/${encodeURIComponent(String(f.get('material')))}/lots`, f => ({ lotNumber: f.get('lot'), expiry: f.get('expiry') }))}>
            <div className="flex flex-col gap-1"><label htmlFor="rl-m" className="text-sm font-semibold text-slate-700">Material *</label>
              <select id="rl-m" name="material" required className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">{list.map(m => <option key={m.code} value={m.code}>{m.code} · {m.name}</option>)}</select></div>
            <TextField label="Lot number *" name="lot" required /><TextField label="Expiry date *" name="expiry" type="date" required /><Button type="submit">Receive (quarantine)</Button></form></Card>
        </div>) : null}
      {error ? <Alert>{error}</Alert> : null}
      {list.map(m => (
        <Card key={m.code} title={`${m.code} · ${m.name}`}>
          {m.lots.length ? <ul className="flex flex-col gap-2">{m.lots.map(l => <LotRow key={l.id} l={l} canDecide={can('materials.release')} onDone={load} />)}</ul> : <p className="text-base">No lot received.</p>}
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'materials', title: 'Materials', order: 30, permission: 'materials.read', Component: Materials };
