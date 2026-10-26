import React, { Suspense, lazy, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { ToastProvider, useToast } from './components/ui/Toast';
import { ErrorBoundary, SessionExpiredPanel } from './components/ui/ErrorBoundary';
import { Login } from './components/Login';
import { Layout, VIEW_TITLES, navLabel } from './components/Layout';
import { t, useLang } from './i18n';
import { SessionGuard } from './components/SessionGuard';
import { ChangePassword } from './components/ChangePassword';

import { extensionFor } from './components/shell/registry';
import { useScanToOpen } from './lib/useScanSink';
import { bootSession, endSession, signOut, startSession, useSessionState, type SelfUser } from './lib/api';
import { formatHash, navigate, useRoute, type Route } from './lib/router';

// ---- code splitting (roadmap M43) -----------------------------------------------------------------------------------------------
// Every screen is a chunk of its own, fetched when the user first opens it: the first load carries the shell, the sign-in and the
// screen the address names, not the fourteen screens (and the PDF, chart and scanner libraries behind them). The chunks are part of the
// installer, so this works offline. A chunk that cannot be fetched (the server was updated and the old file is gone, the network
// dropped) must not be a white page: ChunkBoundary says so and offers Retry, which fetches it again.

interface Screen<P> { get: () => LazyExoticComponent<ComponentType<P>>; reset: () => void }

function screen<P>(load: () => Promise<{ default: ComponentType<P> }>): Screen<P> {
  let component = lazy(load);
  // React.lazy remembers a rejected import for good; a new lazy() is what makes Retry fetch the chunk again.
  return { get: () => component, reset: () => { component = lazy(load); } };
}
const named = <M, K extends keyof M>(load: () => Promise<M>, key: K) => () => load().then(m => ({ default: m[key] as unknown as ComponentType<any> }));

const SCREENS = {
  dashboard: screen(named(() => import('./components/Dashboard'), 'Dashboard')),
  samples: screen(named(() => import('./components/Samples'), 'Samples')),
  eln: screen(named(() => import('./components/ELN'), 'ELN')),
  traceability: screen(named(() => import('./components/Traceability'), 'Traceability')),
  oos: screen(named(() => import('./components/OOSInvestigations'), 'OOSInvestigations')),
  stability: screen(named(() => import('./components/StabilityStudies'), 'StabilityStudies')),
  environmental: screen(named(() => import('./components/Environmental'), 'Environmental')),
  instruments: screen(named(() => import('./components/Instruments'), 'Instruments')),
  reagents: screen(named(() => import('./components/Reagents'), 'Reagents')),
  specs: screen(named(() => import('./components/Specifications'), 'Specifications')),
  training: screen(named(() => import('./components/Training'), 'Training')),
  audit: screen(named(() => import('./components/AuditTrail'), 'AuditTrail')),
  admin: screen(named(() => import('./components/AdminPanel'), 'AdminPanel')),
  reports: screen(named(() => import('./components/Reports'), 'Reports')),
} satisfies Record<string, Screen<any>>;

const isChunkError = (e: Error) => /dynamically imported module|Importing a module script failed|Failed to fetch|Loading chunk|ChunkLoadError|error loading dynamically/i.test(`${e.name} ${e.message}`);

/** Catches a failed chunk fetch only; any other error goes on to the ErrorBoundary around it. */
class ChunkBoundary extends React.Component<{ children?: React.ReactNode; view: string; onRetry: () => void }, { error: Error | null }> {
  declare props: Readonly<{ children?: React.ReactNode; view: string; onRetry: () => void }>;
  declare setState: (state: { error: Error | null }) => void;
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { view: string }) { if (this.state.error && prev.view !== this.props.view) this.setState({ error: null }); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!isChunkError(error)) throw error;
    return (
      <div role="alert" className="max-w-xl mx-auto mt-16 bg-white border border-red-200 rounded-xl shadow-sm p-8 text-center">
        <h3 className="text-xl font-bold text-slate-900">{t('app.chunkTitle')}</h3>
        <p className="mt-2 text-sm text-slate-600">{t('app.chunkBody')}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" onClick={() => { this.props.onRetry(); this.setState({ error: null }); }} className="bg-slate-800 hover:bg-slate-900 text-white font-medium px-5 py-2.5 rounded-lg transition-colors">{t('app.retry')}</button>
          <button type="button" onClick={() => window.location.reload()} className="border border-slate-300 hover:bg-slate-50 text-slate-800 font-medium px-5 py-2.5 rounded-lg transition-colors">{t('app.reload')}</button>
        </div>
      </div>
    );
  }
}

function LoadingScreen() {
  return <div role="status" className="p-6 text-sm text-slate-500">{t('app.loading')}</div>;
}

/** The screen shown for an empty address (#/ or nothing). */
export const HOME_VIEW = 'samples';

