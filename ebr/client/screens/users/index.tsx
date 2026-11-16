import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorText, formatWhen, useI18n } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type User = { id: string; username: string; displayName: string; roles: string[]; status: string; secondFactor: boolean; lockedUntil: string | null; version: number };
const ROLES = ['operator', 'supervisor', 'qa', 'admin'];

function RoleChoice({ name, value }: { name: string; value?: string[] }) {
  const { t } = useI18n();
  return (
    <fieldset className="flex flex-col gap-1"><legend className="text-sm font-semibold text-slate-700">{t('Roles *')}</legend>
      <div className="flex flex-wrap gap-2">{ROLES.map(r => (
        <label key={r} className="flex min-h-11 min-w-11 items-center gap-2 rounded-lg border border-slate-400 bg-white px-3 text-base">
          <input type="checkbox" name={name} value={r} defaultChecked={value?.includes(r)} className="size-11 shrink-0" />{t(`role.${r}`)}</label>))}</div>
    </fieldset>
  );
}

/** E32#2: one account, its roles and status changed with a reason (audited), and an unlock after failed sign-ins. */
function UserRow({ u, onDone }: { u: User; onDone: () => void }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = u.lockedUntil && u.lockedUntil > new Date().toISOString();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const roles = f.getAll('roles').map(String);
    try { await api('PATCH', `/api/users/${u.id}`, { version: u.version, reason: String(f.get('reason') ?? ''), displayName: String(f.get('displayName') ?? u.displayName), roles, status: String(f.get('status') ?? u.status) }); setOpen(false); setError(null); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not saved.')); }
  }
  async function unlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api('POST', `/api/users/${u.id}/unlock`, { reason: String(new FormData(e.currentTarget).get('reason') ?? '') }); setError(null); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not done.')); }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
      <p className="text-base"><b dir="ltr">{u.username}</b> · {u.displayName} · {u.roles.map(r => t(`role.${r}`)).join(lang === 'ar' ? '، ' : ', ')} · {t(`status.${u.status}`)}{u.secondFactor ? ` · ${t('authenticator set up')}` : ''}</p>
      {locked ? <Alert>{t('Locked until {when} after failed sign-ins.', { when: formatWhen(lang, u.lockedUntil!) })}</Alert> : null}
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setOpen(o => !o)}>{open ? t('Close') : t('Change')}</Button></div>
      {open ? (
        <form onSubmit={save} className="flex flex-col gap-3 rounded-lg bg-slate-50 p-2" aria-label={t('Change account {name}', { name: u.username })}>
          <TextField label={t('Full name *')} name="displayName" defaultValue={u.displayName} required />
          <RoleChoice name="roles" value={u.roles} />
          <div className="flex flex-col gap-1"><label htmlFor={`st-${u.id}`} className="text-sm font-semibold text-slate-700">{t('Status')}</label>
            <select id={`st-${u.id}`} name="status" defaultValue={u.status} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-base">
              <option value="active">{t('status.active')}</option><option value="disabled">{t('status.disabled')}</option></select></div>
          <TextField label={t('Reason *')} name="reason" required minLength={3} />
          <div><Button type="submit">{t('Save')}</Button></div>
        </form>) : null}
      {locked ? (
        <form onSubmit={unlock} className="flex flex-col gap-2 rounded-lg bg-slate-50 p-2" aria-label={t('Unlock {name}', { name: u.username })}>
          <TextField label={t('Reason *')} name="reason" required minLength={3} />
          <div><Button type="submit">{t('Unlock')}</Button></div>
        </form>) : null}
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

function Users() {
  const { t } = useI18n();
  const [list, setList] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const load = () => { void api<User[]>('GET', '/api/users').then(setList).catch(e => setError(errorText(t, e, 'Not loaded.'))); };
  useEffect(load, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    try {
      const u = await api<User>('POST', '/api/users', { username: String(f.get('username') ?? ''), displayName: String(f.get('displayName') ?? ''), roles: f.getAll('roles').map(String), password: String(f.get('password') ?? '') });
      form.reset(); setError(null); setCreated(u.username); load();
    } catch (err) { setError(errorText(t, err, 'Not created.')); setCreated(null); }
  }
  if (!list) return error ? <Alert>{error}</Alert> : <p role="status">{t('Loading…')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('New account')}>
        <form onSubmit={create} className="flex flex-col gap-3" aria-label={t('New account')}>
          <div className="grid gap-3 md:grid-cols-2">
            <TextField label={t('User name *')} name="username" required pattern="[a-zA-Z0-9._-]{3,50}" dir="ltr" autoCapitalize="none" />
            <TextField label={t('Full name *')} name="displayName" required />
          </div>
          <RoleChoice name="roles" />
          <TextField label={t('First password *')} name="password" type="password" autoComplete="new-password" required dir="ltr" hint={t('At least 12 characters, not containing the user name. The user chooses a new one at the first sign-in.')} />
          <div><Button type="submit">{t('Create account')}</Button></div>
          {created ? <Alert kind="info">{t('Account {name} created. QA and administrators set up their authenticator at the first sign-in.', { name: created })}</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
        </form>
      </Card>
      <Card title={t('Accounts')}>
        <ul className="flex flex-col gap-2" aria-label={t('Accounts')}>{list.map(u => <UserRow key={u.id} u={u} onDone={load} />)}</ul>
      </Card>
    </div>
  );
}
export const screen: Screen = { id: 'users', title: 'Users', order: 85, permission: 'users.manage', Component: Users };
