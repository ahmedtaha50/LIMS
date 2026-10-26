import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { ApiError, errorMessage, lastServerContact, lockSession, refreshMe, useSessionState } from '../lib/api';
import { ReauthModal } from './ReauthModal';
import { useToast } from './ui/Toast';

/**
 * The idle lock (21 CFR 11.10(d), Annex 11 clause 12). The timer counts the user's own activity (keys, pointer, touch, scroll), takes its
 * length from the session policy in GET /auth/me, warns for the last 60 seconds and then locks the screen with the re-authentication dialog.
 * The page underneath stays mounted and is made inert, so a half-typed form survives the lock.
 *
 * The server measures idleness by requests, not by mouse movement, so while the user is active the guard sends GET /auth/me now and then
 * (at most once a minute) to keep the server's clock in step with the user's. It never does so when the user is idle or the screen is
 * locked, so an abandoned session still runs out, on the server too.
 */

export const WARNING_SECONDS = 60;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/** Where the idle timer stands. Pure, so it can be tested without a clock or a browser. */
export function idlePhase({ now, lastActivity, timeoutMs, warnMs = WARNING_SECONDS * 1000 }: {
  now: number; lastActivity: number; timeoutMs: number; warnMs?: number;
}): { phase: 'active' | 'warning' | 'locked'; secondsLeft: number } {
  const left = lastActivity + timeoutMs - now;
  return {
    phase: left <= 0 ? 'locked' : left <= warnMs ? 'warning' : 'active',
    secondsLeft: Math.max(0, Math.ceil(left / 1000)),
  };
}

export function IdleWarning({ secondsLeft, onStay, onSignOut }: { secondsLeft: number; onStay: () => void; onSignOut: () => void }) {
  // The button takes the focus; the field the user was typing in gets it back when the warning closes.
  useEffect(() => {
    const before = document.activeElement;
    return () => { if (before instanceof HTMLElement) before.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-slate-900/40">
      <div role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-body" className="w-full max-w-sm bg-white rounded-xl shadow-2xl border border-amber-200 p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-3">
          <Timer className="w-6 h-6" />
        </div>
        <h2 id="idle-title" className="text-lg font-bold text-slate-900">Still there?</h2>
        <p id="idle-body" className="mt-2 text-sm text-slate-600">
          This screen locks after a period of inactivity. It will lock in <span className="font-mono font-bold text-slate-900">{secondsLeft}</span> seconds, and you will be asked for your password. What you have typed stays on the page.
        </p>
        <button type="button" autoFocus onClick={onStay} className="mt-5 w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors">
          Stay signed in
        </button>
        <button type="button" onClick={onSignOut} className="mt-2 w-full text-slate-500 hover:text-red-600 text-sm font-medium py-2">
          Sign out
        </button>
      </div>
    </div>
  );
}

export function SessionGuard({ children, onSignOut }: { children: React.ReactNode; onSignOut: () => void }) {
  const s = useSessionState();
  const { toast } = useToast();
  const timeoutMs = Math.max(1, s.session?.idleTimeoutMinutes ?? 15) * 60_000;
  const active = s.status === 'active';
  const locked = s.status === 'locked';

  const lastActivity = useRef(Date.now());
  const pinging = useRef(false);
  const pingFailed = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // A new session, or an unlock, starts the idle period again.
  useEffect(() => {
    if (active) { lastActivity.current = Date.now(); setNow(Date.now()); }
  }, [active]);

  const ping = useCallback(() => {
    if (pinging.current) return;
    pinging.current = true;
    refreshMe()
      .then(() => { pingFailed.current = false; })
      .catch(err => {
        // A session that ended or went idle is handled by the API layer (lock screen, expired state). What is left is the server not answering.
        if (err instanceof ApiError && err.code === 'NETWORK_ERROR' && !pingFailed.current) {
          pingFailed.current = true;
          toast.error(errorMessage(err));
        }
      })
      .finally(() => { pinging.current = false; });
  }, [toast]);

  // The user's activity. Once the warning has started only the button counts: a mouse nudge must not hide it.
  useEffect(() => {
    if (!active) return;
    const pingEveryMs = Math.min(60_000, timeoutMs / 4);
    const onActivity = () => {
      const t = Date.now();
      if (t - lastActivity.current < 1000) return;
      if (idlePhase({ now: t, lastActivity: lastActivity.current, timeoutMs }).phase !== 'active') return;
      lastActivity.current = t;
      if (t - lastServerContact() >= pingEveryMs) ping();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true, capture: true });
    return () => { for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true } as EventListenerOptions); };
  }, [active, timeoutMs, ping]);

  // The clock. It looks at the real time at every tick (and when the window becomes visible again), so a laptop that slept past the
  // deadline locks the moment it wakes, however late the timer fires.
  useEffect(() => {
    if (!active) return;
    const check = () => {
      const t = Date.now();
      setNow(t);
      if (idlePhase({ now: t, lastActivity: lastActivity.current, timeoutMs }).phase === 'locked') lockSession('idle');
    };
    const id = window.setInterval(check, 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [active, timeoutMs]);

  const stay = () => {
    lastActivity.current = Date.now();
    setNow(Date.now());
    ping();
  };

  const phase = active ? idlePhase({ now, lastActivity: lastActivity.current, timeoutMs }) : null;

  return (
    <>
      <div className="contents" inert={locked} aria-hidden={locked || undefined}>{children}</div>
      {phase?.phase === 'warning' && <IdleWarning secondsLeft={phase.secondsLeft} onStay={stay} onSignOut={onSignOut} />}
      {locked && <ReauthModal reason={s.lockReason ?? 'idle'} onSignOut={onSignOut} />}
    </>
  );
}
