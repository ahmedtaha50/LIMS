import React, { useEffect, useRef, useState } from 'react';
import { Database, ShieldCheck, Shield, FileCheck, ClipboardList, LogOut, ShieldAlert, ThermometerSun, Wind, Microscope, FlaskConical, BookOpenCheck, Book, GitMerge, FileText, GraduationCap, Menu, Hand } from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { IconButton } from './ui/Button';
import { Modal } from './ui/Modal';
import { NAV_SECTION_TITLES, SHELL_EXTENSIONS } from './shell/registry';
import { useDensity } from './shell/density';
import { t, useLang, type MessageKey } from '../i18n';
import { LanguageSwitch } from '../i18n/LanguageSwitch';
import { syncPreferencesAfterSignIn } from '../i18n/preferences';
import { useToast } from './ui/Toast';

type NavItem = { id: string; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean; order?: number };

const BUILT_IN: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard & Metrics', icon: Database },
      { id: 'samples', label: 'Samples & Testing', icon: ClipboardList },
      { id: 'eln', label: 'Lab Notebook (ELN)', icon: Book },
      { id: 'traceability', label: 'Batch Traceability', icon: GitMerge },
    ],
  },
  {
    title: 'Quality Assurance',
    items: [
      { id: 'oos', label: 'OOS Investigations', icon: ShieldAlert },
      { id: 'stability', label: 'Stability Studies', icon: ThermometerSun },
      { id: 'environmental', label: 'Env Monitoring', icon: Wind },
      { id: 'specs', label: 'Test Specifications', icon: BookOpenCheck },
    ],
  },
  {
    title: 'Laboratory Controls',
    items: [
      { id: 'instruments', label: 'Equipment & Calibration', icon: Microscope },
      { id: 'reagents', label: 'Reagents & Standards', icon: FlaskConical },
      { id: 'training', label: 'SOP Training Matrix', icon: GraduationCap },
    ],
  },
  {
    title: 'Regulatory & Governance',
    items: [
      { id: 'audit', label: 'Audit Trail (Part 11)', icon: ShieldCheck },
      { id: 'reports', label: 'COA & Quality Dossiers', icon: FileText },
      { id: 'admin', label: 'System Admin', icon: Shield, adminOnly: true },
    ],
  },
];

/**
 * The navigation: the built-in screens plus every shell extension (src/components/shell/ext/*), placed by its section and order.
 * `adminOnly` entries are shown to an Admin only (the server decides what the role may do; this only decides what to show).
 */
export const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = NAV_SECTION_TITLES.map(title => {
  const builtIn = (BUILT_IN.find(s => s.title === title)?.items ?? []).map((item, i) => ({ ...item, order: (i + 1) * 10 }));
  const extra = SHELL_EXTENSIONS.filter(e => e.section === title).map(e => ({ id: e.id, label: e.label, icon: e.icon, adminOnly: e.adminOnly, order: e.order ?? 1000 }));
  return { title, items: [...builtIn, ...extra].sort((a, b) => a.order - b.order) };
});

/** The page title for each view id (the header used to print the raw id: "specs", "oos", "eln"). English: the catalogue's text is navLabel(). */
export const VIEW_TITLES: Record<string, string> = Object.fromEntries(NAV_SECTIONS.flatMap(s => s.items.map(i => [i.id, i.label])));

/** The label of a screen in the language in force; an extension screen without a catalogue entry keeps its own (English) label. */
export function navLabel(id: string, fallback: string): string {
  const key = `nav.item.${id.replace(/-/g, '_')}` as MessageKey;
  const text = t(key);
  return text === key ? fallback : text;
}
const SECTION_KEYS: Record<string, MessageKey> = {
  'Operations': 'nav.section.operations', 'Quality Assurance': 'nav.section.qualityAssurance',
  'Laboratory Controls': 'nav.section.laboratoryControls', 'Regulatory & Governance': 'nav.section.regulatoryGovernance',
};
export const sectionLabel = (title: string): string => (SECTION_KEYS[title] ? t(SECTION_KEYS[title]) : title);

interface LayoutProps {
  user: any;
  currentView: string;
  onNavigate: (view: string) => void;
  /** Signs out: the owner of the session (App) tells the server, ends the session and says so if the server could not be told. */
  onLogout: () => void;
  children: React.ReactNode;
}

