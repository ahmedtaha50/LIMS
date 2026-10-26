import { lazy } from 'react';
import { Boxes } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const MasterData = lazy(() => import('../../MasterData').then(m => ({ default: m.MasterData })));

/** Products, batches and customers (r2-master-data, roadmap M17). The screen asks the server what the user may change. */
const masterData: ShellExtension = {
  id: 'master-data',
  label: 'Master Data',
  section: 'Operations',
  icon: Boxes,
  order: 45,
  render: ({ token, user }) => <MasterData token={token} user={user} />,
};
export default masterData;
