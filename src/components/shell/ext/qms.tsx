import { lazy } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Qms = lazy(() => import('../../Qms').then(m => ({ default: m.Qms })));

/** Deviations, CAPA, change control and audit findings (r2-qms, roadmap M27). #/qms/<record id> opens a record. */
const qms: ShellExtension = {
  id: 'qms',
  label: 'Quality Management',
  section: 'Quality Assurance',
  icon: ClipboardCheck,
  order: 25,
  render: ({ token, user, route }) => <Qms token={token} user={user} recordId={route.segments[0]} />,
};
export default qms;
