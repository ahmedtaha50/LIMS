import React, { useState } from 'react';
import { Copy, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { ApiError, authApi, type SignIn } from '../lib/api';
import { useToast } from './ui/Toast';
import { localizedError, t, useLang } from '../i18n';
import { LanguageSwitch } from '../i18n/LanguageSwitch';

/**
 * Sign-in: password, then (when the account has an authenticator, or the policy requires one) a second step. The server answers the
 * password step with one of three bodies (see authApi.login): a session, `requiresTotp`, or `requireTotpSetup`. The steps are separate
 * components so each can be looked at on its own.
 */

const inputClass = 'w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none';
const errorBox = (error: string | null) => error
  ? <div role="alert" className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
  : null;

export function CredentialsForm({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(email.trim(), password); }} className="p-8">
      <div className="space-y-5">
        <div>
          <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1">{t('login.email')}</label>
          <input id="login-email" name="email" type="email" required autoComplete="username" dir="ltr" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-1">{t('login.password')}</label>
          <input id="login-password" name="password" type="password" required autoComplete="current-password" className={inputClass} value={password} onChange={e => setPassword(e.target.value)} />
        </div>
      </div>
      {errorBox(error)}
      <button type="submit" disabled={busy} className="w-full mt-6 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
        {busy ? t('login.submitting') : <><LogIn className="w-4 h-4" aria-hidden="true" /> {t('login.submit')}</>}
      </button>
    </form>
  );
}

