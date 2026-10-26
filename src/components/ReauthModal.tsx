import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, Unlock } from 'lucide-react';
import { ApiError, errorMessage, reauth } from '../lib/api';
import { useToast } from './ui/Toast';

/**
 * The lock screen. It is rendered over the application, never instead of it: the page behind keeps its state, so a half-typed form is
 * still there after the unlock, and the requests that were waiting are then repeated with the new token (see src/lib/api.ts).
 *
 * Unlocking proves the user is still there (21 CFR 11.300: the full credential set, password and authenticator code). It is not an
 * electronic signature: nothing is signed, approved or confirmed by it, and the dialog says so.
 */
export function ReauthModal({ reason, needsCode = false, onSignOut }: {
  /** 'idle': this page's inactivity timer ran out. 'server': the server refused a request because the session had been idle. */
  reason: 'idle' | 'server';
  /** Start with the authenticator field shown (otherwise it appears when the server says the account has one). */
  needsCode?: boolean;
  onSignOut: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeWanted, setCodeWanted] = useState(needsCode);
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousFocus = useRef<Element | null>(null);

  // Give the focus back to what had it (the field being edited) when the dialog goes away.
  useEffect(() => {
    previousFocus.current = document.activeElement;
    return () => { if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus(); };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reauth({
        password,
        ...(codeWanted ? (useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }) : {}),
      });
      setPassword('');
      setCode('');
      toast.success('Session unlocked. Your work on this page was kept.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_CODE_REQUIRED') {
        setCodeWanted(true); // the password was right: keep it and ask for the second factor
        setError('Enter the code from your authenticator app to continue.');
      } else {
        const message = errorMessage(err, 'The session could not be unlocked.');
        setPassword('');
        setError(message);
        toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const heading = reason === 'idle' ? 'Screen locked' : 'Session locked';
  const why = reason === 'idle'
    ? 'This screen was locked after a period of inactivity.'
    : 'Your session was locked by the server after a period of inactivity.';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xl">
      <div role="dialog" aria-modal="true" aria-labelledby="reauth-title" aria-describedby="reauth-why" className="w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-8 py-6 text-center">
          <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-3 border-4 border-slate-800">
            <KeyRound className="w-6 h-6 text-white" />
          </div>
          <h2 id="reauth-title" className="text-xl font-bold text-white">{heading}</h2>
        </div>
        <form onSubmit={submit} className="p-8 space-y-4">
          <p id="reauth-why" className="text-sm text-slate-600">
            {why} Enter your password to continue where you left off.
          </p>
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            Unlocking does not sign, approve or confirm anything. Whatever you were typing is still on the page.
          </p>
          <div>
            <label htmlFor="reauth-password" className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              id="reauth-password" name="password" type="password" required autoFocus autoComplete="current-password"
              value={password} onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none"
            />
          </div>
          {codeWanted && (
            <div>
              <label htmlFor="reauth-code" className="block text-sm font-medium text-slate-700 mb-1">{useRecovery ? 'Recovery code' : 'Authenticator code'}</label>
              <input
                id="reauth-code" name="code" type="text" required autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'} maxLength={useRecovery ? 32 : 6} placeholder={useRecovery ? '' : '000000'}
                value={code} onChange={e => setCode(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg font-mono tracking-widest focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none"
              />
              <button type="button" onClick={() => { setUseRecovery(v => !v); setCode(''); }} className="mt-1 text-xs text-blue-700 hover:underline">
                {useRecovery ? 'Use the authenticator code instead' : 'Use a recovery code'}
              </button>
            </div>
          )}
          {error && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" disabled={busy} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
            <Unlock className="w-4 h-4" /> {busy ? 'Checking...' : 'Unlock'}
          </button>
          <button type="button" onClick={onSignOut} className="w-full text-slate-500 hover:text-red-600 text-sm font-medium py-2 flex items-center justify-center gap-2">
            <LogOut className="w-4 h-4" /> Sign out instead (unsaved entries on this page are lost)
          </button>
        </form>
      </div>
    </div>
  );
}
