import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Alert, Button, Card, TextField } from '../ui/index.js';

/** First sign-in: the password given by the administrator is replaced before anything else is possible. */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = String(f.get('next') ?? ''), again = String(f.get('again') ?? '');
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    try { await api('POST', '/api/auth/password', { current: String(f.get('current') ?? ''), next }); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'The password was not changed.'); }
  }
  return (
    <main className="mx-auto max-w-md p-4">
      <Card title="Choose your own password">
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Change password">
          <TextField label="Current password" name="current" type="password" autoComplete="current-password" required />
          <TextField label="New password" name="next" type="password" autoComplete="new-password" required hint="At least 12 characters, not containing your user name." />
          <TextField label="New password again" name="again" type="password" autoComplete="new-password" required />
          {error ? <Alert>{error}</Alert> : null}
          <Button type="submit">Change password</Button>
        </form>
      </Card>
    </main>
  );
}

/** QA and administrator accounts set up the authenticator app before they can use their permissions. */
export function SecondFactorSetup({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    try { setSecret(await api('POST', '/api/auth/totp/enroll')); setError(null); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'The set-up could not start.'); }
  }
  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api('POST', '/api/auth/totp/confirm', { code: String(new FormData(e.currentTarget).get('code') ?? '') }); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'The code was not accepted.'); }
  }
  return (
    <main className="mx-auto max-w-md p-4">
      <Card title="Set up your authenticator app">
        <p className="mb-3 text-base text-slate-700">Your role signs quality decisions, so signing in needs a code from an authenticator app on your phone.</p>
        {!secret ? <Button onClick={start}>Start</Button> : (
          <form onSubmit={confirm} className="flex flex-col gap-4" aria-label="Confirm authenticator">
            <p className="text-base">In the app, add an account with this key:</p>
            <p className="break-all rounded-lg bg-slate-100 p-3 font-mono text-lg" aria-label="Authenticator key">{secret.secret}</p>
            <a className="inline-flex min-h-11 items-center text-base text-sky-800 underline" href={secret.otpauthUrl}>Open in the authenticator app (on this device)</a>
            <TextField label="Code shown by the app" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required />
            <Button type="submit">Confirm</Button>
          </form>
        )}
        {error ? <div className="mt-3"><Alert>{error}</Alert></div> : null}
      </Card>
    </main>
  );
}
