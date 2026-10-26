import React from 'react';
import { AlertTriangle, LogIn, RefreshCw } from 'lucide-react';
import { endSession, useSessionState } from '../../lib/api';

/**
 * A view that throws while rendering used to take the whole application down to a white page (Dashboard and Reagents did it whenever the
 * server answered with an error object where they expected a list). The boundary keeps the shell, says what happened and offers a retry;
 * if the cause is a session that has ended, it shows the "Session expired" state instead of a crash page.
 */

export function SessionExpiredPanel({ message, onSignIn }: { message?: string | null; onSignIn: () => void }) {
  return (
    <div role="alert" className="max-w-xl mx-auto mt-16 bg-white border border-amber-200 rounded-xl shadow-sm p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-4">
        <LogIn className="w-6 h-6" />
      </div>
      <h3 className="text-xl font-bold text-slate-900">Session expired</h3>
      <p className="mt-2 text-sm text-slate-600">{message || 'Your session has ended.'}</p>
      <p className="mt-1 text-sm text-slate-500">Anything typed on this page after the session ended was not saved. Nothing was changed on the server by the request that failed.</p>
      <button type="button" onClick={onSignIn} className="mt-6 bg-blue-600 hover:bg-blue-700 text-white font-medium px-5 py-2.5 rounded-lg transition-colors">
        Sign in again
      </button>
    </div>
  );
}

export function ViewFailure({ error, sessionEnded, sessionMessage, onRetry, onSignIn, fullPage = false }: {
  error: Error;
  sessionEnded: boolean;
  sessionMessage?: string | null;
  onRetry: () => void;
  onSignIn: () => void;
  fullPage?: boolean;
}) {
  if (sessionEnded) {
    return fullPage
      ? <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4"><SessionExpiredPanel message={sessionMessage} onSignIn={onSignIn} /></div>
      : <SessionExpiredPanel message={sessionMessage} onSignIn={onSignIn} />;
  }
  const body = (
    <div role="alert" className="max-w-xl mx-auto mt-16 bg-white border border-red-200 rounded-xl shadow-sm p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-4">
        <AlertTriangle className="w-6 h-6" />
      </div>
      <h3 className="text-xl font-bold text-slate-900">{fullPage ? 'The application hit an unexpected error' : 'This page could not be displayed'}</h3>
      <p className="mt-2 text-sm text-slate-600">
        {fullPage
          ? 'Nothing was lost on the server. Reload to continue; if it happens again, tell an administrator what you were doing.'
          : 'The rest of the application still works. Try again, or open another page. If it keeps happening, tell an administrator what you were doing.'}
      </p>
      <details className="mt-3 text-xs text-slate-500">
        <summary className="cursor-pointer">Technical details</summary>
        <p className="mt-1 font-mono break-words">{error.message || String(error)}</p>
      </details>
      <button type="button" onClick={onRetry} className="mt-6 bg-slate-800 hover:bg-slate-900 text-white font-medium px-5 py-2.5 rounded-lg transition-colors inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4" /> {fullPage ? 'Reload' : 'Try again'}
      </button>
    </div>
  );
  return fullPage ? <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">{body}</div> : body;
}

function Fallback({ error, fullPage, onRetry }: { error: Error; fullPage: boolean; onRetry: () => void }) {
  const s = useSessionState();
  return (
    <ViewFailure
      error={error}
      fullPage={fullPage}
      sessionEnded={s.status === 'expired'}
      sessionMessage={s.notice}
      onRetry={fullPage ? () => window.location.reload() : onRetry}
      onSignIn={() => endSession()}
    />
  );
}

interface Props {
  children?: React.ReactNode;
  /** When this value changes (the user opened another page) a failed view is given a fresh start. */
  resetKey?: unknown;
  /** The outermost boundary: a full-page fallback with a Reload button. */
  fullPage?: boolean;
}

type BoundaryState = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, BoundaryState> {
  // The project has no @types/react, so the members of React.Component are not known to the compiler; they are declared here (nothing is emitted).
  declare props: Readonly<Props>;
  declare setState: (state: BoundaryState) => void;
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // There is no client log route yet; the console is where an administrator with the developer tools open can find the cause.
    console.error('A view failed to render:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <Fallback error={this.state.error} fullPage={this.props.fullPage === true} onRetry={() => this.setState({ error: null })} />;
  }
}
