import { lazy } from 'react';
import { LineChart } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const Trending = lazy(() => import('../../Trending').then(m => ({ default: m.Trending })));

/** SPC control charts, out-of-trend alerts and stability shelf-life estimates (r3-spc, roadmap M39). Advisory; the server checks every permission. */
const trending: ShellExtension = {
  id: 'trending',
  label: 'Trending',
  section: 'Laboratory Controls',
  icon: LineChart,
  order: 80,
  render: ({ token, user }) => <Trending token={token} user={user} />,
};
export default trending;