function NavList({ sections, currentView, onNavigate }: { sections: typeof NAV_SECTIONS; currentView: string; onNavigate: (id: string) => void }) {
  return (
    <>
      {sections.map(sec => (
        <div key={sec.title} className="space-y-1" role="group" aria-labelledby={`nav-${sec.title.replace(/\W+/g, '-')}`}>
          <div id={`nav-${sec.title.replace(/\W+/g, '-')}`} className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-3 mb-1 font-mono">
            {sectionLabel(sec.title)}
          </div>
          {sec.items.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={currentView === item.id ? 'page' : undefined}
              className={`ui-control w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${
                currentView === item.id
                  ? 'bg-blue-600/20 text-blue-200 font-semibold border-s-2 border-blue-400 rounded-s-none'
                  : 'hover:bg-slate-800/80 hover:text-white text-slate-300'
              }`}
            >
              <item.icon className={`w-4 h-4 shrink-0 ${currentView === item.id ? 'text-blue-300' : 'text-slate-400'}`} />
              <span className="truncate">{navLabel(item.id, item.label)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

export function Layout({ user, currentView, onNavigate, onLogout, children }: LayoutProps) {
  useLang();
  const { toast } = useToast();
  // Once per sign-in: the server's language choice replaces this computer's (the desktop build's storage is empty at every launch).
  useEffect(() => {
    void syncPreferencesAfterSignIn().then(r => { if (!r.ok) toast.error(t('lang.saveFailed')); });
  }, [user.id]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [density, setDensity] = useDensity();
  const main = useRef<HTMLElement | null>(null);


  const navSections = NAV_SECTIONS
    .map(sec => ({ ...sec, items: sec.items.filter(i => !i.adminOnly || user.role === 'Admin') }))
    .filter(sec => sec.items.length > 0);

  const go = (id: string) => { setDrawerOpen(false); onNavigate(id); };
  const skipToMain = (e: any) => { e.preventDefault(); main.current?.focus(); }; // not a hash change: the hash is the router's

  const identity = (
    <div className="mt-4 pt-4 border-t border-slate-800 flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-blue-900/50 flex items-center justify-center text-blue-200 font-bold border border-blue-700/50" aria-hidden="true">
        {Array.from(String(user.name ?? ''))[0] ?? '?'}
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="text-sm font-medium text-slate-100 truncate">{user.name}</div>
        <div className="text-xs text-blue-200 font-mono truncate">{user.role}</div>
      </div>
    </div>
  );
  const signOut = (
    <div className="p-4 border-t border-slate-800">
      <button
        type="button"
        onClick={onLogout}
        className="ui-control w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-red-300 hover:bg-slate-800 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
      >
        <LogOut className="w-4 h-4" aria-hidden="true" />
        {t('layout.signOut')}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <a href="#main" onClick={skipToMain} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-[70] focus:bg-white focus:text-blue-800 focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg">{t('layout.skip')}</a>

      {/* Sidebar: always shown from the lg breakpoint; below it, the same navigation opens as a drawer from the header. */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-slate-900 text-slate-300 flex-col shadow-2xl z-10">
        <div className="p-6 bg-slate-950/50">
          <div className="flex items-center gap-3 text-white font-bold text-xl tracking-tight">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20" aria-hidden="true">
              <FileCheck className="w-5 h-5" />
            </div>
            <div>
              <span className="text-white">Bpharma</span>
              <span className="text-blue-300 ms-1 text-sm font-semibold">LIMS</span>
            </div>
          </div>
          {identity}
        </div>
        <nav aria-label={t('layout.main')} className="flex-1 py-4 px-3 space-y-4 overflow-y-auto">
          <NavList sections={navSections} currentView={currentView} onNavigate={go} />
        </nav>
        {signOut}
      </aside>

      <Modal open={drawerOpen} title="Bpharma LIMS" variant="drawer" onClose={() => setDrawerOpen(false)}>
        <div className="-mx-6 -mt-4 px-6 pb-2">{identity}</div>
        <nav aria-label={t('layout.mainNavigation')} className="py-4 space-y-4">
          <NavList sections={navSections} currentView={currentView} onNavigate={go} />
        </nav>
        <div className="-mx-6">{signOut}</div>
      </Modal>

      {/* Main Content */}
      <main ref={main} id="main" tabIndex={-1} aria-labelledby="page-title" className="flex-1 min-w-0 flex flex-col max-h-screen overflow-hidden outline-none">
        <header className="bg-white border-b border-slate-200 h-16 flex items-center gap-3 px-4 lg:px-8 shadow-xs">
          <IconButton label={t('layout.openNavigation')} icon={<Menu className="w-5 h-5" />} onClick={() => setDrawerOpen(true)} className="lg:hidden" aria-expanded={drawerOpen} />
          <h2 id="page-title" className="flex-1 min-w-0 truncate text-lg font-bold text-slate-800 tracking-tight">{navLabel(currentView, VIEW_TITLES[currentView] ?? currentView)}</h2>
          <LanguageSwitch signedIn />
          {/* Persistent notifications, pushed over an authenticated socket (r2-events, roadmap M23). */}
          <NotificationBell />
          <button
            type="button"
            aria-pressed={density === 'bench'}
            onClick={() => setDensity(density === 'bench' ? 'normal' : 'bench')}
            title={t('layout.benchModeHint')}
            className="ui-control inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 aria-pressed:bg-blue-50 aria-pressed:border-blue-400 aria-pressed:text-blue-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            <Hand className="w-4 h-4" aria-hidden="true" /> {t('layout.benchMode')}
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 bg-slate-50/60">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
