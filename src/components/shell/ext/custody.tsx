import { lazy } from 'react';
import { Boxes } from 'lucide-react';
import type { ShellExtension } from '../registry';

// r3-search-perf (M43): fetched when the page is first opened (App.tsx wraps every page in Suspense).
const CustodyScreen = lazy(() => import('../../Custody').then(m => ({ default: m.CustodyScreen })));

/** Sample custody (r2-custody-labels, roadmap M29): storage locations, the retain register, the ledger check. #/custody/samples/<id> opens a sample's custody. */
const custody: ShellExtension = {
  id: 'custody',
  label: 'Sample Custody',
  section: 'Laboratory Controls',
  icon: Boxes,
  order: 15,
  render: ({ token, user, route }) => <CustodyScreen token={token} user={user} segments={route.segments} />,
};
export default custody;
