import { type FormEvent, useState } from 'react';
import { api } from '../api.js';
import { errorText, useI18n } from '../i18n/index.js';
import { Alert, Button, TextField } from '../ui/index.js';
import { LanguageSwitch, type Me } from './Shell.js';

export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const { t, setLang } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      const body: Record<string, string> = { username: String(f.get('username') ?? ''), password: String(f.get('password') ?? '') };
      const totp = String(f.get('totp') ?? '');
      if (totp) body.totp = totp;
      onSignedIn(await api<Me>('POST', '/api/auth/login', body));
    } catch (err) {
      setError(errorText(t, err, 'Sign-in failed.'));
    } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-bold">{t('B-Pharma EBR & Logbook')}</h1>
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label={t('Sign in')}>
        <TextField label={t('User name')} name="username" autoComplete="username" required autoCapitalize="none" dir="ltr" />
        <TextField label={t('Password')} name="password" type="password" autoComplete="current-password" required dir="ltr" />
        <TextField label={t('Authenticator code')} name="totp" inputMode="numeric" autoComplete="one-time-code" hint={t('Only for QA and administrator accounts.')} dir="ltr" />
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</Button>
      </form>
      {/* after the form, so the keyboard reaches the user name first (E05#2) */}
      <div className="flex justify-center"><LanguageSwitch onChange={setLang} /></div>
    </main>
  );
}
