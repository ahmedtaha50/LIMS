import { type FormEvent, useState } from 'react';
import { api } from '../api.js';
import { errorText, useT } from '../i18n/index.js';
import { Alert, Button, Card, TextField } from '../ui/index.js';

/** First sign-in: the password given by the administrator is replaced before anything else is possible. */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = String(f.get('next') ?? ''), again = String(f.get('again') ?? '');
    if (next !== again) { setError(t('The two new passwords are not the same.')); return; }
    try { await api('POST', '/api/auth/password', { current: String(f.get('current') ?? ''), next }); onDone(); }
    catch (err) { setError(errorText(t, err, 'The password was not changed.')); }
  }
  return (
    <main className="mx-auto max-w-md p-4">
      <Card title={t('Choose your own password')}>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label={t('Change password')}>
          <TextField label={t('Current password')} name="current" type="password" autoComplete="current-password" required dir="ltr" />
          <TextField label={t('New password')} name="next" type="password" autoComplete="new-password" required hint={t('At least 12 characters, not containing your user name.')} dir="ltr" />
          <TextField label={t('New password again')} name="again" type="password" autoComplete="new-password" required dir="ltr" />
          {error ? <Alert>{error}</Alert> : null}
          <Button type="submit">{t('Change password')}</Button>
        </form>
      </Card>
    </main>
  );
}

/** QA and administrator accounts set up the authenticator app before they can use their permissions. */
export function SecondFactorSetup({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    try { setSecret(await api('POST', '/api/auth/totp/enroll')); setError(null); }
    catch (err) { setError(errorText(t, err, 'The set-up could not start.')); }
  }
  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api('POST', '/api/auth/totp/confirm', { code: String(new FormData(e.currentTarget).get('code') ?? '') }); onDone(); }
    catch (err) { setError(errorText(t, err, 'The code was not accepted.')); }
  }
  return (
    <main className="mx-auto max-w-md p-4">
      <Card title={t('Set up your authenticator app')}>
        <p className="mb-3 text-base text-slate-700">{t('Your role signs quality decisions, so signing in needs a code from an authenticator app on your phone.')}</p>
        {!secret ? <Button onClick={start}>{t('Start')}</Button> : (
          <form onSubmit={confirm} className="flex flex-col gap-4" aria-label={t('Confirm authenticator')}>
            <p className="text-base">{t('In the app, add an account with this key:')}</p>
            <p className="break-all rounded-lg bg-slate-100 p-3 font-mono text-lg" aria-label={t('Authenticator key')} dir="ltr">{secret.secret}</p>
            <a className="inline-flex min-h-11 items-center text-base text-sky-800 underline" href={secret.otpauthUrl}>{t('Open in the authenticator app (on this device)')}</a>
            <TextField label={t('Code shown by the app')} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required dir="ltr" />
            <Button type="submit">{t('Confirm')}</Button>
          </form>
        )}
        {error ? <div className="mt-3"><Alert>{error}</Alert></div> : null}
      </Card>
    </main>
  );
}
