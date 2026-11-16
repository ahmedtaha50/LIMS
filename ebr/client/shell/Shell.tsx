import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { screens } from '../screens/registry.js';
import { Alert, Button } from '../ui/index.js';
import { SignIn } from './SignIn.js';

export type Me = { userId: string; username: string; displayName: string; permissions: string[] };

/** The frame of every screen: a top bar and, on wide screens, a side list; on a tablet in portrait, a bottom bar. */
export function Shell() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState('home');
  useEffect(() => {
    api<Me>('GET', '/api/auth/me').then(setMe).catch((e) => { if (e instanceof ApiError && e.status !== 401) setError(e.message); setMe(null); });
  }, []);
  if (me === undefined) return <p className="p-4 text-base" role="status">Loading…</p>;
  if (me === null) return <>{error ? <div className="p-4"><Alert>{error}</Alert></div> : null}<SignIn onSignedIn={setMe} /></>;

  const allowed = screens.filter(s => s.permission === 'session' || me.permissions.includes(s.permission));
  const Active = (allowed.find(s => s.id === current) ?? allowed[0])?.Component;
  const nav = (where: string) => (
    <ul className={where === 'side' ? 'flex flex-col gap-1' : 'flex justify-around'}>
      {allowed.map(s => (
        <li key={s.id}>
          <button type="button" onClick={() => setCurrent(s.id)} aria-current={s.id === current ? 'page' : undefined}
            className={`min-h-11 min-w-11 rounded-lg px-3 text-left text-base ${s.id === current ? 'bg-sky-100 font-bold text-sky-900' : 'text-slate-800 hover:bg-slate-100'}`}>{s.title}</button>
        </li>
      ))}
    </ul>
  );
  async function signOut() { await api('POST', '/api/auth/logout').catch(() => undefined); setMe(null); }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-2 bg-sky-900 px-4 py-2 text-white">
        <span className="text-lg font-bold">B-Pharma EBR</span>
        <span className="flex items-center gap-3"><span className="text-base" aria-label="Signed in as">{me.displayName}</span>
          <Button variant="secondary" onClick={signOut}>Sign out</Button></span>
      </header>
      <div className="flex flex-1">
        <nav aria-label="Main" className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-2 lg:block">{nav('side')}</nav>
        <main className="min-w-0 flex-1 p-4 pb-20 lg:pb-4">{Active ? <Active /> : <Alert kind="info">No screen is available for your role.</Alert>}</main>
      </div>
      <nav aria-label="Main (bottom)" className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-1 lg:hidden">{nav('bottom')}</nav>
    </div>
  );
}
