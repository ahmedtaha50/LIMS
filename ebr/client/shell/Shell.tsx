import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { browserLang, I18nProvider, type Lang, useI18n } from '../i18n/index.js';
import { screens } from '../screens/registry.js';
import { Alert, Button } from '../ui/index.js';
import { ChangePassword, SecondFactorSetup } from './Account.js';
import { SignIn } from './SignIn.js';

export type Me = { userId: string; username: string; displayName: string; permissions: string[]; mustChangePassword?: boolean; mustSetUpSecondFactor?: boolean };

/** The other language, named in its own language: what the switch offers. */
export function LanguageSwitch({ onChange }: { onChange: (l: Lang) => void }) {
  const { lang } = useI18n();
  const next: Lang = lang === 'ar' ? 'en' : 'ar';
  return <Button variant="secondary" onClick={() => onChange(next)} lang={next}>{next === 'ar' ? 'العربية' : 'English'}</Button>;
}

/** Language and sign-in state: the language comes from the account once signed in (E26#1), from the browser before. */
export function Shell() {
  const [lang, setLangState] = useState<Lang>(browserLang());
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const loadPrefs = () => api<{ language: Lang }>('GET', '/api/me/preferences').then(p => setLangState(p.language)).catch(() => undefined);
  const load = () => api<Me>('GET', '/api/auth/me').then(m => { setMe(m); if (!m.mustChangePassword && !m.mustSetUpSecondFactor) void loadPrefs(); })
    .catch((e) => { if (e instanceof ApiError && e.status !== 401) setError(e.message); setMe(null); });
  useEffect(() => { void load(); }, []);
  /** Signed in, the choice is kept with the account; before, it holds for this page only (nothing is stored on the device). */
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    if (me && !me.mustChangePassword && !me.mustSetUpSecondFactor) void api('PUT', '/api/me/preferences', { language: l }).catch(() => undefined);
  }, [me]);
  return (
    <I18nProvider lang={lang} setLang={setLang}>
      <Frame me={me} error={error} onSignedIn={(m) => { setMe(m); void loadPrefs(); }} reload={() => void load()} onSignedOut={() => setMe(null)} />
    </I18nProvider>
  );
}

function Frame({ me, error, onSignedIn, reload, onSignedOut }: { me: Me | null | undefined; error: string | null; onSignedIn: (m: Me) => void; reload: () => void; onSignedOut: () => void }) {
  const { t, setLang } = useI18n();
  const [current, setCurrent] = useState('home');
  if (me === undefined) return <p className="p-4 text-base" role="status">{t('Loading…')}</p>;
  if (me === null) return <>{error ? <div className="p-4"><Alert>{error}</Alert></div> : null}<SignIn onSignedIn={onSignedIn} /></>;
  if (me.mustChangePassword) return <ChangePassword onDone={reload} />;
  if (me.mustSetUpSecondFactor) return <SecondFactorSetup onDone={reload} />;

  const allowed = screens.filter(s => s.permission === 'session' || me.permissions.includes(s.permission));
  const Active = (allowed.find(s => s.id === current) ?? allowed[0])?.Component;
  const nav = (where: string) => (
    <ul className={where === 'side' ? 'flex flex-col gap-1' : 'flex justify-around'}>
      {allowed.map(s => (
        <li key={s.id}>
          <button type="button" onClick={() => setCurrent(s.id)} aria-current={s.id === current ? 'page' : undefined}
            className={`min-h-11 min-w-11 rounded-lg px-3 text-start text-base ${s.id === current ? 'bg-sky-100 font-bold text-sky-900' : 'text-slate-800 hover:bg-slate-100'}`}>{t(s.title)}</button>
        </li>
      ))}
    </ul>
  );
  async function signOut() { await api('POST', '/api/auth/logout').catch(() => undefined); onSignedOut(); }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-2 bg-sky-900 px-4 py-2 text-white">
        <span className="text-lg font-bold">{t('B-Pharma EBR')}</span>
        <span className="flex items-center gap-3"><span className="text-base" aria-label={t('Signed in as')}>{me.displayName}</span>
          <LanguageSwitch onChange={setLang} />
          <Button variant="secondary" onClick={signOut}>{t('Sign out')}</Button></span>
      </header>
      <div className="flex flex-1">
        <nav aria-label={t('Main')} className="hidden w-56 shrink-0 border-e border-slate-200 bg-white p-2 lg:block">{nav('side')}</nav>
        <main className="min-w-0 flex-1 p-4 pb-20 lg:pb-4">{Active ? <Active /> : <Alert kind="info">{t('No screen is available for your role.')}</Alert>}</main>
      </div>
      <nav aria-label={t('Main (bottom)')} className="fixed inset-x-0 bottom-0 overflow-x-auto border-t border-slate-200 bg-white p-1 lg:hidden">{nav('bottom')}</nav>
    </div>
  );
}
