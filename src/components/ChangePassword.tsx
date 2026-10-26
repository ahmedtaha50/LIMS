import React, { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { ApiError, authApi, errorMessage, refreshMe } from '../lib/api';
import { useToast } from './ui/Toast';

/**
 * The change-password screen. `forced` is the required step: the password is temporary (an administrator created or reset the account)
 * or has expired, and the server refuses every other request (403 PASSWORD_CHANGE_REQUIRED) until it is changed. The rules themselves
 * (length, character classes, history, common passwords) are the server's; this screen only shows what it says.
 */
export function ChangePassword({ forced, userName, onChanged, onSignOut, onCancel }: {
  forced: boolean;
  userName?: string;
  /** Called after the password was changed and the session was re-read from the server. */
  onChanged: () => void;
  onSignOut?: () => void;
  /** Only for a voluntary change; a forced one cannot be cancelled. */
  onCancel?: () => void;
}) {
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next !== confirm) { setProblems(['The new password and its confirmation do not match.']); return; }
    if (next === current) { setProblems(['The new password must differ from the current one.']); return; }
    setBusy(true);
    setProblems([]);
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      await refreshMe(); // the flag that sent the user here is cleared on the server; the application opens when the store says so
      toast.success('Password changed.');
      onChanged();
    } catch (err) {
      const lines = err instanceof ApiError && err.code === 'PASSWORD_POLICY' && Array.isArray(err.details) && err.details.length
        ? [...new Set((err.details as Array<{ message?: string }>).map(d => d.message).filter((m): m is string => !!m))]
        : [errorMessage(err, 'The password could not be changed.')];
      setProblems(lines);
      toast.error(lines[0]);
    } finally {
      setBusy(false);
    }
  };

  const field = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string, autoFocus = false) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <input id={id} name={id} type="password" required autoFocus={autoFocus} autoComplete={autoComplete} value={value} onChange={e => set(e.target.value)}
        className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white max-w-md w-full rounded-xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-slate-900 p-8 text-center">
          <div className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-3 border-4 border-slate-800">
            <KeyRound className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">Change password</h1>
          {userName && <p className="text-slate-400 text-sm mt-1">{userName}</p>}
        </div>
        <form onSubmit={submit} className="p-8 space-y-4">
          {forced && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              You must change your password before you can continue. Your current password is temporary or has expired.
            </p>
          )}
          {field('currentPassword', 'Current password', current, setCurrent, 'current-password', true)}
          {field('newPassword', 'New password', next, setNext, 'new-password')}
          {field('confirmPassword', 'Confirm new password', confirm, setConfirm, 'new-password')}
          {problems.length > 0 && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {problems.length === 1 ? problems[0] : <ul className="list-disc ps-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
            </div>
          )}
          <button type="submit" disabled={busy} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition-colors">
            {busy ? 'Changing...' : 'Change password'}
          </button>
          {forced
            ? onSignOut && <button type="button" onClick={onSignOut} className="w-full text-slate-500 hover:text-red-600 text-sm font-medium py-2 flex items-center justify-center gap-2"><LogOut className="w-4 h-4" /> Sign out</button>
            : onCancel && <button type="button" onClick={onCancel} className="w-full text-slate-500 hover:text-slate-700 text-sm font-medium py-2">Cancel</button>}
        </form>
      </div>
    </div>
  );
}