export function TotpChallenge({ busy, error, onSubmit, onBack }: {
  busy: boolean;
  error: string | null;
  onSubmit: (input: { code: string } | { recoveryCode: string }) => void;
  onBack: () => void;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const ready = useRecovery ? value.trim().length >= 8 : /^\d{6}$/.test(value);
  return (
    <form onSubmit={e => { e.preventDefault(); if (ready) onSubmit(useRecovery ? { recoveryCode: value.trim() } : { code: value }); }} className="p-8">
      <div className="text-center mb-6">
        <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <KeyRound className="w-6 h-6 text-indigo-600" />
        </div>
        <h2 className="text-lg font-bold text-slate-800">{t('totp.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">
          {useRecovery ? t('totp.helpRecovery') : t('totp.helpApp')}
        </p>
      </div>
      <label htmlFor="login-code" className="block text-sm font-medium text-slate-700 mb-1">{useRecovery ? t('totp.recoveryLabel') : t('totp.codeLabel')}</label>
      {useRecovery
        ? <input id="login-code" name="recoveryCode" type="text" required autoFocus autoComplete="off" maxLength={32} dir="ltr" className={`${inputClass} font-mono`} value={value} onChange={e => setValue(e.target.value)} />
        : <input id="login-code" name="code" type="text" required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={6} placeholder="000000" dir="ltr" className={`${inputClass} text-center tracking-[0.5em] font-mono text-2xl`} value={value} onChange={e => setValue(e.target.value.replace(/\D/g, ''))} />}
      {errorBox(error)}
      <button type="submit" disabled={busy || !ready} className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50">
        {busy ? t('totp.verifying') : t('totp.verify')}
      </button>
      <button type="button" onClick={() => { setUseRecovery(v => !v); setValue(''); }} className="w-full mt-3 text-indigo-700 hover:underline text-sm font-medium py-1">
        {useRecovery ? t('totp.useApp') : t('totp.useRecovery')}
      </button>
      <button type="button" onClick={onBack} className="w-full mt-1 text-slate-500 hover:text-slate-700 text-sm font-medium py-2">
        {t('login.back')}
      </button>
    </form>
  );
}

export function TotpEnrolment({ qrCode, secret, busy, error, onSubmit, onBack }: {
  qrCode: string;
  secret: string;
  busy: boolean;
  error: string | null;
  onSubmit: (code: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); if (/^\d{6}$/.test(code)) onSubmit(code); }} className="p-8">
      <div className="text-center mb-4">
        <h2 className="text-lg font-bold text-slate-800">{t('enrol.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">{t('enrol.help')}</p>
      </div>
      <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 mb-3 flex justify-center">
        <img src={qrCode} alt={t('enrol.qrAlt')} className="w-40 h-40" />
      </div>
      <p className="text-xs text-slate-500 text-center">{t('enrol.cannotScan')}</p>
      <p className="mt-1 text-center"><code dir="ltr" className="font-mono text-sm bg-slate-100 border border-slate-200 rounded px-2 py-1 break-all select-all">{secret}</code></p>
      <label htmlFor="enrol-code" className="block text-sm font-medium text-slate-700 mt-5 mb-1">{t('totp.codeLabel')}</label>
      <input id="enrol-code" name="code" type="text" required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={6} placeholder="000000" dir="ltr"
        className={`${inputClass} text-center tracking-[0.5em] font-mono text-2xl`} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
      {errorBox(error)}
      <button type="submit" disabled={busy || code.length !== 6} className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50">
        {busy ? t('totp.verifying') : t('enrol.confirm')}
      </button>
      <button type="button" onClick={onBack} className="w-full mt-3 text-slate-500 hover:text-slate-700 text-sm font-medium py-2">{t('login.back')}</button>
    </form>
  );
}

/** Shown once, straight after enrolment: they are the only way in if the phone is lost, and the server cannot show them again. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { toast } = useToast();
  const [stored, setStored] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast.success(t('recovery.copied'));
    } catch {
      toast.error(t('recovery.copyFailed'));
    }
  };
  return (
    <div className="p-8">
      <div className="text-center mb-4">
        <h2 className="text-lg font-bold text-slate-800">{t('recovery.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">{t('recovery.help')}</p>
      </div>
      <ul dir="ltr" className="grid grid-cols-2 gap-2 font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg p-4">
        {codes.map(c => <li key={c} className="select-all">{c}</li>)}
      </ul>
      <button type="button" onClick={copy} className="mt-3 text-sm text-blue-700 hover:underline inline-flex items-center gap-1.5"><Copy className="w-4 h-4" aria-hidden="true" /> {t('recovery.copyAll')}</button>
      <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={stored} onChange={e => setStored(e.target.checked)} className="mt-1" />
        <span>{t('recovery.stored')}</span>
      </label>
      <button type="button" disabled={!stored} onClick={onDone} className="w-full mt-5 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50">{t('recovery.continue')}</button>
    </div>
  );
}

type Step =
  | { kind: 'credentials' }
  | { kind: 'totp'; tempToken: string }
  | { kind: 'enrol'; tempToken: string; qrCode: string; secret: string }
  | { kind: 'recovery-codes'; signIn: SignIn };

export function Login({ onLogin, notice }: { onLogin: (signIn: SignIn) => void; notice?: string | null }) {
  useLang();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Runs one step against the server; a failure is shown on the screen and as a message, and the user stays where they are. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      const message = localizedError(err, 'login.failed');
      setError(message);
      toast.error(message);
      // The second step's challenge lasts 5 minutes and works once: when it is gone, begin again instead of retrying a dead one.
      if (err instanceof ApiError && (err.code === 'INVALID_TOKEN' || err.code === 'ACCOUNT_LOCKED')) setStep({ kind: 'credentials' });
    } finally {
      setBusy(false);
    }
  }

  const finish = (signIn: SignIn) => {
    if (signIn.recoveryCodes && signIn.recoveryCodes.length) setStep({ kind: 'recovery-codes', signIn });
    else onLogin(signIn);
  };

  const submitCredentials = (email: string, password: string) => run(async () => {
    const result = await authApi.login(email, password);
    if (result.kind === 'totp') setStep({ kind: 'totp', tempToken: result.tempToken });
    else if (result.kind === 'totp-setup') setStep({ kind: 'enrol', tempToken: result.tempToken, qrCode: result.qrCode, secret: result.secret });
    else finish(result.signIn);
  });

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white max-w-md w-full rounded-xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-slate-900 p-8 text-center">
          <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg border-4 border-slate-800">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">B-Pharma LIMS</h1>
          <p className="text-slate-400 text-sm mt-2">{t('login.notice')}</p>
        </div>
        <div className="flex justify-end px-8 pt-4"><LanguageSwitch signedIn={false} /></div>

        {notice && step.kind === 'credentials' && (
          <div role="alert" className="mx-8 mt-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{notice}</div>
        )}

        {step.kind === 'credentials' && <CredentialsForm busy={busy} error={error} onSubmit={submitCredentials} />}
        {step.kind === 'totp' && (
          <TotpChallenge busy={busy} error={error} onBack={() => { setStep({ kind: 'credentials' }); setError(null); }}
            onSubmit={input => run(async () => finish(await authApi.verifyTotp({ tempToken: step.tempToken, ...input })))} />
        )}
        {step.kind === 'enrol' && (
          <TotpEnrolment qrCode={step.qrCode} secret={step.secret} busy={busy} error={error} onBack={() => { setStep({ kind: 'credentials' }); setError(null); }}
            onSubmit={code => run(async () => finish(await authApi.setupTotp({ tempToken: step.tempToken, code })))} />
        )}
        {step.kind === 'recovery-codes' && <RecoveryCodes codes={step.signIn.recoveryCodes ?? []} onDone={() => onLogin(step.signIn)} />}
      </div>
    </div>
  );
}
