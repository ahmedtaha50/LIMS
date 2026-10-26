import { lazy } from 'react';
import { ListChecks } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Worklists = lazy(() => import('../../Worklists').then(m => ({ default: m.Worklists })));

/** Worklists and batch runs (r2-worklists, roadmap M33). #/worklists lists them; #/worklists/<WL-id> opens one run. */
const worklists: ShellExtension = {
  id: 'worklists',
  label: 'Worklists',
  section: 'Operations',
  icon: ListChecks,
  order: 25,
  render: ({ user, route }) => <Worklists user={user} recordId={route.segments[0] ?? null} />,
};
export default worklists;