/** The page for a route. `token` is the session's handle for the views (it does not change at an unlock; see lib/api.ts). */
function renderView(route: Route, token: string, user: SelfUser, onNavigate: (view: string) => void) {
  const view = route.view as keyof typeof SCREENS;
  if (Object.prototype.hasOwnProperty.call(SCREENS, view)) {
    const Screen = SCREENS[view].get() as ComponentType<any>;
    switch (view) {
      case 'dashboard': return <Screen token={token} onNavigate={onNavigate} />;
      case 'samples': return <Screen token={token} user={user} sampleId={route.segments[0] ?? null} />;
      case 'audit': return <Screen token={token} />;
      case 'reports': return <Screen token={token} />;
      default: return <Screen token={token} user={user} />;
    }
  }
  const ext = extensionFor(route.view);
  if (ext) return ext.render({ token, user, route });
  return <UnknownPage view={route.view} onHome={() => onNavigate(HOME_VIEW)} />;
}

function UnknownPage({ view, onHome }: { view: string; onHome: () => void }) {
  return (
    <div role="alert" className="p-6 rounded-xl border border-amber-300 bg-amber-50 text-amber-900">
      <p className="font-semibold">{t('app.noPage', { view })}</p>
      <p className="text-sm mt-1">{t('app.noPageHelp')}</p>
      <button type="button" onClick={onHome} className="mt-3 px-4 py-2 rounded-lg border border-amber-400 bg-white text-sm font-medium hover:bg-amber-100">{t('app.openHome', { title: navLabel(HOME_VIEW, VIEW_TITLES[HOME_VIEW]) })}</button>
    </div>
  );
}

/** The wedge-scanner sink, mounted once in the signed-in shell (r2-custody-labels, M29). */
function ScanToOpen() {
  const { toast } = useToast();
  useScanToOpen(toast);
  return null;
}

type PaletteModule = typeof import('./components/CommandPalette');

/** Ctrl+K (Cmd+K on a Mac) opens the global search anywhere in the signed-in shell (roadmap M43). The palette is its own chunk, fetched on first use. */
function PaletteHost({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mod, setMod] = useState<PaletteModule | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault(); // the browser's own Ctrl+K moves focus to its search box
        setOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open || mod) return;
    let cancelled = false;
    import('./components/CommandPalette').then(m => { if (!cancelled) setMod(m); }, () => {
      if (!cancelled) { setOpen(false); toast.error(t('app.paletteFailed')); }
    });
    return () => { cancelled = true; };
  }, [open, mod, toast]);
  if (!mod) return null;
  return <mod.CommandPalette open={open} onClose={() => setOpen(false)} onNavigate={hash => { setOpen(false); onNavigate(hash); }} />;
}

function Shell() {
  useLang(); // every screen below re-renders when the language changes
  const s = useSessionState();
  const { toast } = useToast();
  const route = useRoute();
  // The address is the state (src/lib/router.ts): a pasted #/samples/SMP-2026-00001 opens that sample, and Back and reload keep the view.
  const view = route.view || HOME_VIEW;
  const goTo = useCallback((id: string) => navigate(formatHash(id)), []);

  // Who is signed in is asked of the server (GET /auth/me), never decoded from the token. Called twice in strict mode; it boots once.
  useEffect(() => { void bootSession(); }, []);

  const handleSignOut = useCallback(async () => {
    const failure = await signOut();
    if (failure) toast.error(t('app.signOutFailed', { reason: failure.message }));
    else toast.success(t('app.signedOut'));
  }, [toast]);

  if (s.status === 'booting') {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-600" role="status">{t('app.checkingSession')}</div>;
  }

  if (s.status === 'signed-out') return <Login onLogin={startSession} notice={s.notice} />;

  // 'locked' before the first answer of /auth/me (the page was reloaded after the idle limit): nothing to show behind the lock screen yet.
  if (!s.user) return <SessionGuard onSignOut={handleSignOut}><div className="min-h-screen bg-slate-50" /></SessionGuard>;

  const user = s.user;

  if (s.mustChangePassword && s.status !== 'expired') {
    return (
      <SessionGuard onSignOut={handleSignOut}>
        <ChangePassword forced userName={user.name} onChanged={() => goTo(HOME_VIEW)} onSignOut={handleSignOut} />
      </SessionGuard>
    );
  }

  const ended = s.status === 'expired';
  return (
    <SessionGuard onSignOut={handleSignOut}>
      {/* r2-custody-labels (roadmap M29): a wedge scan anywhere opens the record it names. */}
      {!ended && <ScanToOpen />}
      {!ended && <PaletteHost onNavigate={navigate} />}
      <Layout user={user} currentView={view} onNavigate={goTo} onLogout={handleSignOut}>
        {ended
          ? <SessionExpiredPanel message={s.notice} onSignIn={() => endSession()} />
          : (
            <ErrorBoundary resetKey={view}>
              <ChunkBoundary view={view} onRetry={() => { const known = (SCREENS as Record<string, Screen<any> | undefined>)[view]; if (known) known.reset(); else window.location.reload(); }}>
                <Suspense fallback={<LoadingScreen />}>{renderView({ ...route, view }, s.viewToken ?? '', user, goTo)}</Suspense>
              </ChunkBoundary>
            </ErrorBoundary>
          )}
      </Layout>
    </SessionGuard>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
