import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Alert, Button, TextField } from '../ui/index.js';
import type { Me } from './Shell.js';

export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
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
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-bold">B-Pharma EBR &amp; Logbook</h1>
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Sign in">
        <TextField label="User name" name="username" autoComplete="username" required autoCapitalize="none" />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
        <TextField label="Authenticator code" name="totp" inputMode="numeric" autoComplete="one-time-code" hint="Only for QA and administrator accounts." />
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </main>
  );
}
