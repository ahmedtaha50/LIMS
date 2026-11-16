import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { errorText, formatWhen, useI18n } from '../../i18n/index.js';
import { Alert, Button, Card, TextField } from '../../ui/index.js';
import type { Screen } from '../registry.js';

type Setting = { key: string; group: string; label: string; unit: string | null; value: unknown; default: unknown; changed: boolean; rowVersion: number; updatedBy: string | null; updatedAt: string | null };
type Me = { permissions: string[] };
type Test = { url: string; reachable: boolean; serviceAccount: boolean; baseFound: boolean; message: string };

/** The group-to-role map is edited as lines "group DN = role". */
const toLines = (v: unknown) => Object.entries((v ?? {}) as Record<string, string>).map(([g, r]) => `${g} = ${r}`).join('\n');
const fromLines = (s: string) => Object.fromEntries(s.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.lastIndexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

/** One setting: its current value, the default, who changed it last, and (for an administrator) the signed change (E27#2). */
function SettingRow({ s, canChange, onDone }: { s: Setting; canChange: boolean; onDone: () => void }) {
  const { t, lang } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const isNumber = typeof s.default === 'number', isMap = typeof s.default === 'object';
  const shown = isMap ? toLines(s.value) || t('(none)') : `${String(s.value) || t('(empty)')}${s.unit ? ` ${t(`unit.${s.unit}`)}` : ''}`;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = String(f.get('value') ?? '');
    const value = isNumber ? Number(raw) : isMap ? fromLines(raw) : raw;
    try { await api('PUT', `/api/settings/${encodeURIComponent(s.key)}`, { value, rowVersion: s.rowVersion, reason: String(f.get('reason') ?? ''), password: String(f.get('password') ?? '') }); setError(null); onDone(); }
    catch (err) { setError(errorText(t, err, 'Not saved.')); }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
      <p className="text-base font-semibold">{t(`setting.${s.key}`)}</p>
      <p className="whitespace-pre-wrap text-base" dir={isMap || s.key.startsWith('directory.') ? 'ltr' : undefined}>{shown}</p>
      <p className="text-sm text-slate-600">{s.changed ? t('Changed by {name}, {when}', { name: s.updatedBy, when: formatWhen(lang, s.updatedAt!) }) : t('Default value')}</p>
      {canChange ? (
        <form onSubmit={save} className="grid gap-2 rounded-lg bg-slate-50 p-2 md:grid-cols-3" aria-label={t('Change {name}', { name: t(`setting.${s.key}`) })}>
          {isMap ? <div className="flex flex-col gap-1 md:col-span-3"><label htmlFor={`v-${s.key}`} className="text-sm font-semibold text-slate-700">{t('New value (one line per group: group = role)')}</label>
            <textarea id={`v-${s.key}`} name="value" defaultValue={toLines(s.value)} rows={3} dir="ltr" className="min-h-11 rounded-lg border border-slate-400 bg-white p-2 font-mono text-sm" /></div>
            : <TextField label={t('New value')} name="value" defaultValue={String(s.value)} type={isNumber ? 'number' : 'text'} step={isNumber ? 'any' : undefined} dir={s.key.startsWith('directory.') ? 'ltr' : undefined} />}
          <TextField label={t('Reason *')} name="reason" required minLength={5} />
          <TextField label={t('Your password (signature)')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
          <div className="md:col-span-3"><Button type="submit">{t('Sign and save')}</Button></div>
          {error ? <div className="md:col-span-3"><Alert>{error}</Alert></div> : null}
        </form>) : null}
    </li>
  );
}

/** E31#2: does the directory answer, does the service account sign in, does the search base exist. */
function DirectoryTest() {
  const t = useI18n().t;
  const [r, setR] = useState<Test | null>(null);
  const [error, setError] = useState<string | null>(null);
  const yes = (ok: boolean) => (ok ? t('yes') : t('no'));
  return (
    <div className="flex flex-col gap-2">
      <div><Button variant="secondary" onClick={() => void api<Test>('POST', '/api/settings/directory/test').then(x => { setR(x); setError(null); }).catch(e => { setR(null); setError(errorText(t, e, 'Not done.')); })}>{t('Test the connection')}</Button></div>
      {r ? <Alert kind={r.reachable && r.serviceAccount && r.baseFound ? 'info' : 'error'}>
        {t('Directory answers: {a} · service account signs in: {b} · search base found: {c}', { a: yes(r.reachable), b: yes(r.serviceAccount), c: yes(r.baseFound) })}
        <span className="block" dir="ltr">{r.message}</span></Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

function Settings() {
  const { t } = useI18n();
  const [list, setList] = useState<Setting[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { void api<Setting[]>('GET', '/api/settings').then(setList).catch(e => setError(errorText(t, e, 'Not loaded.'))); void api<Me>('GET', '/api/auth/me').then(setMe); };
  useEffect(load, []);
  if (error) return <Alert>{error}</Alert>;
  if (!list || !me) return <p role="status">{t('Loading…')}</p>;
  const canChange = me.permissions.includes('settings.manage');
  const groups = [...new Set(list.map(s => s.group))];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-slate-700">{t('Each change needs a reason and your signature, and is kept in the audit trail with the old and the new value.')}</p>
      {groups.map(g => (
        <Card key={g} title={t(`settingGroup.${g}`)}>
          {g === 'Directory' ? <p className="mb-2 text-sm text-slate-700">{t('The password of the service account is kept on the server only (EBR_LDAP_BIND_PASSWORD), never here.')}</p> : null}
          <ul className="flex flex-col gap-2">{list.filter(s => s.group === g).map(s => <SettingRow key={s.key} s={s} canChange={canChange} onDone={load} />)}</ul>
          {g === 'Directory' && canChange ? <div className="mt-3"><DirectoryTest /></div> : null}
        </Card>
      ))}
    </div>
  );
}
export const screen: Screen = { id: 'settings', title: 'Settings', order: 90, permission: 'settings.read', Component: Settings };
